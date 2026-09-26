# EndpointX

<p align="center">
  <img src="logotipo-fundo-branco.png" alt="EndpointX Logo" width="200"/>
</p>

**Identity, Access, and Endpoint Management Platform**

EndpointX is a comprehensive IAM + EPM platform designed for managing authorized devices within an enterprise network. It provides real-time device monitoring, command execution, and security event tracking through a centralized admin dashboard.

## Features

### Core Features

- **Real-Time Device Monitoring** — Track device status, CPU, RAM, disk, and network metrics in real-time
- **Command Execution** — Send and execute commands on remote devices with full output capture
- **Security Event Tracking** — Monitor and respond to security events across your device fleet
- **Alert Management** — Get notified of critical events with severity-based alerting
- **Audit Logging** — Immutable audit trail for all system actions

### Access Control

- **Role-Based Access Control (RBAC)** — 4 default roles with 20+ granular permissions
- **JWT Authentication** — Secure token-based authentication with refresh tokens
- **Multi-Factor Authentication** — TOTP-based MFA support (optional)
- **Session Management** — Secure session handling with automatic expiry

### Agent Capabilities

- **Cross-Platform Agent** — Windows Service with auto-restart on crash
- **Periodic Heartbeats** — Configurable health check intervals
- **Command Queue** — Offline command queuing with automatic execution
- **Auto-Update** — Agent can update itself from server

### Dashboard

- **Responsive Design** — Works on desktop, tablet, and mobile
- **Dark Mode** — Eye-friendly dark interface
- **Real-Time Updates** — Live data via WebSocket connections
- **RBAC-Aware UI** — UI adapts to user permissions

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Admin Dashboard │────▶│   Backend API   │────▶│    PostgreSQL   │
│  (React/Vite)   │     │  (Node.js/Express) │    │     Database    │
└─────────────────┘     └────────┬────────┘     └─────────────────┘
                                 │
                     ┌───────────┼───────────┐
                     │           │           │
               ┌─────┴─────┐ ┌──┴──┐ ┌─────┴─────┐
               │  Device 1  │ │Dev 2│ │  Device N  │
               │  (Agent)   │ │(Agnt)│ │  (Agent)   │
               └───────────┘ └─────┘ └───────────┘
```

| Component    | Technology                              |
| ------------ | --------------------------------------- |
| Dashboard    | React 18, TypeScript, Vite, Tailwind   |
| Backend API  | Node.js, Express, TypeScript, Socket.IO |
| Database     | PostgreSQL 16                           |
| Agent        | Python 3.9+, psutil                     |

## Quick Start

### Prerequisites

- Docker 24.0+ and Docker Compose 2.20+
- Git

### Installation

```bash
# Clone the repository
git clone https://github.com/Masukulmiguel/endpointx.git
cd endpointx

# Create .env file with strong secrets
cat > .env << EOF
NODE_ENV=development
DB_HOST=localhost
DB_PORT=5432
DB_NAME=endpointx
DB_USER=endpointx
DB_PASSWORD=$(openssl rand -hex 16)
JWT_SECRET=$(openssl rand -hex 32)
JWT_REFRESH_SECRET=$(openssl rand -hex 32)
AGENT_SECRET=$(openssl rand -hex 32)
EOF

# Start services
docker compose up -d

# Access the dashboard
open http://localhost:5173
```

### First-run Admin Account

The admin account (`admin@endpointx.local`) is created on first startup from the
`SEED_ADMIN_PASSWORD` environment variable (min 12 chars). No default password is
stored in this repository — see [.env.example](.env.example).

## Configuration

### Environment Variables

| Variable              | Required | Description                         |
| --------------------- | -------- | ----------------------------------- |
| `NODE_ENV`            | Yes      | Environment mode                    |
| `PORT`                | No       | API server port (default: 3001)     |
| `DB_HOST`             | Yes      | PostgreSQL host                     |
| `DB_PORT`             | No       | PostgreSQL port (default: 5432)     |
| `DB_NAME`             | Yes      | PostgreSQL database name            |
| `DB_USER`             | Yes      | PostgreSQL user                     |
| `DB_PASSWORD`         | Yes      | PostgreSQL password                 |
| `JWT_SECRET`          | Yes      | JWT signing secret (min 32 chars)   |
| `JWT_REFRESH_SECRET`  | Yes      | JWT refresh token secret            |
| `AGENT_SECRET`        | Yes      | Shared secret for agent auth (min 32 chars) |

See [Environment Configuration](docs/deployment.md#environment-configuration) for the full list.

## API Documentation

Complete REST API documentation is available at [docs/api.md](docs/api.md).

### Quick Reference

| Method  | Endpoint                    | Description              |
| ------- | --------------------------- | ------------------------ |
| POST    | `/api/auth/login`           | Authenticate user        |
| POST    | `/api/auth/invite`          | Invite new user (admin)  |
| GET     | `/api/devices`              | List all devices         |
| POST    | `/api/devices/register`     | Register new device      |
| POST    | `/api/devices/heartbeat`    | Send device heartbeat    |
| POST    | `/api/commands`             | Create command           |
| GET     | `/api/dashboard/overview`   | Dashboard statistics     |

## Agent Installation

### Option 1: Install via PowerShell (Recommended)

```powershell
irm https://your-server.com/api/devices/public/install.ps1 | iex
```

### Option 2: Install on Linux (one line)

```bash
curl -fsSL https://your-server.com/api/devices/public/install-linux.sh | sudo bash
```

### Option 3: Install on macOS (one line)

```bash
curl -fsSL https://your-server.com/api/devices/public/install-macos.sh | bash
```

### Option 4: Install as Windows Service (Production)

```powershell
# Install agent files
Set-Location "C:\endpointx\endpoint-agent"
pip install -r requirements.txt

# Install as Windows Service (requires admin)
python service.py install

# Start the service
python service.py start
```

### Option 5: Install via Git

```bash
cd C:\
git clone https://github.com/Masukulmiguel/endpointx.git
cd endpointx\endpoint-agent
pip install -r requirements.txt
python agent.py --register
python agent.py
```

### Update Agent

```powershell
Stop-Process -Name pythonw -Force -ErrorAction SilentlyContinue
Set-Location "C:\endpointx\endpoint-agent"
Invoke-WebRequest -Uri "https://raw.githubusercontent.com/Masukulmiguel/endpointx/main/endpoint-agent/agent.py" -OutFile "agent.py"
Start-Process -FilePath "wscript.exe" -ArgumentList "C:\endpointx\endpoint-agent\start_agent.vbs"
```

## Default Credentials

Provisioned at first deployment from `SEED_ADMIN_PASSWORD` — intentionally not
stored in this repository.

## Development Setup

### Prerequisites

- Node.js 20 LTS
- PostgreSQL 16
- Python 3.9+ (for agent development)

### Backend

```bash
cd backend-api
npm install
cp .env.example .env
# Edit .env with your database credentials
npm run dev
```

### Dashboard

```bash
cd admin-dashboard
npm install
npm run dev
```

### Agent

```bash
cd endpoint-agent
pip install -r requirements.txt
python agent.py
```

### Project Structure

```
endpointx/
├── backend-api/           # Node.js API server
│   ├── src/
│   │   ├── routes/        # Express route handlers
│   │   ├── middleware/     # Auth, RBAC, validation
│   │   ├── controllers/   # Business logic
│   │   └── utils/         # Helper functions
│   └── package.json
├── admin-dashboard/       # React frontend
│   ├── src/
│   │   ├── components/    # Reusable UI components
│   │   ├── pages/         # Route pages
│   │   ├── contexts/      # React contexts
│   │   ├── services/      # API client
│   │   └── types/         # TypeScript types
│   └── package.json
├── endpoint-agent/        # Python endpoint agent
│   ├── agent.py           # Main agent script
│   ├── system_info.py     # System information collector
│   ├── config.yaml        # Agent configuration
│   └── requirements.txt
├── docs/                  # Documentation
│   ├── INSTALL-GUIDE.md   # Agent installation guide
│   ├── api.md             # API documentation
│   ├── architecture.md    # System design
│   ├── security.md        # Security mechanisms
│   └── deployment.md      # Deployment guide
└── docker-compose.yml
```

## Roadmap & Contributing

We are building **v1.2.0** — reliable observability for endpoints (threshold alerting, notifications, metric retention, deeper HERMES).

| Document | Description |
| -------- | ----------- |
| [Roadmap](ROADMAP.md) | v1.2.0 milestones, status vs Zabbix-like tools, how to pick up tasks |
| [Contributing](CONTRIBUTING.md) | Dev setup, conventions, PR checklist |

## Documentation

| Document          | Description                           |
| ----------------- | ------------------------------------- |
| [Installation Guide](docs/INSTALL-GUIDE.md) | Agent installation guide |
| [Architecture](docs/architecture.md) | System design and components |
| [API Reference](docs/api.md)         | Complete REST API documentation |
| [Security](docs/security.md)         | Security mechanisms and policies |
| [Deployment](docs/deployment.md)     | Installation and configuration guide |

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

```
MIT License

Copyright (c) 2026 EndpointX

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Security Reporting

If you discover a security vulnerability, please report it responsibly:

- **Email**: security@endpointx.example.com
- **Response Time**: Within 48 hours

**Do NOT open public GitHub issues for security vulnerabilities.**

See our [Security Policy](SECURITY.md) for more details.
