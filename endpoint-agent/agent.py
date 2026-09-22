"""EndpointX agent - lightweight service for endpoint management.

Collects system information, sends heartbeats to the server, and executes
authorized commands. Runs on Windows, Linux, and macOS.
"""

import argparse
import hashlib
import hmac
import json
import logging
import os
import platform
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import psutil
import requests
import yaml

from system_info import (
    get_hostname,
    get_os_info,
    get_ip_address,
    get_mac_address,
    get_cpu_info,
    get_memory_info,
    get_disk_info,
    get_network_traffic,
    get_network_interfaces,
    get_running_processes,
    get_installed_software,
    get_running_services,
    collect_inventory,
    get_firewall_status,
    get_antivirus_status,
    get_system_uptime,
)

logger = logging.getLogger("endpointx-agent")

CONFIG_PATH = Path(__file__).parent / "config.yaml"

_SHUTDOWN_REQUESTED = False

SYSTEM = platform.system()


def _get_platform_paths() -> dict[str, Path]:
    """Return platform-specific paths for lock, backup, and hash files."""
    if SYSTEM == "Windows":
        base = Path(os.environ.get("PROGRAMDATA", r"C:\ProgramData")) / "EndpointX"
    elif SYSTEM == "Darwin":
        base = Path.home() / "endpointx-agent"
    else:
        base = Path("/opt/endpointx-agent")
    return {
        "base": base,
        "lock": base / "agent.lock",
        "backup": base / "agent.py.bak",
        "hash": base / "agent.sha256",
    }


class TamperProtection:
    """Tamper protection for the EndpointX agent.

    Prevents unauthorized stopping, modifying, or uninstalling by:
    - Lock file to prevent multiple instances
    - SHA256 integrity checking with periodic verification
    - Backup/restore of agent files
    - Tamper alert reporting to the server
    """

    def __init__(self, server_url: str, agent_id: str, agent_secret: str) -> None:
        self.server_url = server_url
        self.agent_id = agent_id
        self.agent_secret = agent_secret
        self._paths = _get_platform_paths()
        self._agent_path = Path(os.path.abspath(__file__))
        self._initial_hash: Optional[str] = None
        self._lock_fd: Any = None
        self._integrity_check_interval = 300  # seconds
        self._last_integrity_check = 0.0
        self.session = requests.Session()

        try:
            self._paths["base"].mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            logger.warning("Failed to create tamper protection base dir %s: %s", self._paths["base"], exc)

    def create_lock(self) -> bool:
        """Create a lock file containing the current PID. Returns False if another instance is running."""
        try:
            lock_path = self._paths["lock"]
            if lock_path.exists():
                try:
                    existing_pid = int(lock_path.read_text().strip())
                    if self._is_process_running(existing_pid):
                        logger.error(
                            "Another agent instance is already running (PID %d). "
                            "Lock file: %s",
                            existing_pid,
                            lock_path,
                        )
                        return False
                    else:
                        logger.warning(
                            "Stale lock file found for PID %d, removing", existing_pid
                        )
                        lock_path.unlink(missing_ok=True)
                except (ValueError, OSError):
                    logger.warning("Corrupt lock file, removing")
                    lock_path.unlink(missing_ok=True)

            lock_path.write_text(str(os.getpid()), encoding="utf-8")
            self._lock_fd = lock_path
            logger.info("Lock file created at %s (PID %d)", lock_path, os.getpid())
            return True
        except OSError as exc:
            logger.error("Failed to create lock file: %s", exc)
            return True  # Allow startup if lock file creation fails

    def check_lock(self) -> bool:
        """Check if another instance is already running via lock file."""
        try:
            lock_path = self._paths["lock"]
            if not lock_path.exists():
                return False
            existing_pid = int(lock_path.read_text().strip())
            if existing_pid == os.getpid():
                return False
            if self._is_process_running(existing_pid):
                return True
            return False
        except (ValueError, OSError):
            return False

    def compute_hash(self) -> Optional[str]:
        """Compute SHA256 hash of agent.py."""
        try:
            with open(self._agent_path, "rb") as f:
                file_bytes = f.read()
            return hashlib.sha256(file_bytes).hexdigest()
        except OSError as exc:
            logger.error("Failed to compute agent hash: %s", exc)
            return None

    def verify_integrity(self) -> bool:
        """Verify agent integrity by comparing current hash with stored hash."""
        current_hash = self.compute_hash()
        if current_hash is None:
            return True  # Cannot verify, allow

        if self._initial_hash is None:
            self._initial_hash = self._load_stored_hash()
            if self._initial_hash is None:
                logger.info("No stored hash found, storing current hash: %s", current_hash)
                self._store_hash(current_hash)
                self._initial_hash = current_hash
                self.backup_agent()
                return True

        if current_hash != self._initial_hash:
            logger.critical(
                "AGENT TAMPER DETECTED! Hash mismatch. Expected %s, got %s",
                self._initial_hash,
                current_hash,
            )
            self.report_tamper(
                "tamper_detected",
                {
                    "expected_hash": self._initial_hash,
                    "current_hash": current_hash,
                    "message": "Agent file integrity check failed - agent.py has been modified",
                },
            )
            return False

        return True

    def backup_agent(self) -> bool:
        """Create a backup copy of agent.py for restoration purposes."""
        try:
            backup_path = self._paths["backup"]
            import shutil
            shutil.copy2(self._agent_path, backup_path)
            logger.info("Agent backup created at %s", backup_path)
            return True
        except (OSError, shutil.Error) as exc:
            logger.error("Failed to backup agent: %s", exc)
            return False

    def restore_agent(self) -> bool:
        """Restore agent.py from backup copy."""
        try:
            backup_path = self._paths["backup"]
            if not backup_path.exists():
                logger.error("No backup found at %s", backup_path)
                return False
            import shutil
            shutil.copy2(backup_path, self._agent_path)
            logger.info("Agent restored from backup %s", backup_path)
            self._initial_hash = self.compute_hash()
            if self._initial_hash:
                self._store_hash(self._initial_hash)
            return True
        except (OSError, shutil.Error) as exc:
            logger.error("Failed to restore agent from backup: %s", exc)
            return False

    def report_tamper(self, tamper_type: str, details: Optional[dict] = None) -> None:
        """Send a tamper alert to the server."""
        try:
            payload = {
                "agent_id": self.agent_id,
                "alerts": [
                    {
                        "type": "tamper_detected",
                        "alert_type": "tamper_detected",
                        "severity": "critical",
                        "title": f"Tamper Alert: {tamper_type}",
                        "description": details.get("message", f"Tamper event: {tamper_type}")
                        if details
                        else f"Tamper event: {tamper_type}",
                    }
                ],
            }
            url = f"{self.server_url}/devices/alerts"
            headers = {
                "Content-Type": "application/json",
                "X-Agent-Secret": self.agent_secret,
            }
            resp = self.session.post(url, json=payload, headers=headers, timeout=10)
            if resp.status_code in (200, 201):
                logger.info("Tamper alert reported to server: %s", tamper_type)
            else:
                logger.warning("Tamper alert report failed with status %d", resp.status_code)
        except requests.exceptions.RequestException as exc:
            logger.error("Failed to report tamper alert: %s", exc)

    def periodic_integrity_check(self) -> None:
        """Run integrity check on a periodic schedule (call from heartbeat loop)."""
        now = time.time()
        if now - self._last_integrity_check < self._integrity_check_interval:
            return
        self._last_integrity_check = now
        if not self.verify_integrity():
            logger.warning("Periodic integrity check failed, attempting restore...")
            self.restore_agent()

    def get_hash_for_heartbeat(self) -> Optional[str]:
        """Return the current agent hash to include in heartbeat responses."""
        return self.compute_hash()

    def cleanup(self) -> None:
        """Remove lock file on agent exit."""
        try:
            lock_path = self._paths["lock"]
            if lock_path.exists():
                lock_path.unlink(missing_ok=True)
                logger.info("Lock file removed: %s", lock_path)
        except OSError as exc:
            logger.warning("Failed to remove lock file: %s", exc)

    def verify_uninstall_command(self, command: dict[str, Any]) -> bool:
        """Verify that an uninstall command is properly signed with HMAC-SHA256."""
        try:
            signature = command.get("signature", "")
            if not signature:
                logger.error("Uninstall command missing signature")
                return False

            # Build the message to verify: agent_id + command_type
            cmd_type = command.get("command_type", command.get("type", ""))
            message = f"{self.agent_id}:{cmd_type}"
            expected_sig = hmac.new(
                self.agent_secret.encode("utf-8"),
                message.encode("utf-8"),
                hashlib.sha256,
            ).hexdigest()

            if not hmac.compare_digest(signature, expected_sig):
                logger.critical(
                    "Uninstall command signature verification FAILED! "
                    "Expected %s, got %s",
                    expected_sig,
                    signature,
                )
                return False

            return True
        except Exception as exc:
            logger.error("Uninstall verification error: %s", exc)
            return False

    def execute_uninstall(self) -> None:
        """Gracefully stop and remove the agent after verified uninstall command."""
        logger.critical("Authorized uninstall initiated. Logging event and shutting down.")
        self.report_tamper(
            "uninstall_authorized",
            {"message": "Agent uninstall authorized by server"},
        )
        self.cleanup()
        logger.info("Agent stopped for uninstall. Files remain for manual cleanup.")
        global _SHUTDOWN_REQUESTED
        _SHUTDOWN_REQUESTED = True

    # -- Private helpers --

    @staticmethod
    def _is_process_running(pid: int) -> bool:
        """Check if a process with the given PID is still alive."""
        try:
            if SYSTEM == "Windows":
                import ctypes
                kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
                handle = kernel32.OpenProcess(0x100000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
                if handle:
                    kernel32.CloseHandle(handle)
                    return True
                return False
            else:
                os.kill(pid, 0)
                return True
        except (OSError, PermissionError, AttributeError):
            return False

    def _load_stored_hash(self) -> Optional[str]:
        """Load the stored hash from disk."""
        try:
            hash_path = self._paths["hash"]
            if hash_path.exists():
                return hash_path.read_text(encoding="utf-8").strip()
        except OSError as exc:
            logger.warning("Failed to load stored hash: %s", exc)
        return None

    def _store_hash(self, hash_value: str) -> None:
        """Persist the agent hash to disk."""
        try:
            hash_path = self._paths["hash"]
            hash_path.write_text(hash_value, encoding="utf-8")
        except OSError as exc:
            logger.warning("Failed to store hash: %s", exc)


class EndpointAgent:
    """Main agent class that manages registration, heartbeat, and command execution."""

    def __init__(self, config_path: Optional[str] = None) -> None:
        self.config_path = Path(config_path) if config_path else CONFIG_PATH
        self.config: dict[str, Any] = {}
        self.session = requests.Session()
        self._running = False
        self._tamper: Optional[TamperProtection] = None
        self._load_config()
        self._setup_logging()
        self._setup_signals()
        self._init_tamper_protection()

    def _load_config(self) -> None:
        if not self.config_path.exists():
            logger.warning("Config file not found at %s, using defaults", self.config_path)
            self.config = {
                "server_url": "http://localhost:3001/api",
                "agent_secret": "agent_shared_secret_here",
                "agent_id": "",
                "heartbeat_interval": 60,
                "log_level": "INFO",
                "log_file": "endpointx-agent.log",
            }
            return

        with open(self.config_path, "r", encoding="utf-8") as f:
            self.config = yaml.safe_load(f) or {}

        self.config.setdefault("server_url", "http://localhost:3001/api")
        self.config.setdefault("agent_secret", "agent_shared_secret_here")
        self.config.setdefault("agent_id", "")
        self.config.setdefault("heartbeat_interval", 60)
        self.config.setdefault("log_level", "INFO")
        self.config.setdefault("log_file", "endpointx-agent.log")

        # Auto-detect hostname if agent_id is AUTO or doesn't match current hostname
        current_hostname = get_hostname()
        if self.config["agent_id"] in ("AUTO", "", None) or self.config["agent_id"] != current_hostname:
            logger.info("Auto-detecting hostname: %s (was: %s)", current_hostname, self.config["agent_id"])
            self.config["agent_id"] = current_hostname
            self._save_config()

    def _save_config(self) -> None:
        try:
            with open(self.config_path, "w", encoding="utf-8") as f:
                yaml.dump(self.config, f, default_flow_style=False)
        except Exception as exc:
            logger.error("Failed to save config: %s", exc)

    def _setup_logging(self) -> None:
        log_level = getattr(logging, self.config.get("log_level", "INFO").upper(), logging.INFO)
        log_file = self.config.get("log_file", "endpointx-agent.log")

        handlers: list[logging.Handler] = []

        if sys.stdout is not None:
            handlers.append(logging.StreamHandler(sys.stdout))

        try:
            file_handler = logging.FileHandler(log_file, encoding="utf-8")
            handlers.append(file_handler)
        except OSError:
            pass

        if not handlers:
            handlers.append(logging.NullHandler())

        logging.basicConfig(
            level=log_level,
            format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
            handlers=handlers,
        )

    def _setup_signals(self) -> None:
        def _handle_signal(signum: int, frame: Any) -> None:
            global _SHUTDOWN_REQUESTED
            _SHUTDOWN_REQUESTED = True
            logger.info("Shutdown signal received (signal %d)", signum)

        signal.signal(signal.SIGINT, _handle_signal)
        signal.signal(signal.SIGTERM, _handle_signal)

        if platform.system() == "Windows":
            try:
                signal.signal(signal.SIGBREAK, _handle_signal)
            except (OSError, AttributeError):
                pass

    def _init_tamper_protection(self) -> None:
        """Initialize tamper protection subsystem."""
        try:
            self._tamper = TamperProtection(
                server_url=self.config.get("server_url", "http://localhost:3001/api"),
                agent_id=self.config.get("agent_id", get_hostname()),
                agent_secret=self.config.get("agent_secret", ""),
            )
            if not self._tamper.create_lock():
                logger.critical("Cannot start: another agent instance is already running.")
                sys.exit(1)
            if not self._tamper.check_lock():
                self._tamper.verify_integrity()
        except Exception as exc:
            logger.warning("Tamper protection init failed (non-fatal): %s", exc)

    def _make_request(
        self,
        method: str,
        endpoint: str,
        data: Optional[dict] = None,
        timeout: int = 30,
    ) -> Optional[requests.Response]:
        url = f"{self.config['server_url']}{endpoint}"
        headers = {
            "Content-Type": "application/json",
            "X-Agent-Secret": self.config.get("agent_secret", ""),
        }

        try:
            if method.upper() == "POST":
                resp = self.session.post(url, json=data, headers=headers, timeout=timeout)
            else:
                resp = self.session.get(url, headers=headers, timeout=timeout)
            return resp
        except requests.exceptions.ConnectionError:
            logger.error("Connection failed to server: %s", url)
        except requests.exceptions.Timeout:
            logger.error("Request timed out: %s %s", method, endpoint)
        except requests.exceptions.RequestException as exc:
            logger.error("Request failed: %s", exc)
        return None

    def register(self) -> bool:
        """Register this device with the EndpointX server."""
        logger.info("Registering device with server...")

        hostname = get_hostname()
        os_info = get_os_info()
        ip_address = get_ip_address()
        mac_address = get_mac_address()

        payload = {
            "agent_id": self.config.get("agent_id") or hostname,
            "hostname": hostname,
            "os_type": os_info["type"],
            "os_version": os_info.get("release", os_info["type"]),
            "os_build": os_info.get("build", ""),
            "mac_address": mac_address,
            "ip_address": ip_address,
        }

        resp = self._make_request("POST", "/devices/register", payload)
        if resp is None:
            return False

        if resp.status_code in (200, 201):
            try:
                result = resp.json()
                if result.get("success"):
                    device_data = result.get("data", {})
                    device_id = device_data.get("id", "")
                    self.config["agent_id"] = device_data.get("agent_id", hostname)
                    self._save_config()
                    logger.info("Device registered successfully. ID: %s", device_id)
                    return True
                else:
                    logger.error("Registration rejected: %s", result.get("error", "Unknown error"))
                    return False
            except (json.JSONDecodeError, KeyError) as exc:
                logger.error("Failed to parse registration response: %s", exc)
                return False
        elif resp.status_code == 409:
            logger.info("Device already registered")
            try:
                result = resp.json()
                if result.get("data", {}).get("id"):
                    self.config["agent_id"] = payload["agent_id"]
                    self._save_config()
                    return True
            except (json.JSONDecodeError, KeyError):
                pass
            return False
        else:
            logger.error("Registration failed with status %d: %s", resp.status_code, resp.text[:200])
            return False

    def send_inventory(self) -> bool:
        """Send full inventory (software, services, processes, network) to server."""
        logger.info("Sending inventory to server...")
        inventory = collect_inventory()

        payload = {
            "agent_id": self.config.get("agent_id", get_hostname()),
            "software": inventory.get("installed_software", []),
            "services": inventory.get("running_services", []),
            "processes": inventory.get("running_processes", []),
            "network_interfaces": get_network_interfaces(),
        }

        resp = self._make_request("POST", "/devices/inventory", payload)
        if resp is None:
            return False

        if resp.status_code == 200:
            logger.info("Inventory sent successfully")
            return True
        else:
            logger.error("Inventory send failed with status %d: %s", resp.status_code, resp.text[:200])
            return False

    def heartbeat(self) -> Optional[dict[str, Any]]:
        """Send a heartbeat with system metrics and receive pending commands.
        
        Includes retry logic with exponential backoff for transient failures.
        """
        max_retries = 3
        for attempt in range(max_retries):
            try:
                cpu_info = get_cpu_info()
                mem_info = get_memory_info()
                disk_info = get_disk_info()
                net_traffic = get_network_traffic()
                proc_count = len(psutil.pids())

                payload = {
                    "agent_id": self.config.get("agent_id", get_hostname()),
                    "cpu_usage": cpu_info.get("usage_percent", 0),
                    "ram_usage": mem_info.get("percent", 0),
                    "disk_usage": disk_info.get("percent", 0),
                    "network_in": net_traffic.get("bytes_recv", 0),
                    "network_out": net_traffic.get("bytes_sent", 0),
                    "active_processes": proc_count,
                    "current_version": "1.2.0",
                }

                if self._tamper:
                    agent_hash = self._tamper.get_hash_for_heartbeat()
                    if agent_hash:
                        payload["agent_hash"] = agent_hash

                resp = self._make_request("POST", "/devices/heartbeat", payload)
                if resp is None:
                    if attempt < max_retries - 1:
                        wait = (attempt + 1) * 5
                        logger.warning("Heartbeat connection failed (attempt %d/%d), retrying in %ds...",
                                       attempt + 1, max_retries, wait)
                        time.sleep(wait)
                        continue
                    return None

                if resp.status_code == 200:
                    data = resp.json()
                    server_data = data.get("data", {})
                    server_version = server_data.get("agent_version", "")
                    if server_version and server_version != "1.2.0" and not getattr(self, '_update_attempted', False):
                        logger.info("New agent version available: %s (current: 1.2.0)", server_version)
                        self._update_attempted = True
                        self._auto_update()
                    return data
                elif resp.status_code == 404:
                    logger.warning("Device not registered. Attempting registration...")
                    if self.register():
                        return self.heartbeat()
                    return None
                else:
                    logger.error("Heartbeat failed with status %d", resp.status_code)
                    return None
            except Exception as exc:
                logger.error("Heartbeat error: %s", exc)
                if attempt < max_retries - 1:
                    wait = (attempt + 1) * 5
                    logger.warning("Retrying in %ds... (attempt %d/%d)", wait, attempt + 1, max_retries)
                    time.sleep(wait)
                    continue
                return None

    def _auto_update(self) -> None:
        """Download latest agent files from GitHub and restart."""
        try:
            import urllib.request
            base_url = "https://raw.githubusercontent.com/Masukulmiguel/endpointx/main/endpoint-agent"
            agent_dir = os.path.dirname(os.path.abspath(__file__))
            files_to_update = ["agent.py", "system_info.py"]
            updated = []

            for fname in files_to_update:
                url = f"{base_url}/{fname}"
                try:
                    req = urllib.request.Request(url)
                    with urllib.request.urlopen(req, timeout=30) as resp:
                        content = resp.read()
                        target = os.path.join(agent_dir, fname)
                        with open(target, "wb") as f:
                            f.write(content)
                        updated.append(fname)
                        logger.info("Auto-updated %s", fname)
                except Exception as exc:
                    logger.warning("Failed to auto-update %s: %s", fname, exc)

            if updated:
                logger.info("Auto-update complete. Restarting agent...")
                os.execl(sys.executable, sys.executable, *sys.argv)
        except Exception as exc:
            logger.error("Auto-update failed: %s", exc)

    def report_command_result(self, cmd_id: str, status: str, result: Any = None, error_message: str = None) -> bool:
        """Report command execution result back to server."""
        payload = {
            "agent_id": self.config.get("agent_id", get_hostname()),
            "command_id": cmd_id,
            "status": status,
            "result": result,
            "error_message": error_message,
        }
        resp = self._make_request("POST", "/devices/command-result", payload)
        if resp and resp.status_code == 200:
            logger.info("Command result reported for %s", cmd_id)
            return True
        else:
            logger.error("Failed to report command result for %s", cmd_id)
            return False

    def execute_command(self, command: dict[str, Any]) -> None:
        """Execute an authorized command received from the server."""
        cmd_id = command.get("id", "unknown")
        cmd_type = command.get("command_type", command.get("type", ""))
        params = command.get("parameters", {})

        # Parse parameters if they come as JSON string
        if isinstance(params, str):
            try:
                params = json.loads(params)
            except (json.JSONDecodeError, TypeError):
                params = {}

        logger.info("Executing command %s (type=%s)", cmd_id, cmd_type)

        handlers = {
            "reboot": self.handle_reboot,
            "shutdown": self.handle_shutdown,
            "lock": self.handle_lock,
            "unlock": self.handle_unlock,
            "inventory": self.handle_inventory,
            "update_agent": self.handle_update_agent,
            "scan": self.handle_scan,
            "get_info": self.handle_get_info,
            "uninstall_agent": self.handle_uninstall_agent,
        }

        handler = handlers.get(cmd_type)
        if not handler:
            logger.warning("Unknown command type: %s", cmd_type)
            self.report_command_result(cmd_id, "failed", error_message=f"Unknown command type: {cmd_type}")
            return

        try:
            result = handler(params)
            logger.info("Command %s completed: %s", cmd_id, result)
            self.report_command_result(cmd_id, "completed", result=result)
        except Exception as exc:
            logger.error("Command %s failed: %s", cmd_id, exc)
            self.report_command_result(cmd_id, "failed", error_message=str(exc))

    def handle_reboot(self, params: dict[str, Any]) -> dict[str, Any]:
        delay = params.get("delay", 5)
        logger.warning("Reboot command received, delay=%ds", delay)
        system = platform.system()

        def _do_reboot() -> None:
            time.sleep(delay)
            if system == "Windows":
                subprocess.run(["shutdown", "/r", "/t", "0"], check=False)
            elif system == "Darwin":
                subprocess.run(["sudo", "shutdown", "-r", "now"], check=False)
            else:
                subprocess.run(["sudo", "reboot"], check=False)

        import threading
        timer = threading.Thread(target=_do_reboot, daemon=True)
        timer.start()
        return {"message": f"System will reboot in {delay} seconds"}

    def handle_shutdown(self, params: dict[str, Any]) -> dict[str, Any]:
        delay = params.get("delay", 5)
        logger.warning("Shutdown command received, delay=%ds", delay)
        system = platform.system()

        def _do_shutdown() -> None:
            time.sleep(delay)
            if system == "Windows":
                subprocess.run(["shutdown", "/s", "/t", "0"], check=False)
            elif system == "Darwin":
                subprocess.run(["sudo", "shutdown", "-h", "now"], check=False)
            else:
                subprocess.run(["sudo", "shutdown", "-h", "now"], check=False)

        import threading
        timer = threading.Thread(target=_do_shutdown, daemon=True)
        timer.start()
        return {"message": f"System will shut down in {delay} seconds"}

    def handle_lock(self, params: dict[str, Any]) -> dict[str, Any]:
        logger.warning("Lock screen command received")
        system = platform.system()
        if system == "Windows":
            subprocess.run(["rundll32.exe", "user32.dll,LockWorkStation"], check=False)
        elif system == "Darwin":
            subprocess.run(
                ["/System/Library/CoreServices/Menu Extras/User.menu/Contents/Resources/CGSession", "-suspend"],
                check=False,
            )
        else:
            # Try loginctl first (systemd), fall back to xdg-screensaver
            try:
                result = subprocess.run(["loginctl", "lock-session"], capture_output=True, timeout=5)
                if result.returncode != 0:
                    subprocess.run(["xdg-screensaver", "lock"], check=False)
            except FileNotFoundError:
                subprocess.run(["xdg-screensaver", "lock"], check=False)
        return {"message": "Screen locked"}

    def handle_unlock(self, params: dict[str, Any]) -> dict[str, Any]:
        logger.info("Unlock screen command received")
        return {"message": "Unlock requires physical interaction - cannot be done remotely"}

    def handle_inventory(self, params: dict[str, Any]) -> dict[str, Any]:
        logger.info("Collecting and sending inventory")
        self.send_inventory()
        return {"message": "Inventory collected and sent to server"}

    def handle_update_agent(self, params: dict[str, Any]) -> dict[str, Any]:
        update_url = params.get("update_url", "")
        if not update_url:
            return {"message": "No update URL provided"}
        logger.info("Agent update requested from %s", update_url)
        try:
            import urllib.request
            import tempfile
            import shutil

            base_url = update_url.rstrip("/")
            agent_dir = os.path.dirname(os.path.abspath(__file__))

            files_to_update = ["agent.py", "system_info.py", "config.yaml"]
            updated = []

            for fname in files_to_update:
                url = f"{base_url}/{fname}"
                try:
                    req = urllib.request.Request(url)
                    with urllib.request.urlopen(req, timeout=30) as resp:
                        content = resp.read()
                        target = os.path.join(agent_dir, fname)
                        with open(target, "wb") as f:
                            f.write(content)
                        updated.append(fname)
                        logger.info("Updated %s", fname)
                except Exception as exc:
                    logger.warning("Failed to update %s: %s", fname, exc)

            if updated:
                logger.info("Update complete. Restarting agent...")
                os.execl(sys.executable, sys.executable, *sys.argv)
                return {"message": f"Updated {len(updated)} files, restarting", "files": updated}
            return {"message": "No files updated"}
        except Exception as exc:
            logger.error("Update failed: %s", exc)
            return {"message": f"Update failed: {exc}"}

    def handle_scan(self, params: dict[str, Any]) -> dict[str, Any]:
        logger.info("Security scan requested")
        scan_results: dict[str, Any] = {
            "scan_type": params.get("scan_type", "quick"),
            "scanned_at": datetime.now(timezone.utc).isoformat(),
            "firewall": get_firewall_status(),
            "antivirus": get_antivirus_status(),
            "findings": [],
        }

        processes = get_running_processes()
        high_cpu = [p for p in processes if p.get("cpu_percent", 0) > 80]
        if high_cpu:
            scan_results["findings"].append({
                "severity": "info",
                "title": "High CPU Usage",
                "description": f"{len(high_cpu)} processes with high CPU usage",
                "type": "high_cpu_usage",
                "details": [p["name"] for p in high_cpu[:10]],
            })

        scan_results["findings_count"] = len(scan_results["findings"])

        # Send scan results to server for event/alert generation
        try:
            self._make_request("POST", "/devices/security-scan", {
                "agent_id": self.config.get("agent_id", get_hostname()),
                "scan_type": scan_results["scan_type"],
                "firewall": scan_results["firewall"],
                "antivirus": scan_results["antivirus"],
                "high_cpu_processes": high_cpu[:10],
                "findings": scan_results["findings"],
            })
        except Exception as exc:
            logger.error("Failed to send scan results to server: %s", exc)

        return scan_results

    def _send_security_scan(self) -> None:
        """Send automatic security scan results to server."""
        logger.info("Running automatic security scan...")
        firewall = get_firewall_status()
        antivirus = get_antivirus_status()
        processes = get_running_processes()
        high_cpu = [p for p in processes if p.get("cpu_percent", 0) > 80][:10]

        findings = []
        if not firewall.get("enabled"):
            findings.append({
                "severity": "high",
                "title": "Firewall Disabled",
                "description": "Firewall is disabled on this device",
                "type": "firewall_disabled",
            })
        if not antivirus.get("enabled"):
            findings.append({
                "severity": "high",
                "title": "Antivirus Not Running",
                "description": "No active antivirus detected",
                "type": "antivirus_disabled",
            })
        if high_cpu:
            findings.append({
                "severity": "medium",
                "title": "High CPU Usage",
                "description": f"{len(high_cpu)} processes using high CPU",
                "type": "high_cpu_usage",
            })

        self._make_request("POST", "/devices/security-scan", {
            "agent_id": self.config.get("agent_id", get_hostname()),
            "scan_type": "auto",
            "firewall": firewall,
            "antivirus": antivirus,
            "high_cpu_processes": high_cpu,
            "findings": findings,
        })

    def handle_get_info(self, params: dict[str, Any]) -> dict[str, Any]:
        logger.info("Detailed system info requested")
        return {
            "hostname": get_hostname(),
            "os": get_os_info(),
            "ip_address": get_ip_address(),
            "mac_address": get_mac_address(),
            "cpu": get_cpu_info(),
            "memory": get_memory_info(),
            "disk": get_disk_info(),
            "network_interfaces": get_network_interfaces(),
            "collected_at": datetime.now(timezone.utc).isoformat(),
        }

    def handle_uninstall_agent(self, params: dict[str, Any]) -> dict[str, Any]:
        """Handle a verified uninstall command from the server.

        The command must carry an HMAC-SHA256 signature computed from
        agent_id:command_type using the shared AGENT_SECRET.  If the
        signature is missing or invalid the agent logs a tamper alert
        and refuses to proceed.
        """
        logger.warning("Uninstall command received")

        # Report unauthorized attempt if no tamper protection or no signature
        if self._tamper is None:
            logger.critical("Uninstall blocked: tamper protection not initialized")
            return {"message": "Uninstall blocked: tamper protection unavailable"}

        # Verify HMAC signature
        signature = params.get("signature", "")
        if not signature:
            logger.critical("Uninstall command has no signature - unauthorized attempt!")
            self._tamper.report_tamper(
                "uninstall_unauthorized",
                {"message": "Uninstall command received without valid signature"},
            )
            return {"message": "Uninstall rejected: missing signature"}

        cmd_type = "uninstall_agent"
        message = f"{self.config.get('agent_id', '')}:{cmd_type}"
        expected_sig = hmac.new(
            self.config.get("agent_secret", "").encode("utf-8"),
            message.encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()

        if not hmac.compare_digest(signature, expected_sig):
            logger.critical(
                "Uninstall command signature verification FAILED! "
                "This is an unauthorized uninstall attempt."
            )
            self._tamper.report_tamper(
                "uninstall_unauthorized",
                {
                    "message": "Uninstall command signature verification failed",
                    "expected_prefix": expected_sig[:8] + "...",
                },
            )
            return {"message": "Uninstall rejected: invalid signature"}

        logger.info("Uninstall command signature verified. Proceeding with uninstall.")
        import threading
        timer = threading.Thread(target=self._tamper.execute_uninstall, daemon=True)
        timer.start()
        return {"message": "Uninstall authorized - agent will shut down"}

    def run(self) -> None:
        global _SHUTDOWN_REQUESTED

        logger.info("EndpointX agent starting...")
        logger.info("Platform: %s (%s)", platform.system(), platform.platform())
        logger.info("Python: %s", platform.python_version())
        logger.info("Server: %s", self.config["server_url"])
        logger.info("Heartbeat interval: %ds", self.config["heartbeat_interval"])

        self._running = True
        self._inventory_sent = False
        self._security_sent = False
        self._last_security_check = 0

        if not self.config.get("agent_id"):
            logger.info("No agent_id found, attempting registration...")
            if not self.register():
                logger.error("Initial registration failed. Will retry on heartbeat.")

        logger.info("Entering heartbeat loop...")
        try:
            while self._running and not _SHUTDOWN_REQUESTED:
                try:
                    response = self.heartbeat()
                    if response:
                        data = response.get("data", {})
                        commands = data.get("commands", [])
                        if commands:
                            logger.info("Received %d command(s) from server", len(commands))
                            for cmd in commands:
                                try:
                                    self.execute_command(cmd)
                                except Exception as exc:
                                    logger.error("Command execution error: %s", exc)

                        # Send inventory on first successful heartbeat
                        if not self._inventory_sent:
                            try:
                                self.send_inventory()
                                self._inventory_sent = True
                            except Exception as exc:
                                logger.error("Inventory send error: %s", exc)

                        # Auto security scan on first heartbeat
                        if not self._security_sent:
                            try:
                                self._send_security_scan()
                                self._security_sent = True
                            except Exception as exc:
                                logger.error("Auto security scan error: %s", exc)

                        # Auto security scan every 10 minutes
                        now = time.time()
                        if now - self._last_security_check >= 600:
                            try:
                                self._send_security_scan()
                                self._last_security_check = now
                            except Exception as exc:
                                logger.error("Auto security scan error: %s", exc)

                    # Periodic integrity check via tamper protection
                    if self._tamper:
                        try:
                            self._tamper.periodic_integrity_check()
                        except Exception as exc:
                            logger.error("Integrity check error: %s", exc)

                except Exception as exc:
                    logger.error("Heartbeat cycle error: %s", exc)

                interval = self.config.get("heartbeat_interval", 60)
                for _ in range(interval):
                    if _SHUTDOWN_REQUESTED or not self._running:
                        break
                    time.sleep(1)
        finally:
            if self._tamper:
                self._tamper.cleanup()
            logger.info("EndpointX agent stopped")


def main() -> None:
    parser = argparse.ArgumentParser(description="EndpointX Agent")
    parser.add_argument("-c", "--config", default=None, help="Path to config file")
    parser.add_argument("--register", action="store_true", help="Force registration and exit")
    parser.add_argument("--info", action="store_true", help="Print system info and exit")
    parser.add_argument("--version", action="store_true", help="Print version and exit")
    args = parser.parse_args()

    if args.version:
        print("EndpointX Agent v1.2.0 by Masukulu Miguel")
        sys.exit(0)

    if args.info:
        from system_info import collect_all_system_info
        info = collect_all_system_info()
        print(json.dumps(info, indent=2, default=str))
        sys.exit(0)

    agent = EndpointAgent(config_path=args.config)

    if args.register:
        success = agent.register()
        sys.exit(0 if success else 1)

    agent.run()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
    except Exception as e:
        import traceback
        tb = traceback.format_exc()
        logger.critical("Agent crashed: %s", tb)
        try:
            with open("crash.log", "a", encoding="utf-8") as f:
                f.write(f"\n--- Crash at {datetime.now()} ---\n{tb}\n")
        except Exception:
            pass
