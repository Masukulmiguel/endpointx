"""Windows Service wrapper for EndpointX Agent.

Install as Windows Service (requires admin privileges):
  python service.py install
  python service.py start

Or use NSSM (recommended for production):
  nssm install EndpointXAgent "C:\Python39\python.exe" "C:\endpointx\endpoint-agent\service.py"
  nssm set EndpointXAgent AppDirectory "C:\endpointx\endpoint-agent"
  nssm set EndpointXAgent DisplayName "EndpointX Agent"
  nssm set EndpointXAgent Description "EndpointX endpoint management agent"
  nssm set EndpointXAgent Start SERVICE_AUTO_START
  nssm set EndpointXAgent AppStdout "C:\endpointx\endpoint-agent\service-stdout.log"
  nssm set EndpointXAgent AppStderr "C:\endpointx\endpoint-agent\service-stderr.log"
  nssm start EndpointXAgent
"""

import os
import sys
import time
import logging
from pathlib import Path
from datetime import datetime

try:
    import win32serviceutil
    import win32service
    import win32event
    import servicemanager
    HAS_WIN32 = True
except ImportError:
    HAS_WIN32 = False

from agent import EndpointAgent

logger = logging.getLogger("endpointx-service")

# Determine base directory
BASE_DIR = Path(os.environ.get("ENDPOINTX_AGENT_DIR", os.path.dirname(os.path.abspath(__file__))))
LOG_DIR = BASE_DIR
CONFIG_PATH = BASE_DIR / "config.yaml"


class EndpointXService:
    """Windows Service for EndpointX Agent with auto-restart on crash."""

    _svc_name_ = "EndpointXAgent"
    _svc_display_name_ = "EndpointX Agent"
    _svc_description_ = "EndpointX endpoint management agent - monitors and manages endpoints"

    def __init__(self):
        self.agent = None
        self._running = False
        self._max_restart_attempts = 5
        self._restart_delay = 30  # seconds

    def setup_logging(self):
        """Setup logging to both file and Windows Event Log."""
        log_file = LOG_DIR / "service.log"
        handlers = [
            logging.FileHandler(log_file, encoding="utf-8"),
            logging.StreamHandler(),
        ]

        if HAS_WIN32 and hasattr(self, '_is_service') and self._is_service:
            handlers.append(ServiceEventHandler())

        logging.basicConfig(
            level=logging.INFO,
            format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
            handlers=handlers,
        )

    def run(self):
        """Main service loop with auto-restart on crash."""
        self._running = True
        restart_count = 0

        while self._running and restart_count < self._max_restart_attempts:
            try:
                logger.info("Starting EndpointX Agent...")
                self.agent = EndpointAgent(config_path=str(CONFIG_PATH))
                self.agent._running = True
                self.agent._inventory_sent = False
                self.agent._security_sent = False
                self.agent._last_security_check = 0

                logger.info("Agent initialized. Server: %s", self.agent.config.get("server_url"))
                restart_count = 0  # Reset on successful start

                # Main heartbeat loop
                while self._running and self.agent._running:
                    try:
                        response = self.agent.heartbeat()
                        if response:
                            data = response.get("data", {})
                            commands = data.get("commands", [])
                            if commands:
                                logger.info("Received %d command(s)", len(commands))
                            for cmd in commands:
                                try:
                                    self.agent.execute_command(cmd)
                                except Exception as exc:
                                    logger.error("Command error: %s", exc)

                            if not self.agent._inventory_sent:
                                try:
                                    self.agent.send_inventory()
                                    self.agent._inventory_sent = True
                                except Exception as exc:
                                    logger.error("Inventory error: %s", exc)

                            if not self.agent._security_sent:
                                try:
                                    self.agent._send_security_scan()
                                    self.agent._security_sent = True
                                except Exception as exc:
                                    logger.error("Security scan error: %s", exc)

                    except Exception as exc:
                        logger.error("Heartbeat cycle error: %s", exc)

                    interval = self.agent.config.get("heartbeat_interval", 60)
                    # Sleep in 1-second intervals to allow quick shutdown
                    for _ in range(interval):
                        if not self._running:
                            break
                        time.sleep(1)

            except Exception as exc:
                logger.error("Agent crashed: %s", exc)
                restart_count += 1

                if restart_count < self._max_restart_attempts:
                    logger.info("Restarting in %ds (attempt %d/%d)...",
                               self._restart_delay, restart_count, self._max_restart_attempts)
                    time.sleep(self._restart_delay)
                else:
                    logger.critical("Max restart attempts reached. Service stopping.")

        logger.info("EndpointX Service stopped")

    def stop(self):
        """Stop the service."""
        self._running = False
        if self.agent:
            self.agent._running = False


class ServiceEventHandler(logging.Handler):
    """Log handler that writes to Windows Event Log."""
    def emit(self, record):
        try:
            servicemanager.LogMsg(
                servicemanager.EVENTLOG_INFORMATION_TYPE,
                servicemanager.PYS_SERVICE_STARTED,
                ("EndpointXAgent", self.format(record)),
            )
        except Exception:
            pass


class WindowsServiceFramework(win32serviceutil.ServiceFramework):
    """Win32 service framework wrapper."""

    _svc_name_ = "EndpointXAgent"
    _svc_display_name_ = "EndpointX Agent"
    _svc_description_ = "EndpointX endpoint management agent"

    def __init__(self, args):
        win32serviceutil.ServiceFramework.__init__(self, args)
        self.stop_event = win32event.CreateEvent(None, 0, 0, None)
        self.service = EndpointXService()
        self.service._is_service = True

    def SvcStop(self):
        self.ReportServiceStatus(win32service.SERVICE_STOP_PENDING)
        win32event.SetEvent(self.stop_event)
        self.service.stop()

    def SvcDoRun(self):
        servicemanager.LogMsg(
            servicemanager.EVENTLOG_INFORMATION_TYPE,
            servicemanager.PYS_SERVICE_STARTED,
            (self._svc_name_, ""),
        )
        self.service.setup_logging()
        self.service.run()


def install_service():
    """Install the Windows Service using NSSM (recommended) or sc.exe."""
    import subprocess

    service_name = "EndpointXAgent"
    python_path = sys.executable
    script_path = os.path.abspath(__file__)

    print(f"Installing {service_name} Windows Service...")
    print(f"  Python: {python_path}")
    print(f"  Script: {script_path}")

    # Try NSSM first (more reliable)
    nssm_path = None
    for candidate in ["nssm.exe", r"C:\nssm\nssm.exe", r"C:\Program Files\nssm\nssm.exe"]:
        try:
            subprocess.run([candidate, "--version"], capture_output=True, check=True)
            nssm_path = candidate
            break
        except (FileNotFoundError, subprocess.CalledProcessError):
            continue

    if nssm_path:
        print(f"  Using NSSM: {nssm_path}")
        subprocess.run([nssm_path, "stop", service_name], capture_output=True)
        subprocess.run([nssm_path, "remove", service_name, "confirm"], capture_output=True)
        subprocess.run([
            nssm_path, "install", service_name,
            python_path, script_path
        ], check=True)
        subprocess.run([
            nssm_path, "set", service_name, "AppDirectory",
            str(BASE_DIR)
        ], check=True)
        subprocess.run([
            nssm_path, "set", service_name, "DisplayName", "EndpointX Agent"
        ], check=True)
        subprocess.run([
            nssm_path, "set", service_name, "Description",
            "EndpointX endpoint management agent"
        ], check=True)
        subprocess.run([
            nssm_path, "set", service_name, "Start", "SERVICE_AUTO_START"
        ], check=True)
        subprocess.run([
            nssm_path, "set", service_name, "AppStdout",
            str(LOG_DIR / "service-stdout.log")
        ], check=True)
        subprocess.run([
            nssm_path, "set", service_name, "AppStderr",
            str(LOG_DIR / "service-stderr.log")
        ], check=True)
        # Auto-restart on failure
        subprocess.run([
            nssm_path, "set", service_name, "AppExit", "Default", "Restart"
        ], check=True)
        print(f"  Service installed with NSSM. Starting...")
        subprocess.run([nssm_path, "start", service_name])
    else:
        # Fallback to Python's win32serviceutil
        print("  NSSM not found, using Python service installer (less reliable)")
        print("  Installing pywin32 service...")
        win32serviceutil.HandleCommandLine(WindowsServiceFramework, argv=["", "install"])
        subprocess.run(["sc", "config", service_name, "start=", "auto"], check=True)
        subprocess.run(["sc", "failure", service_name, "reset=", "86400", "actions=", "restart/60000/restart/60000/restart/60000"], check=True)
        print(f"  Service installed. Starting...")
        win32serviceutil.HandleCommandLine(WindowsServiceFramework, argv=["", "start"])

    print(f"\n  Service '{service_name}' installed and started!")
    print(f"  Log file: {LOG_DIR / 'service.log'}")


def uninstall_service():
    """Uninstall the Windows Service."""
    import subprocess

    service_name = "EndpointXAgent"

    print(f"Uninstalling {service_name} Windows Service...")

    # Try NSSM first
    nssm_path = None
    for candidate in ["nssm.exe", r"C:\nssm\nssm.exe", r"C:\Program Files\nssm\nssm.exe"]:
        try:
            subprocess.run([candidate, "--version"], capture_output=True, check=True)
            nssm_path = candidate
            break
        except (FileNotFoundError, subprocess.CalledProcessError):
            continue

    if nssm_path:
        subprocess.run([nssm_path, "stop", service_name], capture_output=True)
        subprocess.run([nssm_path, "remove", service_name, "confirm"], capture_output=True)
    else:
        try:
            subprocess.run(["sc", "stop", service_name], capture_output=True)
            time.sleep(2)
            subprocess.run(["sc", "delete", service_name], check=True)
        except subprocess.CalledProcessError:
            win32serviceutil.HandleCommandLine(WindowsServiceFramework, argv=["", "remove"])

    print(f"  Service '{service_name}' uninstalled.")


if __name__ == "__main__":
    if len(sys.argv) == 1 and HAS_WIN32:
        # Running as a service (started by Service Control Manager)
        servicemanager.Initialize()
        servicemanager.PrepareToHostSingle(WindowsServiceFramework)
        servicemanager.StartServiceCtrlDispatcher()
    elif sys.argv[1:] == ["install"]:
        install_service()
    elif sys.argv[1:] == ["uninstall"]:
        uninstall_service()
    elif sys.argv[1:] == ["start"]:
        service = EndpointXService()
        service.setup_logging()
        service.run()
    elif sys.argv[1:] == ["stop"]:
        print("Use 'sc stop EndpointXAgent' or NSSM to stop the service.")
    else:
        win32serviceutil.HandleCommandLine(WindowsServiceFramework)
