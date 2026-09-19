# EndpointX

<p align="center">
  <img src="logotipo.png" alt="EndpointX Logo" width="200"/>
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

- **Cross-Platform** — Windows, Linux, and macOS support
- **HMAC-SHA256 Signing** — Cryptographic request verification
- **Periodic Heartbeats** — Configurable health check intervals
- **Command Queue** — Offline command queuing with automatic execution
- **Encrypted Credentials** — Local credential storage with AES-256 encryption

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
                          ┌──────┴──────┐
                          │    Redis    │
                          │   Cache     │
                          └─────────────┘
                                 │
                    ┌────────────┼────────────┐
                    │            │            │
              ┌─────┴─────┐ ┌───┴───┐ ┌─────┴─────┐
              │  Device 1  │ │  Dev 2 │ │  Device N  │
              │  (Agent)   │ │ (Agent)│ │  (Agent)   │
              └───────────┘ └────────┘ └───────────┘
```

| Component    | Technology                              |
| ------------ | --------------------------------------- |
| Dashboard    | React 18, TypeScript, Vite, Tailwind   |
| Backend API  | Node.js, Express, TypeScript, Socket.IO |
| Database     | PostgreSQL 16, Redis 7                  |
| Agent        | Python 3.9+, psutil, cryptography       |

## Quick Start

### Prerequisites

- Docker 24.0+ and Docker Compose 2.20+
- Git

### Installation

```bash
# Clone the repository
git clone https://github.com/Masukulmiguel/endpointx.git
cd endpointx

# Create environment file
cp .env.example .env

# Generate secrets
sed -i "s/JWT_SECRET=.*/JWT_SECRET=$(openssl rand -hex 32)/" .env
sed -i "s/AGENT_SECRET=.*/AGENT_SECRET=$(openssl rand -hex 32)/" .env
sed -i "s/ENCRYPTION_KEY=.*/ENCRYPTION_KEY=$(openssl rand -hex 32)/" .env
sed -i "s/POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$(openssl rand -hex 16)/" .env
sed -i "s/REDIS_PASSWORD=.*/REDIS_PASSWORD=$(openssl rand -hex 16)/" .env

# Start services
docker compose up -d

# Initialize database
docker compose exec api npx knex migrate:latest
docker compose exec api npx knex seed:run

# Access the dashboard
open http://localhost
```

### Default Credentials

| Email                 | Password      | Role  |
| --------------------- | ------------- | ----- |
| admin@endpointx.local | Admin@123!    | admin |

> **IMPORTANT**: Change the default admin password immediately after first login.

## Configuration

### Environment Variables

| Variable              | Required | Description                         |
| --------------------- | -------- | ----------------------------------- |
| `NODE_ENV`            | Yes      | Environment mode                    |
| `PORT`                | No       | API server port (default: 3001)     |
| `DATABASE_URL`        | Yes      | PostgreSQL connection string        |
| `REDIS_URL`           | Yes      | Redis connection string             |
| `JWT_SECRET`          | Yes      | JWT signing secret (min 32 chars)   |
| `AGENT_SECRET`        | Yes      | Shared secret for agent auth        |
| `ENCRYPTION_KEY`      | Yes      | AES-256 encryption key              |

See [Environment Configuration](docs/deployment.md#environment-configuration) for the full list.

## API Documentation

Complete REST API documentation is available at [docs/api.md](docs/api.md).

### Quick Reference

| Method  | Endpoint                    | Description              |
| ------- | --------------------------- | ------------------------ |
| POST    | `/api/auth/login`           | Authenticate user        |
| POST    | `/api/auth/register`        | Register new user        |
| GET     | `/api/devices`              | List all devices         |
| POST    | `/api/devices/register`     | Register new device      |
| POST    | `/api/devices/heartbeat`    | Send device heartbeat    |
| POST    | `/api/commands`             | Create command           |
| GET     | `/api/dashboard/overview`   | Dashboard statistics     |

## Agent Installation

### Option 1: Install via Git (Recommended)

```bash
# Install Git (if not installed)
# Download from: https://git-scm.com/download/win

# Clone the repository
cd C:\
git clone https://github.com/Masukulmiguel/endpointx.git

# Install dependencies
cd endpointx\endpoint-agent
pip install -r requirements.txt

# Register and run
python agent.py --register
python agent.py
```

### Option 2: Install via Copy

See [INSTALL-GUIDE.md](docs/INSTALL-GUIDE.md) for step-by-step instructions.

### Update Agent

```bash
cd C:\endpointx\endpoint-agent
git pull
python agent.py --register
python agent.py
```

## Default Credentials

| Component | Email/Username          | Password      | Role  |
| --------- | ----------------------- | ------------- | ----- |
| Dashboard | admin@endpointx.local   | Admin@123!    | admin |
| Agent     | N/A                     | dev_agent_secret_123 | N/A |

## Development Setup

### Prerequisites

- Node.js 20 LTS
- PostgreSQL 16
- Redis 7
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
