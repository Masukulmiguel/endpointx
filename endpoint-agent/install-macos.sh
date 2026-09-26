#!/bin/bash
set -e

SERVER_URL="${1:-##SERVER_URL##}"
AGENT_SECRET="${2:-##AGENT_SECRET##}"
ENROLL_TOKEN="##ENROLL_TOKEN##"
INSTALL_DIR="$HOME/endpointx-agent"
PLIST_NAME="com.endpointx.agent"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_NAME}.plist"

BX_WIDTH=46
BX_CYAN=$'\033[36m'
BX_GRAY=$'\033[90m'
BX_DARK=$'\033[2m'
BX_RESET=$'\033[0m'

bx_line() {
    local text="$1" color="${2:-}"
    local pad=$(( BX_WIDTH - ${#text} ))
    if [ "$pad" -lt 0 ]; then pad=0; fi
    local left=$(( pad / 2 ))
    local right=$(( pad - left ))
    printf '%s  |%*s%s%*s|%s\n' "$color" "$left" "" "$text" "$right" "" "$BX_RESET"
}

bx_banner() {
    local logo bar line logo_w=0
    logo=$(cat <<'EOF'
                          \     /
                           \   /
                            \ /
 .---------.               .----.
/           \  .-------.   (  o )
|           |  /       \___|    |
|           |..|       |   \    /
|           |  \       /   '----'
\           /  '-------'
 '---------'    /  |  \
               /   |   \
              /    |    \
EOF
)
    while IFS= read -r line; do
        if [ ${#line} -gt "$logo_w" ]; then logo_w=${#line}; fi
    done <<< "$logo"
    bar=$(printf '%*s' "$BX_WIDTH" '' | tr ' ' '-')
    printf '%s  +%s+%s\n' "$BX_DARK" "$bar" "$BX_RESET"
    while IFS= read -r line; do
        bx_line "$(printf '%-*s' "$logo_w" "$line")" "$BX_CYAN"
    done <<< "$logo"
    bx_line "$bar" "$BX_DARK"
    bx_line 'E N D P O I N T X' "$BX_CYAN"
    bx_line 'AGENT INSTALLER (MACOS)  v1.1.0' "$BX_GRAY"
    bx_line "$SERVER_URL" "$BX_DARK"
    printf '%s  +%s+%s\n' "$BX_DARK" "$bar" "$BX_RESET"
    echo ""
    echo "${BX_GRAY}  The EndpointX agent will run as a background launchd service.${BX_RESET}"
    echo ""
}

bx_banner

# Check not root
if [ "$(id -u)" -eq 0 ]; then
    echo "ERROR: Do not run this script as root." >&2
    echo "Run as a normal user with sudo when prompted." >&2
    exit 1
fi

# Check Python 3.8+
echo "[1/7] Checking Python..."
PYTHON=""
if command -v python3 &>/dev/null; then
    PYTHON=python3
elif command -v python &>/dev/null; then
    # Check if 'python' is Python 3
    PY_VER=$(python -c 'import sys; print(sys.version_info.major)' 2>/dev/null || echo "0")
    if [ "$PY_VER" = "3" ]; then
        PYTHON=python
    fi
fi

if [ -z "$PYTHON" ]; then
    echo "ERROR: Python 3 not found!" >&2
    echo "Install with: brew install python3" >&2
    echo "  or download from: https://www.python.org/downloads/" >&2
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
    $PYTHON -m ensurepip --upgrade 2>/dev/null || brew install pip 2>/dev/null
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
enroll_token: ${ENROLL_TOKEN}
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

# Create launchd plist
echo "[7/7] Creating launchd service..."
PYTHON_PATH=$($PYTHON -c 'import sys; print(sys.executable)')

mkdir -p "$HOME/Library/LaunchAgents"

cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PLIST_NAME}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${PYTHON_PATH}</string>
        <string>${INSTALL_DIR}/agent.py</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${INSTALL_DIR}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${INSTALL_DIR}/agent-stdout.log</string>
    <key>StandardErrorPath</key>
    <string>${INSTALL_DIR}/agent-stderr.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PYTHONUNBUFFERED</key>
        <string>1</string>
    </dict>
</dict>
</plist>
EOF

# Unload if already loaded, then load
launchctl bootout "gui/$(id -u)/${PLIST_NAME}" 2>/dev/null || true
sleep 1
launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"

echo ""
echo "========================================="
echo "  Installation complete!"
echo "  Plist:   ${PLIST_PATH}"
echo "  Logs:    tail -f ${INSTALL_DIR}/agent-stdout.log"
echo "  Stop:    launchctl bootout gui/\$(id -u)/${PLIST_NAME}"
echo "  Start:   launchctl bootstrap gui/\$(id -u) ${PLIST_PATH}"
echo "========================================="
