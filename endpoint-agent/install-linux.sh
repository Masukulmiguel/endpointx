#!/bin/bash
set -e

SERVER_URL="${1:-##SERVER_URL##}"
AGENT_SECRET="${2:-##AGENT_SECRET##}"
INSTALL_DIR="/opt/endpointx-agent"
SERVICE_NAME="endpointx-agent"

echo "========================================="
echo "  EndpointX Agent Installer (Linux)"
echo "========================================="
echo ""

# Check root
if [ "$(id -u)" -ne 0 ]; then
    echo "ERROR: This script must be run as root (use sudo)." >&2
    exit 1
fi

# Check Python 3.8+
echo "[1/7] Checking Python..."
if command -v python3 &>/dev/null; then
    PYTHON=python3
elif command -v python &>/dev/null; then
    PYTHON=python
else
    echo "ERROR: Python 3 not found!" >&2
    echo "Install with: sudo apt install python3 python3-pip (Debian/Ubuntu)" >&2
    echo "          or: sudo dnf install python3 python3-pip (Fedora/RHEL)" >&2
    exit 1
fi

PY_VERSION=$($PYTHON -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
PY_MAJOR=$($PYTHON -c 'import sys; print(sys.version_info.major)')
PY_MINOR=$($PYTHON -c 'import sys; print(sys.version_info.minor)')
if [ "$PY_MAJOR" -lt 3 ] || { [ "$PY_MAJOR" -eq 3 ] && [ "$PY_MINOR" -lt 8 ]; }; then
    echo "ERROR: Python 3.8+ required, found $PY_VERSION" >&2
    exit 1
fi
echo "  Found Python $PY_VERSION ($PYTHON)"

# Check pip
echo "[2/7] Checking pip..."
if ! $PYTHON -m pip --version &>/dev/null; then
    echo "  pip not found, installing..."
    $PYTHON -m ensurepip --upgrade 2>/dev/null || apt-get install -y python3-pip 2>/dev/null || dnf install -y python3-pip 2>/dev/null
fi
echo "  pip OK"

# Create install directory
echo "[3/7] Creating install directory..."
mkdir -p "$INSTALL_DIR"
echo "  Created $INSTALL_DIR"

# Install dependencies
echo "[4/7] Installing dependencies..."
$PYTHON -m pip install --quiet psutil requests pyyaml 2>/dev/null
echo "  Dependencies installed"

# Create config
echo "[5/7] Creating config..."
cat > "$INSTALL_DIR/config.yaml" <<EOF
agent_id: AUTO
agent_secret: ${AGENT_SECRET}
heartbeat_interval: 60
log_file: endpointx-agent.log
log_level: INFO
server_url: ${SERVER_URL}/api
EOF
echo "  Config created"

# Download agent files
echo "[6/7] Downloading agent files..."
BASE_URL="${SERVER_URL}/api"
curl -fsSL "${BASE_URL}/download/public/agent.py" -o "$INSTALL_DIR/agent.py"
curl -fsSL "${BASE_URL}/download/public/system_info.py" -o "$INSTALL_DIR/system_info.py"
curl -fsSL "${BASE_URL}/download/public/requirements.txt" -o "$INSTALL_DIR/requirements.txt"
chmod +x "$INSTALL_DIR/agent.py"
echo "  Agent files downloaded"

# Create systemd service
echo "[7/7] Creating systemd service..."
cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=EndpointX Endpoint Management Agent
After=network.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${PYTHON} ${INSTALL_DIR}/agent.py
WorkingDirectory=${INSTALL_DIR}
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SERVICE_NAME}
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl start "$SERVICE_NAME"

echo ""
echo "========================================="
echo "  Installation complete!"
echo "  Service: ${SERVICE_NAME}"
echo "  Status:  systemctl status ${SERVICE_NAME}"
echo "  Logs:    journalctl -u ${SERVICE_NAME} -f"
echo "========================================="
