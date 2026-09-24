"""Cross-platform system information collector for EndpointX agent.

Collects hardware, software, network, and process information using psutil
and platform-specific tools. Handles Windows, Linux, and macOS.
"""

import os
import platform
import socket
import subprocess
import sys
import time
from typing import Any

import psutil


def get_hostname() -> str:
    """Return the system hostname."""
    return socket.gethostname()


def get_os_info() -> dict[str, Any]:
    """Return operating system details.

    Returns:
        Dictionary with 'type', 'version', and 'build' keys.
    """
    system = platform.system()
    info: dict[str, Any] = {
        "type": system,
        "version": platform.version(),
        "build": platform.platform(),
    }

    if system == "Windows":
        info["edition"] = platform.win32_edition() if hasattr(platform, "win32_edition") else ""
        info["release"] = platform.release()
    elif system == "Linux":
        try:
            import distro

            info["distro"] = distro.name()
            info["distro_version"] = distro.version()
            info["distro_codename"] = distro.codename()
        except ImportError:
            info["distro"] = ""
        info["release"] = platform.release()
    elif system == "Darwin":
        info["release"] = platform.release()
        info["machine"] = platform.machine()

    info["python_version"] = platform.python_version()
    return info


def get_ip_address() -> str:
    """Return the primary network interface IP address."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(2)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        pass

    for iface_name, addrs in psutil.net_if_addrs().items():
        if iface_name == "lo":
            continue
        for addr in addrs:
            if addr.family == socket.AF_INET and not addr.address.startswith("127."):
                return addr.address
    return "0.0.0.0"


def get_mac_address() -> str:
    """Return the primary network interface MAC address."""
    mac = ":".join(f"{(uuid_val := (uuid := __import__("uuid")).getnode() >> i) & 0xFF:02x}" for i in range(0, 48, 8)[::-1])

    stats = psutil.net_if_stats()
    addrs = psutil.net_if_addrs()

    for iface_name in stats:
        if iface_name == "lo" or not stats[iface_name].isup:
            continue
        if iface_name in addrs:
            for addr in addrs[iface_name]:
                if addr.family == psutil.AF_LINK or (hasattr(socket, "AF_LINK") and addr.family == socket.AF_LINK):
                    return addr.address
    return mac


def get_cpu_info() -> dict[str, Any]:
    """Return CPU information.

    Returns:
        Dictionary with 'model', 'cores', and 'usage_percent' keys.
    """
    info: dict[str, Any] = {}

    try:
        with open("/proc/cpuinfo", "r") as f:
            for line in f:
                if line.strip().startswith("model name"):
                    info["model"] = line.split(":")[1].strip()
                    break
    except (FileNotFoundError, OSError):
        if platform.system() == "Windows":
            try:
                import winreg

                key = winreg.OpenKey(
                    winreg.HKEY_LOCAL_MACHINE,
                    r"HARDWARE\DESCRIPTION\System\CentralProcessor\0",
                )
                info["model"], _ = winreg.QueryValueEx(key, "ProcessorNameString")
                winreg.CloseKey(key)
            except Exception:
                info["model"] = platform.processor() or "Unknown"
        elif platform.system() == "Darwin":
            try:
                result = subprocess.run(
                    ["sysctl", "-n", "machdep.cpu.brand_string"],
                    capture_output=True,
                    text=True,
                    timeout=5,
                )
                info["model"] = result.stdout.strip() or "Unknown"
            except Exception:
                info["model"] = "Unknown"
        else:
            info["model"] = platform.processor() or "Unknown"

    info["cores_physical"] = psutil.cpu_count(logical=False) or 0
    info["cores"] = psutil.cpu_count(logical=True) or 0
    info["usage_percent"] = psutil.cpu_percent(interval=1)

    try:
        freq = psutil.cpu_freq()
        if freq:
            info["freq_current"] = freq.current
            info["freq_max"] = freq.max
    except Exception:
        pass

    return info


def get_memory_info() -> dict[str, Any]:
    """Return memory (RAM) information.

    Returns:
        Dictionary with 'total', 'used', 'available', and 'percent' keys in bytes.
    """
    mem = psutil.virtual_memory()
    return {
        "total": mem.total,
        "used": mem.used,
        "available": mem.available,
        "percent": mem.percent,
    }


def get_disk_info() -> dict[str, Any]:
    """Return primary disk usage information.

    Returns:
        Dictionary with 'total', 'used', 'free', and 'percent' keys in bytes.
    """
    if platform.system() == "Windows":
        path = "C:\\"
    else:
        path = "/"

    try:
        usage = psutil.disk_usage(path)
        return {
            "total": usage.total,
            "used": usage.used,
            "free": usage.free,
            "percent": usage.percent,
        }
    except Exception:
        return {"total": 0, "used": 0, "free": 0, "percent": 0}


def get_network_interfaces() -> list[dict[str, Any]]:
    """Return list of network interfaces with their details.

    Returns:
        List of dictionaries with keys: name, mac, ipv4, ipv6, is_connected, speed.
    """
    interfaces: list[dict[str, Any]] = []
    addrs = psutil.net_if_addrs()
    stats = psutil.net_if_stats()

    for iface_name, iface_addrs in addrs.items():
        if iface_name == "lo":
            continue

        info: dict[str, Any] = {
            "name": iface_name,
            "mac": "",
            "ipv4": "",
            "ipv6": "",
            "is_connected": False,
            "speed": 0,
        }

        if iface_name in stats:
            info["is_connected"] = stats[iface_name].isup
            info["speed"] = stats[iface_name].speed

        for addr in iface_addrs:
            if addr.family == socket.AF_INET:
                info["ipv4"] = addr.address
            elif addr.family == socket.AF_INET6:
                if not addr.address.startswith("fe80::"):
                    info["ipv6"] = addr.address
            elif addr.family == psutil.AF_LINK or (hasattr(socket, "AF_LINK") and addr.family == socket.AF_LINK):
                info["mac"] = addr.address

        interfaces.append(info)

    return interfaces


def get_network_traffic() -> dict[str, int]:
    """Return total network traffic counters.

    Returns:
        Dictionary with 'bytes_sent' and 'bytes_recv' keys.
    """
    counters = psutil.net_io_counters()
    return {
        "bytes_sent": counters.bytes_sent,
        "bytes_recv": counters.bytes_recv,
        "packets_sent": counters.packets_sent,
        "packets_recv": counters.packets_recv,
    }


def get_installed_software() -> list[dict[str, Any]]:
    """Return list of installed software.

    Returns:
        List of dictionaries with keys: name, version, publisher, install_date.
    """
    software: list[dict[str, Any]] = []
    system = platform.system()

    if system == "Windows":
        software.extend(_get_installed_software_windows())
    elif system == "Linux":
        software.extend(_get_installed_software_linux())
    elif system == "Darwin":
        software.extend(_get_installed_software_macos())

    return software


def _get_installed_software_windows() -> list[dict[str, Any]]:
    """Query Windows registry for installed software."""
    import winreg

    software: list[dict[str, Any]] = []
    uninstall_keys = [
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"),
        (winreg.HKEY_CURRENT_USER, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
    ]

    for root_key, subkey_path in uninstall_keys:
        try:
            key = winreg.OpenKey(root_key, subkey_path)
        except FileNotFoundError:
            continue

        try:
            i = 0
            while True:
                try:
                    subkey_name = winreg.EnumKey(key, i)
                    subkey = winreg.OpenKey(key, subkey_name)
                    try:
                        name = _registry_value(subkey, "DisplayName")
                        if not name:
                            i += 1
                            continue

                        entry: dict[str, Any] = {
                            "name": name,
                            "version": _registry_value(subkey, "DisplayVersion") or "",
                            "publisher": _registry_value(subkey, "Publisher") or "",
                            "install_date": _registry_value(subkey, "InstallDate") or "",
                        }
                        software.append(entry)
                    except Exception:
                        pass
                    finally:
                        winreg.CloseKey(subkey)
                    i += 1
                except OSError:
                    break
        finally:
            winreg.CloseKey(key)

    return software


def _registry_value(key: Any, name: str) -> str:
    """Read a registry value, returning empty string on failure."""
    import winreg

    try:
        value, _ = winreg.QueryValueEx(key, name)
        return str(value) if value else ""
    except (FileNotFoundError, OSError):
        return ""


def _get_installed_software_linux() -> list[dict[str, Any]]:
    """Query Linux package managers for installed software."""
    software: list[dict[str, Any]] = []

    dpkg_available = os.path.isfile("/usr/bin/dpkg")
    rpm_available = os.path.isfile("/usr/bin/rpm")

    if dpkg_available:
        try:
            result = subprocess.run(
                ["dpkg-query", "-W", "-f", "${Package}\t${Version}\t${Maintainer}\t${Status}\n"],
                capture_output=True,
                text=True,
                timeout=30,
            )
            for line in result.stdout.strip().split("\n"):
                parts = line.split("\t")
                if len(parts) >= 4 and "install ok installed" in parts[3]:
                    software.append({
                        "name": parts[0],
                        "version": parts[1],
                        "publisher": parts[2],
                        "install_date": "",
                    })
        except Exception:
            pass
    elif rpm_available:
        try:
            result = subprocess.run(
                ["rpm", "-qa", "--queryformat", "%{NAME}\t%{VERSION}-%{RELEASE}\t%{VENDOR}\t%{INSTALLTIME:date}\n"],
                capture_output=True,
                text=True,
                timeout=30,
            )
            for line in result.stdout.strip().split("\n"):
                parts = line.split("\t")
                if len(parts) >= 3:
                    software.append({
                        "name": parts[0],
                        "version": parts[1],
                        "publisher": parts[2],
                        "install_date": parts[3] if len(parts) > 3 else "",
                    })
        except Exception:
            pass

    return software


def _get_installed_software_macos() -> list[dict[str, Any]]:
    """Query macOS system for installed applications."""
    software: list[dict[str, Any]] = []
    app_dirs = ["/Applications", os.path.expanduser("~/Applications")]

    for app_dir in app_dirs:
        if not os.path.isdir(app_dir):
            continue

        for item in os.listdir(app_dir):
            if not item.endswith(".app"):
                continue

            app_path = os.path.join(app_dir, item)
            plist_path = os.path.join(app_path, "Contents", "Info.plist")

            entry: dict[str, Any] = {
                "name": item.replace(".app", ""),
                "version": "",
                "publisher": "",
                "install_date": "",
            }

            if os.path.isfile(plist_path):
                try:
                    result = subprocess.run(
                        ["defaults", "read", plist_path, "CFBundleShortVersionString"],
                        capture_output=True,
                        text=True,
                        timeout=5,
                    )
                    entry["version"] = result.stdout.strip()

                    result = subprocess.run(
                        ["defaults", "read", plist_path, "CFBundleIdentifier"],
                        capture_output=True,
                        text=True,
                        timeout=5,
                    )
                    entry["publisher"] = result.stdout.strip()
                except Exception:
                    pass

            try:
                stat = os.stat(app_path)
                entry["install_date"] = time.strftime("%Y%m%d", time.localtime(stat.st_mtime))
            except Exception:
                pass

            software.append(entry)

    return software


def get_running_services() -> list[dict[str, Any]]:
    """Return list of running system services.

    Returns:
        List of dictionaries with keys: name, display_name, status, startup_type.
    """
    services: list[dict[str, Any]] = []
    system = platform.system()

    if system == "Windows":
        services.extend(_get_services_windows())
    elif system == "Linux":
        services.extend(_get_services_linux())
    elif system == "Darwin":
        services.extend(_get_services_macos())

    return services


def _get_services_windows() -> list[dict[str, Any]]:
    """Query Windows services via sc query."""
    services: list[dict[str, Any]] = []
    try:
        result = subprocess.run(
            ["sc", "query", "type=service", "state=all"],
            capture_output=True,
            text=True,
            timeout=30,
            creationflags=subprocess.CREATE_NO_WINDOW if hasattr(subprocess, "CREATE_NO_WINDOW") else 0,
        )
        current: dict[str, Any] = {}
        for line in result.stdout.split("\n"):
            line = line.strip()
            if line.startswith("SERVICE_NAME:"):
                if current:
                    services.append(current)
                current = {"name": line.split(":", 1)[1].strip(), "display_name": "", "status": "", "startup_type": ""}
            elif line.startswith("DISPLAY_NAME:"):
                current["display_name"] = line.split(":", 1)[1].strip()
            elif line.startswith("STATE"):
                state_text = line.split(":", 1)[1].strip()
                current["status"] = state_text.split()[1] if len(state_text.split()) > 1 else state_text
        if current:
            services.append(current)
    except Exception:
        pass

    return services


def _get_services_linux() -> list[dict[str, Any]]:
    """Query Linux systemd services."""
    services: list[dict[str, Any]] = []
    try:
        result = subprocess.run(
            ["systemctl", "list-units", "--type=service", "--all", "--no-pager", "--plain", "--no-legend"],
            capture_output=True,
            text=True,
            timeout=30,
        )
        for line in result.stdout.strip().split("\n"):
            parts = line.split(None, 4)
            if len(parts) >= 4:
                name = parts[0].replace(".service", "")
                status = parts[2]
                display_name = parts[3] if len(parts) > 3 else ""
                services.append({
                    "name": name,
                    "display_name": display_name,
                    "status": status,
                    "startup_type": "",
                })
    except Exception:
        pass

    return services


def _get_services_macos() -> list[dict[str, Any]]:
    """Query macOS launchd services."""
    services: list[dict[str, Any]] = []
    try:
        result = subprocess.run(
            ["launchctl", "list"],
            capture_output=True,
            text=True,
            timeout=15,
        )
        for line in result.stdout.strip().split("\n")[1:]:  # skip header
            parts = line.split(None, 2)
            if len(parts) >= 2:
                pid = parts[0] if parts[0] != "-" else ""
                name = parts[1] if len(parts) > 1 else ""
                label = parts[2] if len(parts) > 2 else name
                services.append({
                    "name": label,
                    "display_name": name,
                    "status": "running" if pid else "stopped",
                    "startup_type": "",
                })
    except Exception:
        pass

    return services


def get_running_processes() -> list[dict[str, Any]]:
    """Return list of running processes.

    Returns:
        List of dictionaries with keys: pid, name, cpu_percent, memory_bytes, user.
    """
    processes: list[dict[str, Any]] = []

    for proc in psutil.process_iter(["pid", "name", "cpu_percent", "memory_info", "username"]):
        try:
            info = proc.info
            processes.append({
                "pid": info["pid"],
                "name": info["name"],
                "cpu_percent": info["cpu_percent"] or 0.0,
                "memory_bytes": info["memory_info"].rss if info["memory_info"] else 0,
                "user": info["username"] or "",
            })
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
            continue

    return processes


_COMMON_OUTBOUND_PORTS = {
    53, 80, 123, 443, 465, 587, 853, 993, 995, 8080, 8443,
}


def _is_private_ip(ip: str) -> bool:
    if not ip:
        return True
    ip = ip.split("%")[0]
    if ip in ("127.0.0.1", "::1", "0.0.0.0"):
        return True
    if ":" in ip:
        return ip.startswith("fe80:") or ip.startswith("fc") or ip.startswith("fd")
    parts = ip.split(".")
    if len(parts) != 4:
        return True
    try:
        a, b = int(parts[0]), int(parts[1])
    except ValueError:
        return True
    if a == 10 or a == 127:
        return True
    if a == 192 and b == 168:
        return True
    if a == 172 and 16 <= b <= 31:
        return True
    if a == 169 and b == 254:
        return True
    return False


def get_suspicious_connections() -> list[dict[str, Any]]:
    """Return outbound connections that look unusual (defensive heuristics only).

    Flags established outbound TCP to public IPs on non-common ports, or
    processes running from temporary/user download locations.
    """
    findings: list[dict[str, Any]] = []
    temp_markers = ("\\temp\\", "/temp/", "\\appdata\\local\\temp", "/tmp/", "\\downloads\\", "/downloads/")

    try:
        conns = psutil.net_connections(kind="inet")
    except (psutil.AccessDenied, PermissionError):
        return findings

    for conn in conns:
        if conn.status != "ESTABLISHED" or not conn.raddr:
            continue
        remote_ip = conn.raddr.ip
        remote_port = conn.raddr.port
        if _is_private_ip(remote_ip):
            continue

        exe = ""
        pid = conn.pid
        if pid:
            try:
                p = psutil.Process(pid)
                exe = p.exe() or p.cmdline()[0] if p.cmdline() else ""
            except (psutil.NoSuchProcess, psutil.AccessDenied, IndexError):
                exe = ""

        suspicious_path = any(m in exe.lower() for m in temp_markers)
        unusual_port = remote_port not in _COMMON_OUTBOUND_PORTS
        if not (suspicious_path or unusual_port):
            continue

        findings.append({
            "local_ip": conn.laddr.ip if conn.laddr else None,
            "local_port": conn.laddr.port if conn.laddr else None,
            "remote_ip": remote_ip,
            "remote_port": remote_port,
            "pid": pid,
            "process": exe or "unknown",
            "reason": "temp_path_process" if suspicious_path else "uncommon_outbound_port",
        })

    return findings[:50]


def get_firewall_status() -> dict[str, Any]:
    """Return firewall status.

    Returns:
        Dictionary with 'enabled' and 'profiles' keys.
    """
    system = platform.system()
    result: dict[str, Any] = {"enabled": False, "profiles": []}

    if system == "Windows":
        try:
            import subprocess

            proc = subprocess.run(
                ["netsh", "advfirewall", "show", "allprofiles"],
                capture_output=True,
                text=True,
                timeout=15,
                creationflags=subprocess.CREATE_NO_WINDOW if hasattr(subprocess, "CREATE_NO_WINDOW") else 0,
            )
            output = proc.stdout
            profiles = ["Domain", "Private", "Public"]
            any_enabled = False
            for profile in profiles:
                if f"State ON" in output and profile.lower() in output.lower():
                    result["profiles"].append({"name": profile, "enabled": True})
                    any_enabled = True
                else:
                    result["profiles"].append({"name": profile, "enabled": False})
            result["enabled"] = any_enabled
        except Exception:
            pass

    elif system == "Linux":
        try:
            proc = subprocess.run(
                ["ufw", "status"],
                capture_output=True,
                text=True,
                timeout=10,
            )
            result["enabled"] = "active" in proc.stdout.lower()
            result["profiles"].append({"name": "ufw", "enabled": result["enabled"]})
        except Exception:
            try:
                proc = subprocess.run(
                    ["firewall-cmd", "--state"],
                    capture_output=True,
                    text=True,
                    timeout=10,
                )
                result["enabled"] = "running" in proc.stdout.lower()
                result["profiles"].append({"name": "firewalld", "enabled": result["enabled"]})
            except Exception:
                pass

    elif system == "Darwin":
        try:
            proc = subprocess.run(
                ["/usr/libexec/ApplicationFirewall/socketfilterfw", "--getglobalstate"],
                capture_output=True,
                text=True,
                timeout=10,
            )
            result["enabled"] = "enabled" in proc.stdout.lower()
            result["profiles"].append({"name": "Application Firewall", "enabled": result["enabled"]})
        except Exception:
            pass

    return result


def get_antivirus_status() -> dict[str, Any]:
    """Return antivirus status.

    Returns:
        Dictionary with 'name', 'enabled', and 'definitions_date' keys.
    """
    system = platform.system()
    result: dict[str, Any] = {"name": "", "enabled": False, "definitions_date": ""}

    if system == "Windows":
        try:
            import subprocess

            proc = subprocess.run(
                ["powershell", "-Command",
                 "Get-MpComputerStatus | Select-Object -Property AMServiceEnabled, AntivirusEnabled, AntivirusSignatureLastUpdated"],
                capture_output=True,
                text=True,
                timeout=20,
                creationflags=subprocess.CREATE_NO_WINDOW if hasattr(subprocess, "CREATE_NO_WINDOW") else 0,
            )
            for line in proc.stdout.strip().split("\n"):
                line = line.strip()
                if "True" in line or "False" in line:
                    parts = [p.strip() for p in line.split() if p.strip()]
                    if len(parts) >= 3:
                        result["enabled"] = parts[0] == "True" or parts[1] == "True"
                        result["definitions_date"] = parts[2] if len(parts) > 2 else ""
                        break
            result["name"] = "Windows Defender"
        except Exception:
            pass

    elif system == "Linux":
        try:
            proc = subprocess.run(
                ["clamscan", "--version"],
                capture_output=True,
                text=True,
                timeout=5,
            )
            result["name"] = "ClamAV"
            result["enabled"] = proc.returncode == 0
        except FileNotFoundError:
            result["name"] = "None detected"

    return result


def get_system_uptime() -> float:
    """Return system uptime in seconds."""
    return time.time() - psutil.boot_time()


def get_pending_updates() -> list[dict[str, Any]]:
    """Return list of pending system updates.

    Returns:
        List of dictionaries with 'name' and 'version' keys.
    """
    system = platform.system()
    updates: list[dict[str, Any]] = []

    if system == "Windows":
        try:
            import subprocess

            proc = subprocess.run(
                ["powershell", "-Command",
                 "(New-Object -ComObject Microsoft.Update.Session).CreateUpdateSearcher().Search('IsInstalled=0').Updates | Select-Object Title, Identity | ForEach-Object { $_.Title + '|' + $_.Identity.UpdateID }"],
                capture_output=True,
                text=True,
                timeout=60,
                creationflags=subprocess.CREATE_NO_WINDOW if hasattr(subprocess, "CREATE_NO_WINDOW") else 0,
            )
            for line in proc.stdout.strip().split("\n"):
                if "|" in line:
                    parts = line.rsplit("|", 1)
                    updates.append({
                        "name": parts[0].strip(),
                        "version": parts[1].strip() if len(parts) > 1 else "",
                    })
        except Exception:
            pass

    elif system == "Linux":
        try:
            proc = subprocess.run(
                ["apt-get", "-s", "upgrade"],
                capture_output=True,
                text=True,
                timeout=60,
            )
            for line in proc.stdout.split("\n"):
                if line.startswith("Inst "):
                    parts = line.split()
                    if len(parts) >= 2:
                        updates.append({
                            "name": parts[1],
                            "version": parts[2].strip("[]") if len(parts) > 2 else "",
                        })
        except Exception:
            pass

    return updates


def collect_all_system_info() -> dict[str, Any]:
    """Collect all available system information.

    Returns:
        Complete system information dictionary.
    """
    return {
        "hostname": get_hostname(),
        "os": get_os_info(),
        "ip_address": get_ip_address(),
        "mac_address": get_mac_address(),
        "cpu": get_cpu_info(),
        "memory": get_memory_info(),
        "disk": get_disk_info(),
        "network_interfaces": get_network_interfaces(),
        "network_traffic": get_network_traffic(),
        "uptime_seconds": get_system_uptime(),
        "firewall": get_firewall_status(),
        "antivirus": get_antivirus_status(),
    }


def collect_inventory() -> dict[str, Any]:
    """Collect full system inventory including software, services, and processes.

    Returns:
        Inventory dictionary with software, services, processes, and pending updates.
    """
    return {
        "installed_software": get_installed_software(),
        "running_services": get_running_services(),
        "running_processes": get_running_processes(),
        "pending_updates": get_pending_updates(),
    }
