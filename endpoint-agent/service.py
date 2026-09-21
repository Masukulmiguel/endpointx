"""Windows Service wrapper for EndpointX Agent."""

import sys
import time
import logging
import win32serviceutil
import win32service
import win32event
import servicemanager

from agent import EndpointAgent

logger = logging.getLogger("endpointx-service")


class EndpointXService(win32serviceutil.ServiceFramework):
    _svc_name_ = "EndpointXAgent"
    _svc_display_name_ = "EndpointX Agent"
    _svc_description_ = "EndpointX endpoint management agent"

    def __init__(self, args):
        win32serviceutil.ServiceFramework.__init__(self, args)
        self.stop_event = win32event.CreateEvent(None, 0, 0, None)
        self.agent = None

    def SvcStop(self):
        self.ReportServiceStatus(win32service.SERVICE_STOP_PENDING)
        win32event.SetEvent(self.stop_event)
        if self.agent:
            self.agent._running = False

    def SvcDoRun(self):
        servicemanager.LogMsg(
            servicemanager.EVENTLOG_INFORMATION_TYPE,
            servicemanager.PYS_SERVICE_STARTED,
            (self._svc_name_, ""),
        )
        self.main()

    def main(self):
        logging.basicConfig(
            filename="C:\\endpointx\\endpoint-agent\\service.log",
            level=logging.INFO,
            format="%(asctime)s [%(levelname)s] %(message)s",
        )

        logger.info("EndpointX Service starting...")

        self.agent = EndpointAgent(
            config_path="C:\\endpointx\\endpoint-agent\\config.yaml"
        )
        self.agent._running = True
        self.agent._inventory_sent = False

        logger.info("EndpointX Service running...")

        while self.agent._running:
            try:
                response = self.agent.heartbeat()
                if response:
                    data = response.get("data", {})
                    commands = data.get("commands", [])
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
            except Exception as exc:
                logger.error("Heartbeat error: %s", exc)

            interval = self.agent.config.get("heartbeat_interval", 60)
            result = win32event.WaitForSingleObject(self.stop_event, interval * 1000)
            if result == win32event.WAIT_OBJECT_0:
                break

        logger.info("EndpointX Service stopped")


if __name__ == "__main__":
    if len(sys.argv) == 1:
        servicemanager.Initialize()
        servicemanager.PrepareToHostSingle(EndpointXService)
        servicemanager.StartServiceCtrlDispatcher()
    else:
        win32serviceutil.HandleCommandLine(EndpointXService)
