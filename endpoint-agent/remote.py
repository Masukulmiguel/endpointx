"""EndpointX remote access - screen sharing and input control for assistance.

The agent opens an outbound WebSocket to the server (same origin as the
heartbeat, TLS via wss://) and only starts capturing the screen when an
operator is watching. Because the connection is always agent-initiated no
port has to be opened on the endpoint, which is what makes a single install
enough to get remote assistance later.

Messages
    agent -> server : binary JPEG frames, or JSON control traffic
    server -> agent : JSON {t: start|stop|mouse|wheel|key|type, ...}
"""

from __future__ import annotations

import hashlib
import importlib
import io
import json
import logging
import subprocess
import sys
import threading
import time
from typing import Any, Optional

logger = logging.getLogger("endpointx-agent.remote")

# module -> pip package
REQUIRED_DEPS = {"websocket": "websocket-client", "mss": "mss", "PIL": "Pillow"}
OPTIONAL_DEPS = {"pyautogui": "pyautogui"}

# Browser KeyboardEvent.code -> pyautogui key name
KEY_MAP = {
    "Enter": "enter",
    "Escape": "esc",
    "Backspace": "backspace",
    "Tab": "tab",
    "Delete": "delete",
    "Insert": "insert",
    "Home": "home",
    "End": "end",
    "PageUp": "pageup",
    "PageDown": "pagedown",
    "ArrowUp": "up",
    "ArrowDown": "down",
    "ArrowLeft": "left",
    "ArrowRight": "right",
    "Space": "space",
    "CapsLock": "capslock",
    "ShiftLeft": "shift",
    "ShiftRight": "shift",
    "ControlLeft": "ctrl",
    "ControlRight": "ctrl",
    "AltLeft": "alt",
    "AltRight": "alt",
    "MetaLeft": "win",
    "MetaRight": "win",
    "ContextMenu": "apps",
    "Minus": "-",
    "Equal": "=",
    "BracketLeft": "[",
    "BracketRight": "]",
    "Backslash": "\\",
    "Semicolon": ";",
    "Quote": "'",
    "Comma": ",",
    "Period": ".",
    "Slash": "/",
    "Backquote": "`",
}

for _i in range(10):
    KEY_MAP[f"Digit{_i}"] = str(_i)
for _c in "abcdefghijklmnopqrstuvwxyz":
    KEY_MAP[f"Key{_c.upper()}"] = _c


def _has_module(name: str) -> bool:
    try:
        importlib.import_module(name)
        return True
    except Exception:
        return False


def ensure_dependencies() -> tuple[bool, list[str]]:
    """Install whatever is missing so remote assistance can start.

    Existing installations are updated in the background the first time a
    remote session is requested, instead of requiring a reinstall.
    """
    missing = [pkg for mod, pkg in REQUIRED_DEPS.items() if not _has_module(mod)]
    if not missing:
        return True, []
    logger.info("Installing remote access dependencies: %s", ", ".join(missing))
    try:
        subprocess.run(
            [sys.executable, "-m", "pip", "install", "--disable-pip-version-check", "-q", *missing],
            check=True,
            timeout=600,
        )
    except Exception as exc:
        logger.warning("Could not install remote dependencies: %s", exc)
        return False, missing
    importlib.invalidate_caches()
    still_missing = [pkg for mod, pkg in REQUIRED_DEPS.items() if not _has_module(mod)]
    if not still_missing:
        logger.info("Remote access dependencies ready")
    return not still_missing, still_missing


def _clamp(value: Any, low: int, high: int, default: int) -> int:
    try:
        return max(low, min(high, int(value)))
    except (TypeError, ValueError):
        return default


class RemoteAccess:
    """Persistent control channel to the EndpointX server."""

    def __init__(self, server_url: str, agent_id: str, agent_secret: str, stop_event: threading.Event) -> None:
        self.server_url = server_url
        self.agent_id = agent_id
        self.agent_secret = agent_secret
        self.stop_event = stop_event
        self._ws: Any = None
        self._send_lock = threading.Lock()
        self._streaming = False
        self._stream_thread: Optional[threading.Thread] = None
        self._stream_lock = threading.Lock()
        self._binary_opcode = 0x2
        self._connected = False
        self._active_rect: Optional[dict[str, int]] = None

    # -- lifecycle ---------------------------------------------------------

    def start(self) -> None:
        thread = threading.Thread(target=self._run, name="remote-access", daemon=True)
        thread.start()

    def stop(self) -> None:
        self._streaming = False
        ws, self._ws = self._ws, None
        if ws is not None:
            try:
                ws.close()
            except Exception:
                pass

    # -- connection --------------------------------------------------------

    def _ws_url(self) -> str:
        base = (self.server_url or "").rstrip("/")
        if base.endswith("/api"):
            base = base[: -len("/api")]
        if base.startswith("https://"):
            return "wss://" + base[len("https://") :] + "/remote"
        if base.startswith("http://"):
            return "ws://" + base[len("http://") :] + "/remote"
        return "ws://" + base + "/remote"

    def _run(self) -> None:
        deps_ready = False
        backoff = 5
        while not self.stop_event.is_set():
            if not deps_ready:
                deps_ready, _ = ensure_dependencies()
                if not deps_ready:
                    self.stop_event.wait(600)
                    continue
            if not self.agent_id or self.agent_id == "AUTO":
                self.stop_event.wait(30)
                continue
            try:
                from websocket import ABNF, WebSocketApp
            except Exception as exc:
                logger.warning("remote access unavailable: %s", exc)
                self.stop_event.wait(600)
                continue
            self._binary_opcode = ABNF.OPCODE_BINARY
            self._connected = False

            try:
                ws = WebSocketApp(
                    self._ws_url(),
                    on_open=self._on_open,
                    on_message=self._on_message,
                    on_error=self._on_error,
                    on_close=self._on_close,
                )
                self._ws = ws
                ws.run_forever(ping_interval=30, ping_timeout=10, suppress_origin=True)
            except Exception as exc:
                logger.debug("remote socket error: %s", exc)
            finally:
                self._streaming = False
                self._ws = None

            if self.stop_event.is_set():
                break
            backoff = 5 if self._connected else min(backoff * 2, 120)
            time.sleep(backoff)

    def _on_open(self, ws: Any) -> None:
        self._connected = True
        logger.info("Remote channel connected to %s", self._ws_url())
        ws.send(
            json.dumps(
                {
                    "t": "hello",
                    "role": "agent",
                    "agent_id": self.agent_id,
                    "secret": self.agent_secret,
                }
            )
        )

    def _on_close(self, *_args: Any) -> None:
        self._streaming = False
        logger.info("Remote channel closed")

    def _on_error(self, _ws: Any, error: Any) -> None:
        logger.debug("Remote channel error: %s", error)

    def _on_message(self, _ws: Any, message: Any) -> None:
        if not isinstance(message, str):
            return
        try:
            msg = json.loads(message)
        except (json.JSONDecodeError, TypeError):
            return
        kind = msg.get("t")
        try:
            if kind == "ready":
                logger.info("Remote channel ready (role=%s)", msg.get("role"))
                if msg.get("role") == "agent":
                    self._send_monitors()
            elif kind == "start":
                self._start_stream(msg)
            elif kind == "stop":
                self._stop_stream()
            elif kind == "mouse":
                self._mouse(msg)
            elif kind == "wheel":
                self._wheel(msg)
            elif kind == "key":
                self._key(msg)
            elif kind == "type":
                self._type_text(msg)
            elif kind == "error":
                logger.warning("Remote channel rejected: %s", msg.get("message"))
        except Exception as exc:
            logger.error("Remote message %s failed: %s", kind, exc)

    # -- send --------------------------------------------------------------

    def _send(self, payload: Any, binary: bool = False) -> None:
        ws = self._ws
        if ws is None:
            return
        try:
            with self._send_lock:
                if binary:
                    ws.send(payload, opcode=self._binary_opcode)
                else:
                    ws.send(payload if isinstance(payload, str) else json.dumps(payload))
        except Exception as exc:
            logger.debug("Remote send failed: %s", exc)

    # -- video -------------------------------------------------------------

    @staticmethod
    def _monitors_payload() -> dict[str, Any]:
        """Describe the physical screens so the operator can pick exactly one."""
        try:
            import mss

            with mss.mss() as sct:
                physical = list(sct.monitors[1:])
        except Exception as exc:
            logger.debug("Monitor enumeration failed: %s", exc)
            return {"t": "monitors", "primary": 1, "monitors": []}
        monitors = [
            {
                "index": idx + 1,
                "left": int(m.get("left", 0)),
                "top": int(m.get("top", 0)),
                "width": int(m.get("width", 0)),
                "height": int(m.get("height", 0)),
            }
            for idx, m in enumerate(physical)
        ]
        return {"t": "monitors", "primary": 1, "monitors": monitors}

    def _send_monitors(self) -> None:
        payload = self._monitors_payload()
        if payload.get("monitors"):
            self._send(payload)

    @staticmethod
    def _pick_monitor(sct: Any, want: Any) -> dict[str, Any]:
        monitors = sct.monitors
        try:
            idx = int(want) if want is not None else 1
        except (TypeError, ValueError):
            idx = 1
        if idx < 1 or idx >= len(monitors):
            idx = 1 if len(monitors) > 1 else 0
        return dict(monitors[idx])

    def _start_stream(self, params: dict[str, Any]) -> None:
        with self._stream_lock:
            if self._streaming and self._stream_thread and self._stream_thread.is_alive():
                return
            self._streaming = True
            self._stream_thread = threading.Thread(
                target=self._capture_loop, args=(params,), name="remote-capture", daemon=True
            )
            self._stream_thread.start()

    def _stop_stream(self) -> None:
        self._streaming = False

    def _capture_loop(self, params: dict[str, Any]) -> None:
        try:
            import mss
            from PIL import Image
        except Exception as exc:
            self._streaming = False
            self._send({"t": "error", "message": f"capture unavailable: {exc}"})
            return

        fps = _clamp(params.get("fps"), 1, 30, 8)
        quality = _clamp(params.get("quality"), 20, 92, 65)
        max_width = _clamp(params.get("max_width"), 320, 3840, 1280)
        interval = 1.0 / fps
        frame_no = 0
        last_digest = b""

        logger.info("Remote screen sharing started (fps=%d quality=%d max_width=%d)", fps, quality, max_width)
        try:
            with mss.mss() as sct:
                monitor = self._pick_monitor(sct, params.get("monitor"))
                self._active_rect = {
                    "left": int(monitor.get("left", 0)),
                    "top": int(monitor.get("top", 0)),
                    "width": int(monitor.get("width", 0)),
                    "height": int(monitor.get("height", 0)),
                }
                size = (monitor["width"], monitor["height"])
                while self._streaming and not self.stop_event.is_set():
                    started = time.time()
                    shot = sct.grab(monitor)
                    image = Image.frombytes("RGB", shot.size, shot.rgb)
                    if image.width > max_width:
                        ratio = max_width / float(image.width)
                        image = image.resize(
                            (max(1, int(image.width * ratio)), max(1, int(image.height * ratio))),
                            Image.BILINEAR,
                        )
                    raw = image.tobytes()
                    digest = hashlib.blake2b(raw, digest_size=16).digest()
                    if digest != last_digest:
                        buffer = io.BytesIO()
                        image.save(buffer, "JPEG", quality=quality)
                        self._send(buffer.getvalue(), binary=True)
                        last_digest = digest
                        frame_no += 1
                    elapsed = time.time() - started
                    if elapsed < interval:
                        time.sleep(interval - elapsed)
        except Exception as exc:
            logger.error("Remote capture stopped: %s", exc)
            self._send({"t": "error", "message": f"capture failed: {exc}"})
        finally:
            self._streaming = False
            self._active_rect = None
            logger.info("Remote screen sharing stopped (%d frames)", frame_no)
            self._send({"t": "stopped"})

    # -- input -------------------------------------------------------------

    @staticmethod
    def _screen_size() -> tuple[int, int]:
        try:
            import pyautogui

            size = pyautogui.size()
            return int(size[0]), int(size[1])
        except Exception:
            try:
                import mss

                with mss.mss() as sct:
                    monitor = sct.monitors[1] if len(sct.monitors) > 1 else sct.monitors[0]
                    return int(monitor["width"]), int(monitor["height"])
            except Exception:
                return 1920, 1080

    @staticmethod
    def _gui() -> Any:
        import pyautogui

        pyautogui.FAILSAFE = False
        pyautogui.PAUSE = 0
        return pyautogui

    def _mouse(self, msg: dict[str, Any]) -> None:
        gui = self._gui()
        rect = self._active_rect
        if rect and rect.get("width") and rect.get("height"):
            width, height = rect["width"], rect["height"]
            origin_x, origin_y = rect.get("left", 0), rect.get("top", 0)
        else:
            width, height = self._screen_size()
            origin_x = origin_y = 0
        rel_x = int(float(msg.get("x", 0.0)) * width)
        rel_y = int(float(msg.get("y", 0.0)) * height)
        rel_x = max(0, min(width - 1, rel_x))
        rel_y = max(0, min(height - 1, rel_y))
        x = origin_x + rel_x
        y = origin_y + rel_y
        button = str(msg.get("button") or "left")
        action = str(msg.get("action") or "move")

        if action == "move":
            gui.moveTo(x, y)
        elif action == "down":
            gui.mouseDown(x=x, y=y, button=button)
        elif action == "up":
            gui.mouseUp(x=x, y=y, button=button)
        elif action == "click":
            gui.click(x=x, y=y, button=button)
        elif action == "dblclick":
            gui.doubleClick(x=x, y=y, button=button)

    def _wheel(self, msg: dict[str, Any]) -> None:
        gui = self._gui()
        try:
            dx = float(msg.get("dx", 0))
            dy = float(msg.get("dy", 0))
        except (TypeError, ValueError):
            return
        if dx:
            gui.hscroll(int(dx))
        if dy:
            gui.vscroll(int(dy))

    def _resolve_key(self, code: Any) -> Optional[str]:
        if not isinstance(code, str):
            return None
        if code in KEY_MAP:
            return KEY_MAP[code]
        if len(code) == 1:
            return code.lower()
        return None

    def _key(self, msg: dict[str, Any]) -> None:
        gui = self._gui()
        key = self._resolve_key(msg.get("code"))
        if not key:
            logger.debug("Unsupported remote key: %s", msg.get("code"))
            return
        action = str(msg.get("action") or "press")
        if action == "down":
            gui.keyDown(key)
        elif action == "up":
            gui.keyUp(key)
        else:
            gui.press(key)

    def _type_text(self, msg: dict[str, Any]) -> None:
        gui = self._gui()
        text = str(msg.get("text") or "")
        if not text:
            return
        try:
            gui.write(text, interval=0)
        except Exception as exc:
            logger.debug("Remote typing failed for %r: %s", text[:32], exc)
