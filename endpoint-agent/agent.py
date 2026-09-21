"""EndpointX agent - lightweight service for endpoint management.

Collects system information, sends heartbeats to the server, and executes
authorized commands. Runs on Windows, Linux, and macOS.
"""

import argparse
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


class EndpointAgent:
    """Main agent class that manages registration, heartbeat, and command execution."""

    def __init__(self, config_path: Optional[str] = None) -> None:
        self.config_path = Path(config_path) if config_path else CONFIG_PATH
        self.config: dict[str, Any] = {}
        self.session = requests.Session()
        self._running = False
        self._load_config()
        self._setup_logging()
        self._setup_signals()

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
        """Send a heartbeat with system metrics and receive pending commands."""
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
            }

            resp = self._make_request("POST", "/devices/heartbeat", payload)
            if resp is None:
                return None

            if resp.status_code == 200:
                return resp.json()
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
            return None

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

        def _do_reboot() -> None:
            time.sleep(delay)
            if platform.system() == "Windows":
                subprocess.run(["shutdown", "/r", "/t", "0"], check=False)
            else:
                subprocess.run(["sudo", "reboot"], check=False)

        import threading
        timer = threading.Thread(target=_do_reboot, daemon=True)
        timer.start()
        return {"message": f"System will reboot in {delay} seconds"}

    def handle_shutdown(self, params: dict[str, Any]) -> dict[str, Any]:
        delay = params.get("delay", 5)
        logger.warning("Shutdown command received, delay=%ds", delay)

        def _do_shutdown() -> None:
            time.sleep(delay)
            if platform.system() == "Windows":
                subprocess.run(["shutdown", "/s", "/t", "0"], check=False)
            else:
                subprocess.run(["sudo", "shutdown", "-h", "now"], check=False)

        import threading
        timer = threading.Thread(target=_do_shutdown, daemon=True)
        timer.start()
        return {"message": f"System will shut down in {delay} seconds"}

    def handle_lock(self, params: dict[str, Any]) -> dict[str, Any]:
        logger.warning("Lock screen command received")
        if platform.system() == "Windows":
            subprocess.run(["rundll32.exe", "user32.dll,LockWorkStation"], check=False)
        else:
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
        return {"message": "Update not yet implemented"}

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
                "description": f"{len(high_cpu)} processes with high CPU usage",
                "details": [p["name"] for p in high_cpu[:10]],
            })

        scan_results["findings_count"] = len(scan_results["findings"])
        return scan_results

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

    def run(self) -> None:
        global _SHUTDOWN_REQUESTED

        logger.info("EndpointX agent starting...")
        logger.info("Server: %s", self.config["server_url"])
        logger.info("Heartbeat interval: %ds", self.config["heartbeat_interval"])

        self._running = True
        self._inventory_sent = False

        if not self.config.get("agent_id"):
            logger.info("No agent_id found, attempting registration...")
            if not self.register():
                logger.error("Initial registration failed. Will retry on heartbeat.")

        logger.info("Entering heartbeat loop...")
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
            except Exception as exc:
                logger.error("Heartbeat cycle error: %s", exc)

            interval = self.config.get("heartbeat_interval", 60)
            for _ in range(interval):
                if _SHUTDOWN_REQUESTED or not self._running:
                    break
                time.sleep(1)

        logger.info("EndpointX agent stopped")


def main() -> None:
    parser = argparse.ArgumentParser(description="EndpointX Agent")
    parser.add_argument("-c", "--config", default=None, help="Path to config file")
    parser.add_argument("--register", action="store_true", help="Force registration and exit")
    parser.add_argument("--info", action="store_true", help="Print system info and exit")
    parser.add_argument("--version", action="store_true", help="Print version and exit")
    args = parser.parse_args()

    if args.version:
        print("EndpointX Agent v1.0.0")
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
        with open("crash.log", "w") as f:
            f.write(traceback.format_exc())
