"""Read-only forensic collectors for the EndpointX HERMES investigation module.

Every collector in this module is strictly read-only with respect to evidence:
nothing is deleted, renamed, executed, quarantined or otherwise modified during
collection. Temporary copies made to read browser databases are created outside
the evidence locations and removed before returning.

Collectors are best effort: a failure on one section is recorded in the
``errors`` list instead of aborting the whole collection, so the server always
learns which sections actually produced data and which did not.
"""

import glob
import hashlib
import json
import os
import platform
import shutil
import sqlite3
import subprocess
import tempfile
import time
from datetime import datetime, timedelta, timezone
from typing import Any

import psutil

SYSTEM = platform.system()

DEFAULT_LIMITS: dict[str, Any] = {
    "max_processes": 400,
    "max_connections": 500,
    "max_files": 40,
    "max_recent_files": 25,
    "max_persistence": 250,
    "max_browser_rows": 200,
    "max_events": 120,
    "max_users": 50,
    "max_hash_bytes": 512 * 1024 * 1024,
    "command_timeout": 30,
}

# Where droppers usually land; used when no explicit file focus is supplied.
RECENT_WINDOW_HOURS = 48

_PS_NO_WINDOW = subprocess.CREATE_NO_WINDOW if hasattr(subprocess, "CREATE_NO_WINDOW") else 0


def _iso(ts: float | None) -> str | None:
    """Convert an epoch timestamp to an ISO-8601 UTC string."""
    if not ts:
        return None
    try:
        return datetime.fromtimestamp(float(ts), tz=timezone.utc).isoformat()
    except (OverflowError, OSError, ValueError):
        return None


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _truncate(value: Any, limit: int = 500) -> str:
    text = str(value or "")
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _run(cmd: list[str], timeout: int = 30) -> str | None:
    """Run a command and return stdout, or None on any failure."""
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
            creationflags=_PS_NO_WINDOW,
        )
        return result.stdout or ""
    except Exception:
        return None


def _run_powershell(script: str, timeout: int = 40) -> str | None:
    """Run a PowerShell snippet via -EncodedCommand (no temp files, no policy prompt)."""
    if SYSTEM != "Windows":
        return None
    encoded = script.encode("utf-16-le")
    import base64

    try:
        result = subprocess.run(
            [
                "powershell",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-EncodedCommand",
                base64.b64encode(encoded).decode("ascii"),
            ],
            capture_output=True,
            text=True,
            timeout=timeout,
            creationflags=_PS_NO_WINDOW,
        )
        return result.stdout or ""
    except Exception:
        return None


def _ps_json(script: str, timeout: int = 40) -> Any:
    """Run PowerShell and parse ConvertTo-Json output; returns None on failure."""
    raw = _run_powershell(script, timeout)
    if not raw or not raw.strip():
        return None
    # PowerShell may prepend warnings/BOM noise; keep the outermost JSON value.
    text = raw.strip()
    start = min([i for i in (text.find("{"), text.find("[")) if i >= 0], default=-1)
    if start > 0:
        text = text[start:]
    try:
        return json.loads(text)
    except (json.JSONDecodeError, ValueError):
        return None


def _as_list(data: Any) -> list[dict[str, Any]]:
    """Normalise PowerShell ConvertTo-Json output (single object vs array)."""
    if isinstance(data, dict):
        return [data]
    if isinstance(data, list):
        return [row for row in data if isinstance(row, dict)]
    return []


def _json_arg(payload: Any) -> str:
    """Encode a value as a single-quoted PowerShell string literal."""
    text = json.dumps(payload, ensure_ascii=False)
    return "'" + text.replace("'", "''") + "'"


# ---------------------------------------------------------------------------
# 1. Process investigation
# ---------------------------------------------------------------------------

def collect_processes(focus: dict[str, Any], limits: dict[str, Any]) -> dict[str, Any]:
    """Full process table: pid, ppid, exe, cmdline, user, start time."""
    max_rows = int(limits.get("max_processes", 400))
    wanted_pids = {int(p) for p in (focus.get("pids") or []) if str(p).isdigit()}
    wanted_names = {str(n).lower() for n in (focus.get("process_names") or []) if n}

    fields = [
        "pid",
        "ppid",
        "name",
        "exe",
        "cmdline",
        "username",
        "create_time",
        "status",
        "cwd",
        "num_threads",
    ]
    rows: list[dict[str, Any]] = []
    errors: list[str] = []

    for proc in psutil.process_iter(fields):
        try:
            info = proc.info
            row = {
                "pid": info.get("pid"),
                "ppid": info.get("ppid"),
                "name": info.get("name") or "",
                "exe": info.get("exe") or "",
                "cmdline": _truncate(" ".join(info.get("cmdline") or []), 2000),
                "user": info.get("username") or "",
                "started_at": _iso(info.get("create_time")),
                "status": info.get("status") or "",
                "cwd": "",
                "num_threads": info.get("num_threads"),
            }
            try:
                row["cwd"] = proc.cwd() or ""
            except Exception:
                pass
            rows.append(row)
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
            continue
        except Exception as exc:
            errors.append(f"process {getattr(proc, 'pid', '?')}: {exc}")

    # Parent names are resolved once the full table is known.
    by_pid = {row["pid"]: row for row in rows}
    for row in rows:
        parent = by_pid.get(row.get("ppid"))
        row["parent_name"] = parent["name"] if parent else ""

    def _is_focus(row: dict[str, Any]) -> bool:
        return row.get("pid") in wanted_pids or str(row.get("name", "")).lower() in wanted_names

    focused = [row for row in rows if _is_focus(row)]
    rest = [row for row in rows if not _is_focus(row)]
    rest.sort(key=lambda r: r.get("started_at") or "", reverse=True)

    selected = focused + rest[: max(0, max_rows - len(focused))]
    selected.sort(key=lambda r: r.get("started_at") or "", reverse=True)

    return {
        "total_processes": len(rows),
        "returned": len(selected),
        "processes": selected,
        "errors": errors[:20],
    }


# ---------------------------------------------------------------------------
# 2. Network investigation
# ---------------------------------------------------------------------------

def collect_connections(focus: dict[str, Any], limits: dict[str, Any]) -> dict[str, Any]:
    """Every inet socket with the owning process, not just the 'suspicious' ones."""
    max_rows = int(limits.get("max_connections", 500))
    focus_ips = {str(ip) for ip in (focus.get("ips") or []) if ip}
    focus_domains = {str(d).lower().rstrip(".") for d in (focus.get("domains") or []) if d}

    rows: list[dict[str, Any]] = []
    errors: list[str] = []
    total = 0

    try:
        connections = psutil.net_connections(kind="inet")
    except Exception as exc:
        return {"total_connections": 0, "returned": 0, "connections": [], "errors": [str(exc)]}

    name_cache: dict[int, tuple[str, str]] = {}
    for conn in connections:
        total += 1
        pid = conn.pid
        process_name = ""
        exe = ""
        if pid:
            if pid not in name_cache:
                try:
                    p = psutil.Process(pid)
                    name_cache[pid] = (p.name() or "", p.exe() or "")
                except Exception:
                    name_cache[pid] = ("", "")
            process_name, exe = name_cache[pid]

        laddr = conn.laddr
        raddr = conn.raddr
        row = {
            "pid": pid,
            "process": process_name,
            "exe": exe,
            "local_ip": laddr.ip if laddr else "",
            "local_port": laddr.port if laddr else None,
            "remote_ip": raddr.ip if raddr else "",
            "remote_port": raddr.port if raddr else None,
            "protocol": "udp" if getattr(conn, "type", None) == 2 else "tcp",
            "status": conn.status or "",
        }
        rows.append(row)

    def _score(row: dict[str, Any]) -> int:
        score = 0
        if row.get("remote_ip") in focus_ips:
            score += 100
        if row.get("status") == "ESTABLISHED":
            score += 10
        if row.get("remote_ip"):
            score += 5
        return score

    rows.sort(key=_score, reverse=True)
    selected = rows[:max_rows]

    return {
        "total_connections": total,
        "returned": len(selected),
        "connections": selected,
        "errors": errors,
    }


# ---------------------------------------------------------------------------
# 3. File investigation
# ---------------------------------------------------------------------------

def _hash_file(path: str, max_bytes: int) -> dict[str, Any]:
    sha256 = hashlib.sha256()
    sha1 = hashlib.sha1()
    md5 = hashlib.md5()
    read = 0
    with open(path, "rb") as handle:
        while True:
            if read >= max_bytes:
                break
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            sha256.update(chunk)
            sha1.update(chunk)
            md5.update(chunk)
            read += len(chunk)
    return {
        "sha256": sha256.hexdigest(),
        "sha1": sha1.hexdigest(),
        "md5": md5.hexdigest(),
        "hashed_bytes": read,
        "truncated": read >= max_bytes,
    }


def _file_metadata(paths: list[str], timeout: int = 40) -> dict[str, dict[str, Any]]:
    """Owner, publisher and signature status. Windows only, single PS invocation."""
    if SYSTEM != "Windows" or not paths:
        return {}
    script = (
        "$ErrorActionPreference='SilentlyContinue';"
        "$paths = " + _json_arg(paths) + " | ConvertFrom-Json;"
        "$out = @();"
        "foreach ($p in $paths) {"
        "  $item = Get-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue;"
        "  if (-not $item) { continue };"
        "  $sig = Get-AuthenticodeSignature -LiteralPath $p -ErrorAction SilentlyContinue;"
        "  $owner = '';"
        "  try { $owner = (Get-Acl -LiteralPath $p -ErrorAction SilentlyContinue).Owner } catch {};"
        "  $out += [pscustomobject]@{"
        "    path = $p;"
        "    owner = $owner;"
        "    company = [string]$item.VersionInfo.CompanyName;"
        "    product = [string]$item.VersionInfo.ProductName;"
        "    file_description = [string]$item.VersionInfo.FileDescription;"
        "    file_version = [string]$item.VersionInfo.FileVersion;"
        "    signature_status = if ($sig) { [string]$sig.Status } else { '' };"
        "    signer = if ($sig -and $sig.SignerCertificate) { $sig.SignerCertificate.Subject } else { '' };"
        "  };"
        "}"
        "$out | ConvertTo-Json -Compress -Depth 4"
    )
    parsed = _ps_json(script, timeout)
    result: dict[str, dict[str, Any]] = {}
    for row in _as_list(parsed):
        path = row.get("path")
        if path:
            result[str(path)] = row
    return result


def collect_files(
    focus: dict[str, Any], limits: dict[str, Any]
) -> dict[str, Any]:
    """Hash and describe the files the investigation pointed at, plus recent
    files created near the incident window in the usual drop locations."""
    max_files = int(limits.get("max_files", 40))
    max_recent = int(limits.get("max_recent_files", 25))
    max_hash_bytes = int(limits.get("max_hash_bytes", DEFAULT_LIMITS["max_hash_bytes"]))
    timeout = int(limits.get("command_timeout", 30))

    errors: list[str] = []
    candidates: list[str] = []

    for path in focus.get("file_paths") or []:
        if isinstance(path, str) and path.strip():
            candidates.append(os.path.expandvars(path.strip()))

    since_iso = focus.get("since")
    since_ts = None
    if since_iso:
        try:
            since_ts = datetime.fromisoformat(str(since_iso).replace("Z", "+00:00")).timestamp()
        except ValueError:
            since_ts = None
    if since_ts is None:
        since_ts = time.time() - RECENT_WINDOW_HOURS * 3600

    for directory in _watched_dirs():
        if len(candidates) >= max_files + max_recent:
            break
        try:
            entries = []
            for entry in os.scandir(directory):
                try:
                    if not entry.is_file(follow_symlinks=False):
                        continue
                    stat = entry.stat(follow_symlinks=False)
                except (OSError, PermissionError):
                    continue
                if stat.st_mtime >= since_ts or stat.st_ctime >= since_ts:
                    entries.append((max(stat.st_mtime, stat.st_ctime), entry.path))
            entries.sort(reverse=True)
            for _, path in entries:
                if len(candidates) >= max_files + max_recent:
                    break
                if path not in candidates:
                    candidates.append(path)
        except (OSError, PermissionError):
            continue

    candidates = candidates[: max_files + max_recent]
    if not candidates:
        return {"returned": 0, "files": [], "errors": errors}

    meta = _file_metadata(candidates, timeout)
    files: list[dict[str, Any]] = []

    for path in candidates:
        try:
            stat = os.stat(path)
        except (OSError, PermissionError) as exc:
            errors.append(f"{path}: {exc}")
            continue

        record: dict[str, Any] = {
            "path": path,
            "name": os.path.basename(path),
            "size_bytes": stat.st_size,
            "created_at": _iso(stat.st_ctime),
            "modified_at": _iso(stat.st_mtime),
            "accessed_at": _iso(stat.st_atime),
            "owner": "",
            "company": "",
            "product": "",
            "file_description": "",
            "file_version": "",
            "signature_status": "",
            "signer": "",
            "is_focus": path in (focus.get("file_paths") or []),
        }
        record.update({k: v for k, v in meta.get(path, {}).items() if k != "path"})

        if stat.st_size > max_hash_bytes:
            record["hashed"] = False
            record["hash_reason"] = "file_too_large"
        else:
            try:
                record.update(_hash_file(path, max_hash_bytes))
                record["hashed"] = True
            except (OSError, PermissionError) as exc:
                record["hashed"] = False
                record["hash_reason"] = str(exc)
                errors.append(f"{path}: {exc}")

        files.append(record)

    focus_count = sum(1 for f in files if f.get("is_focus"))
    return {
        "scanned_directories": _watched_dirs(),
        "returned": len(files),
        "focus_files": focus_count,
        "files": files[:max_files + max_recent],
        "errors": errors[:20],
    }


def _watched_dirs() -> list[str]:
    system = SYSTEM
    if system == "Windows":
        home = os.path.expanduser("~")
        values = {
            "downloads": os.path.join(home, "Downloads"),
            "desktop": os.path.join(home, "Desktop"),
            "documents": os.path.join(home, "Documents"),
            "temp": os.environ.get("TEMP") or os.environ.get("TMP") or os.path.join(tempfile.gettempdir()),
            "appdata": os.environ.get("APPDATA") or os.path.join(home, "AppData", "Roaming"),
            "programdata": os.environ.get("PROGRAMDATA") or r"C:\ProgramData",
        }
        return [value for value in values.values() if value and os.path.isdir(value)]
    if system in ("Linux", "Darwin"):
        home = os.path.expanduser("~")
        candidates = [
            os.path.join(home, "Downloads"),
            os.path.join(home, "Desktop"),
            os.path.join(home, ".cache"),
            "/tmp",
            "/var/tmp",
        ]
        return [value for value in candidates if os.path.isdir(value)]
    return []


# ---------------------------------------------------------------------------
# 4. Persistence
# ---------------------------------------------------------------------------

_RUN_KEYS = [
    (r"SOFTWARE\Microsoft\Windows\CurrentVersion\Run", "HKLM"),
    (r"SOFTWARE\Microsoft\Windows\CurrentVersion\RunOnce", "HKLM"),
    (r"SOFTWARE\Wow6432Node\Microsoft\Windows\CurrentVersion\Run", "HKLM"),
    (r"SOFTWARE\Wow6432Node\Microsoft\Windows\CurrentVersion\RunOnce", "HKLM"),
    (r"SOFTWARE\Microsoft\Windows\CurrentVersion\Run", "HKCU"),
    (r"SOFTWARE\Microsoft\Windows\CurrentVersion\RunOnce", "HKCU"),
]


def _persistence_registry() -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    try:
        import winreg
    except ImportError:
        return items

    hives = (("HKLM", winreg.HKEY_LOCAL_MACHINE), ("HKCU", winreg.HKEY_CURRENT_USER))
    for subkey, hive_name in _RUN_KEYS:
        hive = dict(hives)[hive_name]
        try:
            with winreg.OpenKey(hive, subkey) as key:
                for index in range(winreg.QueryInfoKey(key)[1]):
                    name, value, _kind = winreg.EnumValue(key, index)
                    items.append(
                        {
                            "mechanism": "registry_run",
                            "hive": hive_name,
                            "key": subkey,
                            "name": name,
                            "value": _truncate(value, 1000),
                            "category": "windows",
                        }
                    )
        except OSError:
            continue

    extra_keys = [
        (r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon", ["Userinit", "Shell"], "winlogon"),
        (r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Windows", ["AppInit_DLLs"], "appinit"),
        (r"SOFTWARE\Wow6432Node\Microsoft\Windows NT\CurrentVersion\Windows", ["AppInit_DLLs"], "appinit"),
    ]
    for subkey, wanted, mechanism in extra_keys:
        try:
            with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, subkey) as key:
                for name in wanted:
                    try:
                        value, _kind = winreg.QueryValueEx(key, name)
                    except OSError:
                        continue
                    if value:
                        items.append(
                            {
                                "mechanism": mechanism,
                                "hive": "HKLM",
                                "key": subkey,
                                "name": name,
                                "value": _truncate(value, 1000),
                                "category": "windows",
                            }
                        )
        except OSError:
            continue

    # Image File Execution Options only matters when a Debugger is attached.
    try:
        with winreg.OpenKey(
            winreg.HKEY_LOCAL_MACHINE,
            r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options",
        ) as key:
            for index in range(winreg.QueryInfoKey(key)[0]):
                image = winreg.EnumKey(key, index)
                try:
                    with winreg.OpenKey(key, image) as sub:
                        value, _kind = winreg.QueryValueEx(sub, "Debugger")
                except OSError:
                    continue
                if value:
                    items.append(
                        {
                            "mechanism": "ifeo_debugger",
                            "hive": "HKLM",
                            "key": r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options",
                            "name": image,
                            "value": _truncate(value, 1000),
                            "category": "windows",
                        }
                    )
    except OSError:
        pass

    return items


def _persistence_windows(limits: dict[str, Any]) -> tuple[list[dict[str, Any]], list[str]]:
    items = _persistence_registry()
    errors: list[str] = []
    timeout = int(limits.get("command_timeout", 30))

    script = (
        "$ErrorActionPreference='SilentlyContinue';"
        "$out=@();"
        "$out += Get-CimInstance Win32_Service | ForEach-Object {"
        "  [pscustomobject]@{ mechanism='service'; name=$_.Name; value=$_.PathName;"
        "    detail=('{0} / {1}' -f $_.State, $_.StartMode); category='windows' } };"
        "$out += Get-ScheduledTask -ErrorAction SilentlyContinue | ForEach-Object {"
        "  [pscustomobject]@{ mechanism='scheduled_task'; name=$_.TaskName; value=$_.TaskPath;"
        "    detail=[string]$_.State; category='windows' } };"
        "$out | ConvertTo-Json -Compress -Depth 4"
    )
    parsed = _ps_json(script, max(timeout, 60))
    if parsed is None:
        errors.append("windows services/tasks query failed")
    for row in _as_list(parsed):
        row.setdefault("category", "windows")
        row.setdefault("detail", "")
        items.append(row)

    startup_globs = [
        os.path.join(os.environ.get("PROGRAMDATA", r"C:\ProgramData"),
                     "Microsoft", "Windows", "Start Menu", "Programs", "StartUp", "*"),
        os.path.join(os.path.expanduser("~"),
                     "AppData", "Roaming", "Microsoft", "Windows", "Start Menu",
                     "Programs", "Startup", "*"),
    ]
    for pattern in startup_globs:
        for path in glob.glob(pattern):
            try:
                stat = os.stat(path)
            except OSError:
                continue
            items.append(
                {
                    "mechanism": "startup_folder",
                    "name": os.path.basename(path),
                    "value": path,
                    "detail": _iso(stat.st_mtime) or "",
                    "category": "windows",
                }
            )
    return items, errors


def _persistence_linux(limits: dict[str, Any]) -> tuple[list[dict[str, Any]], list[str]]:
    items: list[dict[str, Any]] = []
    errors: list[str] = []
    timeout = int(limits.get("command_timeout", 30))
    home = os.path.expanduser("~")

    def _add(mechanism: str, name: str, value: str, detail: str = "") -> None:
        items.append(
            {
                "mechanism": mechanism,
                "name": name,
                "value": _truncate(value, 1000),
                "detail": _truncate(detail, 300),
                "category": "linux",
            }
        )

    crontab_files = [
        "/etc/crontab",
        "/etc/anacrontab",
        os.path.join(home, ".crontab"),
    ]
    for path in crontab_files:
        if os.path.isfile(path):
            try:
                with open(path, "r", encoding="utf-8", errors="replace") as handle:
                    body = handle.read(4000)
                _add("cron", os.path.basename(path), path, _truncate(body.replace("\n", " | "), 300))
            except OSError as exc:
                errors.append(f"{path}: {exc}")

    for path in glob.glob("/etc/cron.d/*"):
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as handle:
                body = handle.read(2000)
            _add("cron_d", os.path.basename(path), path, _truncate(body.replace("\n", " | "), 300))
        except OSError:
            continue

    crontab_out = _run(["crontab", "-l"], timeout) or ""
    if crontab_out.strip() and "no crontab" not in crontab_out.lower():
        _add("crontab", "user crontab", "crontab -l", _truncate(crontab_out.replace("\n", " | "), 300))

    for path in glob.glob("/etc/systemd/system/*.service") + glob.glob(
        os.path.join(home, ".config", "systemd", "user", "*.service")
    ):
        try:
            stat = os.stat(path)
            _add("systemd_service", os.path.basename(path), path, _iso(stat.st_mtime) or "")
        except OSError:
            continue

    for path in glob.glob(os.path.join(home, ".ssh", "authorized_keys*")):
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as handle:
                keys = [line.strip() for line in handle if line.strip() and not line.startswith("#")]
            _add("ssh_authorized_key", os.path.basename(path), path, f"{len(keys)} key(s)")
        except OSError as exc:
            errors.append(f"{path}: {exc}")

    for path in [
        os.path.join(home, ".profile"),
        os.path.join(home, ".bashrc"),
        os.path.join(home, ".bash_profile"),
        "/etc/profile",
        "/etc/bash.bashrc",
    ]:
        if not os.path.isfile(path):
            continue
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as handle:
                body = handle.read(20000)
        except OSError as exc:
            errors.append(f"{path}: {exc}")
            continue
        lowered = body.lower()
        markers = [m for m in ("curl ", "wget ", "base64", "nc -", "bash -i", "/dev/tcp") if m in lowered]
        _add("shell_profile", os.path.basename(path), path, ",".join(markers) or "clean")

    for path in glob.glob("/etc/init.d/*"):
        _add("init_script", os.path.basename(path), path, "")

    return items, errors


def _persistence_macos() -> tuple[list[dict[str, Any]], list[str]]:
    items: list[dict[str, Any]] = []
    home = os.path.expanduser("~")
    for pattern in (
        "/Library/LaunchDaemons/*.plist",
        "/Library/LaunchAgents/*.plist",
        os.path.join(home, "Library", "LaunchAgents", "*.plist"),
    ):
        for path in glob.glob(pattern):
            try:
                stat = os.stat(path)
            except OSError:
                continue
            items.append(
                {
                    "mechanism": "launchd",
                    "name": os.path.basename(path),
                    "value": path,
                    "detail": _iso(stat.st_mtime) or "",
                    "category": "darwin",
                }
            )
    return items, []


def collect_persistence(focus: dict[str, Any], limits: dict[str, Any]) -> dict[str, Any]:
    """Enumerate autostart mechanisms. Nothing is touched, only listed."""
    max_rows = int(limits.get("max_persistence", 250))
    errors: list[str] = []

    if SYSTEM == "Windows":
        items, section_errors = _persistence_windows(limits)
    elif SYSTEM == "Linux":
        items, section_errors = _persistence_linux(limits)
    elif SYSTEM == "Darwin":
        items, section_errors = _persistence_macos()
    else:
        items, section_errors = [], [f"unsupported platform: {SYSTEM}"]
    errors.extend(section_errors)

    focus_names = {str(n).lower() for n in (focus.get("process_names") or []) if n}

    def _score(item: dict[str, Any]) -> int:
        haystack = f"{item.get('name', '')} {item.get('value', '')}".lower()
        if any(name and name in haystack for name in focus_names):
            return 100
        if item.get("mechanism") in ("registry_run", "scheduled_task", "service"):
            return 10
        return 0

    items.sort(key=_score, reverse=True)
    return {
        "total": len(items),
        "returned": len(items[:max_rows]),
        "persistence": items[:max_rows],
        "errors": errors,
    }


# ---------------------------------------------------------------------------
# 5. Browser forensics
# ---------------------------------------------------------------------------

_CHROME_EPOCH = datetime(1601, 1, 1, tzinfo=timezone.utc)


def _chrome_time(value: Any) -> str | None:
    try:
        if not value:
            return None
        return (_CHROME_EPOCH + timedelta(microseconds=int(value))).isoformat()
    except (ValueError, OverflowError, TypeError):
        return None


def _firefox_time(value: Any) -> str | None:
    try:
        if not value:
            return None
        return datetime.fromtimestamp(int(value) / 1_000_000_000, tz=timezone.utc).isoformat()
    except (ValueError, OverflowError, OSError, TypeError):
        return None


def _sqlite_ro(path: str) -> sqlite3.Connection | None:
    """Open a database strictly read-only through a private temporary copy.

    The original file is never opened, so no journal/WAL file can be created
    next to the evidence.
    """
    tmp_dir = None
    try:
        tmp_dir = tempfile.mkdtemp(prefix="endpointx-forensic-")
        copy_path = os.path.join(tmp_dir, os.path.basename(path))
        shutil.copy2(path, copy_path)
        for suffix in ("-wal", "-shm", "-journal"):
            side = path + suffix
            if os.path.exists(side):
                try:
                    shutil.copy2(side, copy_path + suffix)
                except OSError:
                    pass
        conn = sqlite3.connect(f"file:{copy_path}?mode=ro", uri=True)
        conn.row_factory = sqlite3.Row
        return conn
    except Exception:
        if tmp_dir:
            shutil.rmtree(tmp_dir, ignore_errors=True)
        return None


def _close_and_cleanup(conn: sqlite3.Connection | None, tmp_dir: str | None) -> None:
    try:
        if conn:
            conn.close()
    except Exception:
        pass
    if tmp_dir:
        shutil.rmtree(tmp_dir, ignore_errors=True)


def _chrome_history(path: str, limit: int) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    tmp_dir = tempfile.mkdtemp(prefix="endpointx-forensic-")
    conn = None
    history: list[dict[str, Any]] = []
    downloads: list[dict[str, Any]] = []
    try:
        copy_path = os.path.join(tmp_dir, os.path.basename(path))
        shutil.copy2(path, copy_path)
        for suffix in ("-wal", "-shm", "-journal"):
            side = path + suffix
            if os.path.exists(side):
                try:
                    shutil.copy2(side, copy_path + suffix)
                except OSError:
                    pass
        conn = sqlite3.connect(f"file:{copy_path}?mode=ro", uri=True)
        conn.row_factory = sqlite3.Row
        for row in conn.execute(
            "SELECT url, title, visit_count, last_visit_time FROM urls "
            "ORDER BY last_visit_time DESC LIMIT ?",
            (limit,),
        ):
            history.append(
                {
                    "url": row["url"],
                    "title": row["title"] or "",
                    "visit_count": row["visit_count"],
                    "last_visit_at": _chrome_time(row["last_visit_time"]),
                }
            )
        try:
            for row in conn.execute(
                "SELECT d.target_path, d.start_time, d.end_time, d.received_bytes, "
                "d.total_bytes, d.state, "
                "(SELECT c.url FROM downloads_url_chains c WHERE c.id = d.id "
                " ORDER BY c.chain_index LIMIT 1) AS source_url "
                "FROM downloads d ORDER BY d.start_time DESC LIMIT ?",
                (limit,),
            ):
                downloads.append(
                    {
                        "target_path": row["target_path"] or "",
                        "source_url": row["source_url"] or "",
                        "started_at": _chrome_time(row["start_time"]),
                        "completed_at": _chrome_time(row["end_time"]),
                        "received_bytes": row["received_bytes"],
                        "total_bytes": row["total_bytes"],
                        "state": row["state"],
                    }
                )
        except sqlite3.Error:
            pass
    except Exception:
        pass
    finally:
        _close_and_cleanup(conn, tmp_dir)
    return history, downloads


def _firefox_history(path: str, limit: int) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    conn = _sqlite_ro(path)
    history: list[dict[str, Any]] = []
    downloads: list[dict[str, Any]] = []
    if not conn:
        return history, downloads
    tmp_dir = os.path.dirname(conn.execute("PRAGMA database_list").fetchone()[2])
    try:
        for row in conn.execute(
            "SELECT url, title, visit_count, last_visit_date FROM moz_places "
            "ORDER BY last_visit_date DESC LIMIT ?",
            (limit,),
        ):
            history.append(
                {
                    "url": row["url"],
                    "title": row["title"] or "",
                    "visit_count": row["visit_count"],
                    "last_visit_at": _firefox_time(row["last_visit_date"]),
                }
            )
        try:
            for row in conn.execute(
                "SELECT p.url AS destination, a.dateAdded, a.content "
                "FROM moz_annos a JOIN moz_places p ON p.id = a.anno_place_id "
                "WHERE a.anno_attribute_id = "
                "(SELECT id FROM moz_anno_attributes WHERE name LIKE 'downloads%') "
                "ORDER BY a.dateAdded DESC LIMIT ?",
                (limit,),
            ):
                downloads.append(
                    {
                        "target_path": row["content"] or "",
                        "source_url": "",
                        "started_at": _firefox_time(row["dateAdded"]),
                        "completed_at": None,
                        "received_bytes": None,
                        "total_bytes": None,
                        "state": 0,
                        "destination_url": row["destination"] or "",
                    }
                )
        except sqlite3.Error:
            pass
    except sqlite3.Error:
        pass
    finally:
        _close_and_cleanup(conn, tmp_dir)
    return history, downloads


def collect_browser(focus: dict[str, Any], limits: dict[str, Any]) -> dict[str, Any]:
    """Read browser history and downloads. Read-only, on a private copy."""
    max_rows = int(limits.get("max_browser_rows", 200))
    errors: list[str] = []
    browsers: list[dict[str, Any]] = []

    def _record(browser: str, profile: str, history: list, downloads: list) -> None:
        if history or downloads:
            browsers.append(
                {
                    "browser": browser,
                    "profile": profile,
                    "history": history[:max_rows],
                    "downloads": downloads[:max_rows],
                }
            )

    if SYSTEM == "Windows":
        local = os.environ.get("LOCALAPPDATA", "")
        roaming = os.environ.get("APPDATA", "")
        chromium = [
            ("chrome", os.path.join(local, "Google", "Chrome", "User Data")),
            ("edge", os.path.join(local, "Microsoft", "Edge", "User Data")),
            ("brave", os.path.join(local, "BraveSoftware", "Brave-Browser", "User Data")),
            ("opera", os.path.join(roaming, "Opera Software", "Opera Stable")),
        ]
        for name, root in chromium:
            if not root or not os.path.isdir(root):
                continue
            profiles = ["Default"]
            profiles += sorted(
                entry
                for entry in (os.listdir(root) if os.path.isdir(root) else [])
                if entry.startswith("Profile ")
            )
            for profile in profiles:
                history_path = os.path.join(root, profile, "History")
                if not os.path.isfile(history_path):
                    continue
                try:
                    history, downloads = _chrome_history(history_path, max_rows)
                    _record(name, profile, history, downloads)
                except Exception as exc:
                    errors.append(f"{name}/{profile}: {exc}")

        firefox_root = os.path.join(roaming, "Mozilla", "Firefox", "Profiles")
        for places in glob.glob(os.path.join(firefox_root, "*", "places.sqlite")):
            profile = os.path.basename(os.path.dirname(places))
            try:
                history, downloads = _firefox_history(places, max_rows)
                _record("firefox", profile, history, downloads)
            except Exception as exc:
                errors.append(f"firefox/{profile}: {exc}")
    elif SYSTEM in ("Linux", "Darwin"):
        home = os.path.expanduser("~")
        if SYSTEM == "Darwin":
            roots = [
                ("chrome", os.path.join(home, "Library", "Application Support", "Google", "Chrome")),
                ("edge", os.path.join(home, "Library", "Application Support", "Microsoft Edge")),
            ]
        else:
            roots = [
                ("chrome", os.path.join(home, ".config", "google-chrome")),
                ("chrome", os.path.join(home, ".config", "chromium")),
                ("edge", os.path.join(home, ".config", "microsoft-edge")),
            ]
        for name, root in roots:
            if not os.path.isdir(root):
                continue
            for profile in ["Default"] + sorted(
                e for e in os.listdir(root) if e.startswith("Profile ")
            ):
                history_path = os.path.join(root, profile, "History")
                if not os.path.isfile(history_path):
                    continue
                try:
                    history, downloads = _chrome_history(history_path, max_rows)
                    _record(name, profile, history, downloads)
                except Exception as exc:
                    errors.append(f"{name}/{profile}: {exc}")
        for places in glob.glob(os.path.join(home, ".mozilla", "firefox", "*", "places.sqlite")):
            profile = os.path.basename(os.path.dirname(places))
            try:
                history, downloads = _firefox_history(places, max_rows)
                _record("firefox", profile, history, downloads)
            except Exception as exc:
                errors.append(f"firefox/{profile}: {exc}")

    domains = {str(d).lower().rstrip(".") for d in (focus.get("domains") or []) if d}
    focus_hits = 0
    if domains:
        for browser in browsers:
            for entry in browser.get("history", []):
                url = str(entry.get("url", "")).lower()
                if any(domain in url for domain in domains):
                    focus_hits += 1
                    entry["focus"] = True

    return {
        "browsers": browsers,
        "browser_count": len(browsers),
        "focus_hits": focus_hits,
        "errors": errors[:20],
    }


# ---------------------------------------------------------------------------
# 6. System event logs
# ---------------------------------------------------------------------------

# Event IDs are only queried when the log actually exists on the endpoint.
_EVENT_SOURCES = [
    ("Security", [4624, 4625, 4648, 4688, 4697, 4698, 4720, 4732, 4740]),
    ("System", [7045, 7040, 7030]),
    ("Windows PowerShell", [400, 403, 600, 4103, 4104]),
    ("Microsoft-Windows-Sysmon/Operational", [1, 3, 7, 11, 22, 23]),
    ("Microsoft-Windows-Windows Defender/Operational", [1116, 1117, 1006, 1007]),
]


def _collect_events_windows(limits: dict[str, Any]) -> tuple[list[dict[str, Any]], list[str]]:
    max_events = int(limits.get("max_events", 120))
    timeout = int(limits.get("command_timeout", 30))
    per_source = max(5, max_events // len(_EVENT_SOURCES) + 1)
    errors: list[str] = []
    events: list[dict[str, Any]] = []

    plan = [{"log": log, "ids": ids, "max": per_source} for log, ids in _EVENT_SOURCES]
    script = (
        "$ErrorActionPreference='SilentlyContinue';"
        "$plan = " + _json_arg(plan) + " | ConvertFrom-Json;"
        "$out = @();"
        "foreach ($item in $plan) {"
        "  $log = Get-WinEvent -ListLog $item.log -ErrorAction SilentlyContinue;"
        "  if (-not $log) { continue };"
        "  $filter = @{ LogName = $item.log; Id = $item.ids };"
        "  $events = Get-WinEvent -FilterHashtable $filter -MaxEvents ([int]$item.max) "
        "-ErrorAction SilentlyContinue;"
        "  foreach ($e in $events) {"
        "    $msg = '';"
        "    try { $msg = $e.Message } catch {};"
        "    if ($msg.Length -gt 600) { $msg = $msg.Substring(0, 599) };"
        "    $out += [pscustomobject]@{"
        "      log = $item.log; id = $e.Id; time = $e.TimeCreated.ToString('o');"
        "      provider = $e.ProviderName; level = $e.LevelDisplayName; message = $msg;"
        "    };"
        "  }"
        "}"
        "$out | ConvertTo-Json -Compress -Depth 4"
    )
    parsed = _ps_json(script, max(timeout, 60))
    if parsed is None:
        errors.append("event log query failed or returned no data")
    for row in _as_list(parsed):
        row.setdefault("log", "")
        row.setdefault("id", None)
        row.setdefault("message", "")
        events.append(row)

    events.sort(key=lambda e: str(e.get("time") or ""), reverse=True)
    return events[:max_events], errors


def _collect_events_linux(limits: dict[str, Any]) -> tuple[list[dict[str, Any]], list[str]]:
    max_events = int(limits.get("max_events", 120))
    timeout = int(limits.get("command_timeout", 30))
    events: list[dict[str, Any]] = []
    errors: list[str] = []

    raw = _run(
        [
            "journalctl",
            "--no-pager",
            "-o",
            "json",
            "-n",
            str(max_events),
            "--since",
            f"{RECENT_WINDOW_HOURS} hours ago",
        ],
        timeout,
    )
    if not raw:
        return events, ["journalctl unavailable or returned no data"]
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        message = entry.get("MESSAGE")
        if isinstance(message, list):
            message = " ".join(str(part) for part in message)
        events.append(
            {
                "log": entry.get("_SYSTEMD_UNIT") or entry.get("SYSLOG_IDENTIFIER") or "journal",
                "id": None,
                "time": entry.get("__REALTIME_TIMESTAMP"),
                "provider": entry.get("_HOSTNAME", ""),
                "level": entry.get("PRIORITY", ""),
                "message": _truncate(message, 600),
            }
        )
    return events[:max_events], errors


def collect_events(limits: dict[str, Any]) -> dict[str, Any]:
    """Read system/security event logs. Nothing is cleared or acknowledged."""
    if SYSTEM == "Windows":
        events, errors = _collect_events_windows(limits)
    elif SYSTEM == "Linux":
        events, errors = _collect_events_linux(limits)
    else:
        events, errors = [], [f"event log collection unsupported on {SYSTEM}"]
    return {"returned": len(events), "events": events, "errors": errors}


# ---------------------------------------------------------------------------
# 7. Users and sessions
# ---------------------------------------------------------------------------

def collect_users(limits: dict[str, Any]) -> dict[str, Any]:
    """Accounts and interactive sessions relevant to attributing a process."""
    max_rows = int(limits.get("max_users", 50))
    users: list[dict[str, Any]] = []
    errors: list[str] = []

    if SYSTEM == "Windows":
        script = (
            "$ErrorActionPreference='SilentlyContinue';"
            "$out=@();"
            "Get-LocalUser | ForEach-Object { $out += [pscustomobject]@{"
            "  user=$_.Name; enabled=[string]$_.Enabled; detail=[string]$_.Description; source='localuser' } };"
            "try { Get-LocalGroupMember -Group 'Administrators' | ForEach-Object {"
            "  $out += [pscustomobject]@{ user=$_.Name; enabled='True';"
            "    detail='member of Administrators'; source='localgroup' } } } catch {};"
            "$out | ConvertTo-Json -Compress -Depth 3"
        )
        parsed = _ps_json(script)
        if parsed is None:
            errors.append("local user query failed")
        for row in _as_list(parsed):
            row.setdefault("source", "localuser")
            users.append(row)

        session_raw = _run(["query", "user"], 15) or ""
        for line in session_raw.splitlines()[1:]:
            parts = line.split()
            if len(parts) >= 2:
                users.append(
                    {
                        "user": parts[0],
                        "enabled": "True",
                        "detail": _truncate(line, 200),
                        "source": "session",
                    }
                )
    else:
        who = _run(["who"], 10) or ""
        for line in who.splitlines():
            parts = line.split()
            if parts:
                users.append(
                    {
                        "user": parts[0],
                        "enabled": "True",
                        "detail": _truncate(line, 200),
                        "source": "session",
                    }
                )
        for group in ("sudo", "wheel", "admin", "adm"):
            raw = _run(["getent", "group", group], 10)
            if raw and ":" in raw:
                members = raw.strip().split(":", 3)[-1]
                for member in members.split(","):
                    if member.strip():
                        users.append(
                            {
                                "user": member.strip(),
                                "enabled": "True",
                                "detail": f"member of {group}",
                                "source": "localgroup",
                            }
                        )

    seen: set[str] = set()
    unique: list[dict[str, Any]] = []
    for row in users:
        key = f"{row.get('user')}|{row.get('source')}"
        if key in seen:
            continue
        seen.add(key)
        unique.append(row)

    return {"returned": len(unique[:max_rows]), "users": unique[:max_rows], "errors": errors}


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------

SECTION_NAMES = ("processes", "connections", "files", "persistence", "browser", "events", "users")


def collect_forensics(params: dict[str, Any]) -> dict[str, Any]:
    """Run every requested section and return a single evidence bundle.

    ``params`` keys:
      sections   - list of section names to run (default: all)
      focus      - pids / process_names / ips / domains / file_paths / since
      limits     - overrides for DEFAULT_LIMITS
      policy     - {"browser": bool, "eventlog": bool} gates from the server
    """
    limits = dict(DEFAULT_LIMITS)
    limits.update(params.get("limits") or {})
    focus = params.get("focus") or {}
    policy = params.get("policy") or {}
    requested = params.get("sections") or list(SECTION_NAMES)
    requested = [str(name) for name in requested if str(name) in SECTION_NAMES]

    sections: dict[str, Any] = {}
    errors: list[str] = []
    started = time.time()

    def _run_section(name: str, runner) -> None:
        if name not in requested:
            sections[name] = {"skipped": True, "reason": "not_requested"}
            return
        try:
            sections[name] = runner()
        except Exception as exc:
            sections[name] = {"skipped": True, "reason": "error", "error": str(exc)}
            errors.append(f"{name}: {exc}")

    _run_section("processes", lambda: collect_processes(focus, limits))
    _run_section("connections", lambda: collect_connections(focus, limits))
    _run_section("files", lambda: collect_files(focus, limits))
    _run_section("persistence", lambda: collect_persistence(focus, limits))

    if not policy.get("browser", False):
        sections["browser"] = {"skipped": True, "reason": "policy_disabled"}
    else:
        _run_section("browser", lambda: collect_browser(focus, limits))

    if not policy.get("eventlog", False):
        sections["events"] = {"skipped": True, "reason": "policy_disabled"}
    else:
        _run_section("events", lambda: collect_events(limits))

    _run_section("users", lambda: collect_users(limits))

    return {
        "collected_at": _utc_now(),
        "platform": SYSTEM,
        "platform_release": platform.release(),
        "hostname": platform.node(),
        "duration_seconds": round(time.time() - started, 2),
        "read_only": True,
        "focus": focus,
        "sections": sections,
        "errors": errors,
        "partial": bool(errors),
    }
