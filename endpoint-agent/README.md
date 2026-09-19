# EndpointX Agent

Lightweight endpoint management agent that collects system information, sends periodic heartbeats to the EndpointX server, and executes authorized commands.

## Requirements

- Python 3.9+
- Network access to the EndpointX server
- Administrator/root privileges for full system inventory

## Installation

### Windows

```powershell
# Clone or copy endpoint-agent directory
cd endpoint-agent

# Create virtual environment
python -m venv venv
venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt

# Edit config.yaml with your server URL and agent secret
notepad config.yaml
```

### Linux

```bash
# Clone or copy endpoint-agent directory
cd endpoint-agent

# Create virtual environment
python3 -m venv venv
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Edit config.yaml with your server URL and agent secret
nano config.yaml
```

### macOS

```bash
cd endpoint-agent

python3 -m venv venv
source venv/bin/activate

pip install -r requirements.txt

nano config.yaml
```

## Configuration

Edit `config.yaml` before running the agent:

```yaml
server_url: "https://your-server-endpointx.com/api"  # EndpointX server API URL
agent_secret: "your_agent_secret_here"                # Shared secret for authentication
device_id: ""                                          # Auto-populated after first registration
heartbeat_interval: 60                                 # Seconds between heartbeats
log_level: "INFO"                                      # DEBUG, INFO, WARNING, ERROR
log_file: "endpointx-agent.log"                        # Log file path
tls_verify: true                                       # Verify TLS certificates
```

## Running the Agent

```bash
# Run directly
python agent.py

# Run with custom config
python agent.py -c /path/to/config.yaml

# Print system info and exit
python agent.py --info

# Force re-registration
python agent.py --register

# Show version
python agent.py --version
```

## Service Installation

### Windows Service (using NSSM)

```powershell
# Download NSSM from https://nssm.cc/download
nssm install EndpointXAgent "C:\path\to\venv\Scripts\python.exe" "C:\path\to\endpoint-agent\agent.py"
nssm set EndpointXAgent AppDirectory "C:\path\to\endpoint-agent"
nssm start EndpointXAgent
```

### Linux systemd Service

Create `/etc/systemd/system/endpointx-agent.service`:

```ini
[Unit]
Description=EndpointX Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/endpoint-agent
ExecStart=/opt/endpoint-agent/venv/bin/python agent.py
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable endpointx-agent
sudo systemctl start endpointx-agent

# Check status
sudo systemctl status endpointx-agent

# View logs
sudo journalctl -u endpointx-agent -f
```

### macOS launchd

Create `~/Library/LaunchAgents/com.endpointx.agent.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.endpointx.agent</string>
    <key>ProgramArguments</key>
    <array>
        <string>/opt/endpoint-agent/venv/bin/python</string>
        <string>/opt/endpoint-agent/agent.py</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/opt/endpoint-agent</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/var/log/endpointx-agent.log</string>
    <key>StandardErrorPath</key>
    <string>/var/log/endpointx-agent.log</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.endpointx.agent.plist
launchctl start com.endpointx.agent
```

## Security Notes

- The agent only collects system metrics, installed software, running services, and processes
- It does **not** collect private user data, passwords, keystrokes, cookies, or messages
- All communication uses HTTPS with TLS verification
- Requests are authenticated with a shared secret and HMAC-SHA256 signatures
- Only commands explicitly authorized by the server are executed
- The agent secret must be kept secure and unique per deployment
- Commands like `reboot` and `shutdown` require server authorization

## Supported Commands

| Command | Description |
|---------|-------------|
| `reboot` | Restart the system with optional delay |
| `shutdown` | Shut down the system with optional delay |
| `inventory` | Collect full software/service/process inventory |
| `get_info` | Return detailed system information |
| `update_agent` | Download and apply agent update from server |
| `scan` | Perform basic security scan |

## Troubleshooting

**Agent cannot connect to server**
- Verify `server_url` in config.yaml is correct
- Check network connectivity: `curl -I https://your-server-endpointx.com/api`
- If using self-signed certificates, set `tls_verify: false` (not recommended for production)

**Registration fails**
- Ensure `agent_secret` matches the server configuration
- Check server logs for rejection reasons
- Verify the server endpoint accepts POST requests

**Permission errors on Linux/macOS**
- The agent needs root privileges for full system inventory
- Run with `sudo` or configure the service to run as root

**Agent stops unexpectedly**
- Check the log file (default: `endpointx-agent.log`)
- Verify Python and dependencies are correctly installed
- Ensure the config.yaml is valid YAML

**Viewing logs**
```bash
# Real-time log tail
tail -f endpointx-agent.log

# Search for errors
grep ERROR endpointx-agent.log
```
