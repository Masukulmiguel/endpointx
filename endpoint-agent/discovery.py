"""Cross-platform LAN discovery for the EndpointX agent.

Scans only the agent's own RFC1918 subnets using three sources: the OS
ARP/neighbour table, a budgeted ICMP ping sweep, and reverse DNS. All
parsers are pure functions over captured text so unit tests never touch
the network. Fields that cannot be observed are reported as ``None``
(or ``"Unknown"`` for the OS estimate) — nothing is ever fabricated.
"""

import concurrent.futures
import ipaddress
import platform
import re
import socket
import subprocess
import time

import psutil

# Scan safety caps: at most 4 subnets, prefixlen clamped to <= /22,
# requested ranges larger than a /22 (more than 1024 hosts) rejected.
_MAX_SUBNETS = 4
_PREFIX_CAP = 22
_MIN_SCAN_PREFIXLEN = 22

_IPV4_RE = re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")
_RTT_RE = re.compile(r"time[<=]\s*([\d.]+)\s*ms", re.IGNORECASE)

# One MAC regex per flavour of arp/neigh output.
_MAC_PATTERNS = {
    "proc": r"(?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}",
    "ip-neigh": r"(?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}",
    "darwin": r"(?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}",
    "windows": r"(?:[0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}",
}

_ZERO_MAC = "00:00:00:00:00:00"

# Per-IP round-trip times measured by the latest ping_sweep() run. scan()
# exposes them as hosts[].rtt_ms while ping_sweep keeps its
# (live_ips, truncated) signature.
_rtt_cache: dict = {}


def parse_arp_output(text: str, flavor: str) -> dict:
    """Parse captured ARP/neighbour output into ``{ip: mac | None}``.

    ``flavor`` selects the MAC layout: ``proc`` (/proc/net/arp),
    ``ip-neigh`` (ip neigh show), ``darwin`` (arp -an) or ``windows``
    (arp -a, dash-separated MACs). Each line pairs its first IPv4 address
    with its first MAC address; MACs are lowercased and normalised to
    colon separators. Incomplete entries (zero MAC) map the IP to ``None``;
    lines lacking an IP or a MAC are skipped.
    """
    results: dict = {}
    if not text:
        return results
    mac_re = re.compile(_MAC_PATTERNS.get(flavor, _MAC_PATTERNS["proc"]))
    for line in text.splitlines():
        ip_match = _IPV4_RE.search(line)
        if not ip_match:
            continue
        ip = ip_match.group(0)
        try:
            ipaddress.IPv4Address(ip)
        except ipaddress.AddressValueError:
            continue
        mac_match = mac_re.search(line)
        if mac_match is None:
            continue
        mac = mac_match.group(0).replace("-", ":").lower()
        results[ip] = None if mac == _ZERO_MAC else mac
    return results


def _is_rfc1918(ip) -> bool:
    """True only for 10/8, 172.16/12 and 192.168/16 (no loopback/link-local)."""
    parts = str(ip).split(".")
    if len(parts) != 4:
        return False
    try:
        first, second = int(parts[0]), int(parts[1])
    except ValueError:
        return False
    if first == 10:
        return True
    if first == 192 and second == 168:
        return True
    if first == 172 and 16 <= second <= 31:
        return True
    return False


def _prefix_from_mask(mask: str):
    """Prefix length of a dotted-quad netmask, or None if non-contiguous."""
    try:
        return ipaddress.ip_network(f"0.0.0.0/{mask}", strict=False).prefixlen
    except ValueError:
        return None


def get_local_subnets() -> list:
    """Return the agent's own RFC1918 IPv4 subnets.

    Each entry is ``{ "interface", "cidr", "network", "prefixlen" }``.
    At most 4 subnets; prefixlen is clamped to <= /22.
    """
    subnets: list = []
    try:
        addrs = psutil.net_if_addrs()
    except Exception:
        return []

    for iface_name, iface_addrs in (addrs or {}).items():
        if len(subnets) >= _MAX_SUBNETS:
            break
        for addr in iface_addrs or []:
            try:
                if addr.family != socket.AF_INET:
                    continue
                ip = addr.address
                mask = addr.netmask
                if not ip or not mask or not _is_rfc1918(ip):
                    continue
                prefix = _prefix_from_mask(mask)
                if prefix is None:
                    continue
                if prefix > _PREFIX_CAP:
                    prefix = _PREFIX_CAP
                network = ipaddress.ip_network(f"{ip}/{prefix}", strict=False)
                cidr = str(network)
                if any(s["cidr"] == cidr for s in subnets):
                    continue
                if len(subnets) >= _MAX_SUBNETS:
                    break
                subnets.append(
                    {
                        "interface": iface_name,
                        "cidr": cidr,
                        "network": network.network_address,
                        "prefixlen": network.prefixlen,
                    }
                )
            except Exception:
                continue
    return subnets


def _run_command(cmd: list, timeout: int = 10) -> str:
    """Run a short read-only command; return stdout or '' on any failure."""
    try:
        kwargs = {"capture_output": True, "text": True, "timeout": timeout}
        if platform.system() == "Windows":
            kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        proc = subprocess.run(cmd, **kwargs)
        return proc.stdout or ""
    except Exception:
        return ""


def read_neighbors() -> dict:
    """Return the OS ARP/neighbour table as ``{ip: mac | None}``.

    Source per platform: /proc/net/arp (falling back to `ip neigh show`)
    on Linux, `arp -an` on macOS, `arp -a` on Windows. MACs lowercased.
    """
    system = platform.system()
    try:
        if system == "Linux":
            try:
                with open("/proc/net/arp", "r") as f:
                    parsed = parse_arp_output(f.read(), "proc")
                if parsed:
                    return parsed
            except OSError:
                pass
            return parse_arp_output(_run_command(["ip", "neigh", "show"]), "ip-neigh")
        if system == "Darwin":
            return parse_arp_output(_run_command(["arp", "-an"]), "darwin")
        if system == "Windows":
            return parse_arp_output(_run_command(["arp", "-a"]), "windows")
    except Exception:
        return {}
    return {}


def _parse_rtt(text: str):
    """Extract the ping round-trip time in ms from output, or None."""
    match = _RTT_RE.search(text or "")
    if not match:
        return None
    try:
        return float(match.group(1))
    except ValueError:
        return None


def _ping_host(ip: str) -> tuple:
    """Ping one host once; return (alive, rtt_ms | None)."""
    if platform.system() == "Windows":
        cmd = ["ping", "-n", "1", "-w", "1000", ip]
    else:
        cmd = ["ping", "-c", "1", "-W", "1", ip]
    try:
        kwargs = {"capture_output": True, "text": True, "timeout": 3}
        if platform.system() == "Windows":
            kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        proc = subprocess.run(cmd, **kwargs)
    except Exception:
        return False, None
    if proc.returncode != 0:
        return False, None
    return True, _parse_rtt(proc.stdout)


def ping_sweep(
    cidrs: list, budget_seconds: int = 60, max_inflight: int = 64
) -> tuple:
    """Sweep hosts in ``cidrs`` with one-shot pings.

    Returns ``(live_ips, truncated)``. At most ``max_inflight`` pings run
    concurrently; the sweep stops submitting at the ``budget_seconds``
    deadline and returns partial results with ``truncated=True``.
    Measured round-trip times are recorded in the module's RTT cache for
    scan() to report.
    """
    live: set = set()
    truncated = False

    def _hosts():
        for cidr in cidrs or []:
            try:
                network = ipaddress.ip_network(str(cidr), strict=False)
            except ValueError:
                continue
            for host in network.hosts():
                yield str(host)

    deadline = time.monotonic() + max(0, budget_seconds)
    generator = _hosts()
    exhausted = False
    inflight: dict = {}

    with concurrent.futures.ThreadPoolExecutor(max_workers=max_inflight) as pool:
        while True:
            if time.monotonic() >= deadline:
                truncated = True
                break
            while len(inflight) < max_inflight and not exhausted:
                if time.monotonic() >= deadline:
                    truncated = True
                    exhausted = True
                    break
                try:
                    ip = next(generator)
                except StopIteration:
                    exhausted = True
                    break
                inflight[pool.submit(_ping_host, ip)] = ip
            if not inflight:
                break
            remaining = deadline - time.monotonic()
            done, _ = concurrent.futures.wait(
                inflight,
                timeout=max(0.05, min(1.0, remaining)),
                return_when=concurrent.futures.FIRST_COMPLETED,
            )
            for future in done:
                ip = inflight.pop(future)
                try:
                    alive, rtt = future.result()
                except Exception:
                    alive, rtt = False, None
                if alive:
                    live.add(ip)
                    if rtt is not None:
                        _rtt_cache[ip] = rtt
            if not done and time.monotonic() >= deadline:
                truncated = True
                break
        if truncated:
            for future in inflight:
                future.cancel()

    return live, truncated


def reverse_dns(ip: str, timeout: float = 0.5):
    """Reverse-resolve ``ip`` to a hostname, or None on any failure.

    socket.gethostbyaddr has no timeout argument, so it runs in a
    one-shot thread whose result is awaited for at most ``timeout``.
    """
    if not ip:
        return None
    pool = concurrent.futures.ThreadPoolExecutor(max_workers=1)
    try:
        hostname = pool.submit(socket.gethostbyaddr, ip).result(timeout=timeout)
        return hostname[0] if hostname else None
    except Exception:
        return None
    finally:
        try:
            pool.shutdown(wait=False)
        except Exception:
            pass


def os_estimate(hostname) -> str:
    """Heuristic OS label from a hostname — 'Windows', 'Android',
    'macOS', or 'Unknown'. Never guesses beyond these patterns."""
    if not hostname:
        return "Unknown"
    upper = str(hostname).upper()
    if "ANDROID" in upper:
        return "Android"
    if upper.startswith(("DESKTOP-", "WIN-")) or "NT " in upper:
        return "Windows"
    if "MAC" in upper or "MBP" in upper:
        return "macOS"
    return "Unknown"


def validate_requested_cidr(cidr: str, local_subnets: list):
    """Return an error string if ``cidr`` must not be scanned, else None.

    Rejects malformed input, non-RFC1918 (public/foreign) ranges, ranges
    larger than a /22 (more than 1024 hosts), and ranges not contained in
    one of ``local_subnets``. An empty/blank cidr is accepted.
    """
    raw = (cidr or "").strip()
    if not raw:
        return None
    try:
        network = ipaddress.ip_network(raw, strict=False)
    except ValueError:
        return f"invalid CIDR: {raw!r}"
    if network.version != 4 or not _is_rfc1918(network.network_address):
        return f"{raw} is outside RFC1918 private ranges"
    if network.prefixlen < _MIN_SCAN_PREFIXLEN:
        return f"{raw} exceeds the /22 scan cap (at most 1024 hosts)"
    for entry in local_subnets or []:
        try:
            local = ipaddress.ip_network(str(entry.get("cidr")), strict=False)
        except (AttributeError, TypeError, ValueError):
            continue
        if network.version == local.version and network.subnet_of(local):
            return None
    return f"{raw} is not contained in any local subnet"


def _local_ipv4s() -> set:
    """All non-loopback IPv4 addresses assigned to this machine."""
    ips: set = set()
    try:
        addrs = psutil.net_if_addrs()
    except Exception:
        return ips
    for iface_addrs in (addrs or {}).values():
        for addr in iface_addrs or []:
            try:
                if addr.family == socket.AF_INET and addr.address:
                    if not addr.address.startswith("127."):
                        ips.add(addr.address)
            except Exception:
                continue
    return ips


def _ip_sort_key(ip: str):
    try:
        return (0, int(ipaddress.IPv4Address(ip)))
    except ValueError:
        return (1, 0)


def scan(requested_cidr=None) -> dict:
    """Run full LAN discovery and return a JSON-safe report.

    ``{ "subnets": [cidr...], "truncated": bool, "hosts": [ { "ip",
    "mac", "hostname", "os_estimate", "rtt_ms" } ... ] }``. Hosts are the
    union of the neighbour table and the ping sweep, minus this machine's
    own IPs. Raises ValueError if ``requested_cidr`` fails validation.
    """
    subnets = get_local_subnets()

    if requested_cidr is not None and str(requested_cidr).strip():
        error = validate_requested_cidr(requested_cidr, subnets)
        if error:
            raise ValueError(error)
        scan_cidrs = [str(ipaddress.ip_network(str(requested_cidr).strip(), strict=False))]
    else:
        scan_cidrs = [s["cidr"] for s in subnets]

    try:
        neighbors = read_neighbors() or {}
    except Exception:
        neighbors = {}

    _rtt_cache.clear()
    try:
        live, truncated = ping_sweep(scan_cidrs)
    except Exception:
        live, truncated = set(), True

    ips = (set(neighbors) | set(live)) - _local_ipv4s()

    hosts = []
    for ip in sorted(ips, key=_ip_sort_key):
        mac = neighbors.get(ip)
        hostname = reverse_dns(ip)
        hosts.append(
            {
                "ip": ip,
                "mac": mac.lower() if isinstance(mac, str) else None,
                "hostname": hostname,
                "os_estimate": os_estimate(hostname),
                "rtt_ms": _rtt_cache.get(ip),
            }
        )

    return {"subnets": scan_cidrs, "truncated": bool(truncated), "hosts": hosts}
