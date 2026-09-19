# EndpointX Deployment Guide

## Table of Contents

- [Prerequisites](#prerequisites)
- [Docker Compose Deployment](#docker-compose-deployment)
- [Manual Deployment](#manual-deployment)
- [Environment Configuration](#environment-configuration)
- [Database Setup](#database-setup)
- [SSL/TLS Certificates](#ssltls-certificates)
- [Nginx Configuration](#nginx-configuration)
- [Agent Deployment](#agent-deployment)
- [Monitoring Setup](#monitoring-setup)
- [Backup Procedures](#backup-procedures)
- [Upgrade Procedures](#upgrade-procedures)
- [Troubleshooting](#troubleshooting)

---

## Prerequisites

### Minimum Hardware Requirements

| Component         | Minimum                        | Recommended                    |
| ----------------- | ------------------------------ | ------------------------------ |
| CPU               | 2 cores                        | 4 cores                        |
| RAM               | 4 GB                           | 8 GB                           |
| Storage           | 20 GB SSD                      | 50 GB SSD                      |
| Network           | 100 Mbps                       | 1 Gbps                         |

### Software Requirements

| Software          | Version                        |
| ----------------- | ------------------------------ |
| Docker            | 24.0+                          |
| Docker Compose    | 2.20+                          |
| Node.js           | 20 LTS (if manual deploy)      |
| Python            | 3.9+ (for agent)               |
| PostgreSQL        | 16 (if manual deploy)          |
| Redis             | 7 (if manual deploy)           |
| Nginx             | 1.24+ (for reverse proxy)      |

### Network Requirements

| Port    | Service           | Direction    |
| ------- | ----------------- | ------------ |
| 80      | HTTP (redirect)   | Inbound      |
| 443     | HTTPS             | Inbound      |
| 3001    | API (internal)    | Internal     |
| 5432    | PostgreSQL        | Internal     |
| 6379    | Redis             | Internal     |

---

## Docker Compose Deployment

### 1. Clone Repository

```bash
git clone https://github.com/your-org/endpointx.git
cd endpointx
```

### 2. Create Environment File

```bash
cp .env.example .env
```

Edit `.env` with your configuration:

```bash
# Generate a secure JWT secret
JWT_SECRET=$(openssl rand -hex 32)

# Generate agent secret
AGENT_SECRET=$(openssl rand -hex 32)

# Generate encryption key
ENCRYPTION_KEY=$(openssl rand -hex 32)

# Database
POSTGRES_USER=endpointx
POSTGRES_PASSWORD=$(openssl rand -hex 16)
POSTGRES_DB=endpointx

# Redis
REDIS_PASSWORD=$(openssl rand -hex 16)
```

### 3. Start Services

```bash
# Production deployment
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d

# Development deployment
docker compose up -d
```

### 4. Initialize Database

```bash
docker compose exec api npx knex migrate:latest
docker compose exec api npx knex seed:run
```

### 5. Verify Deployment

```bash
# Check all services are running
docker compose ps

# Check API health
curl http://localhost:3001/health

# Check logs
docker compose logs -f api
```

### Docker Compose Files

#### docker-compose.yml

```yaml
version: '3.8'

services:
  api:
    build:
      context: ./backend
      dockerfile: Dockerfile
    ports:
      - "3001:3001"
    environment:
      - NODE_ENV=production
      - DATABASE_URL=postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}
      - REDIS_URL=redis://:${REDIS_PASSWORD}@redis:6379
      - JWT_SECRET=${JWT_SECRET}
      - AGENT_SECRET=${AGENT_SECRET}
      - ENCRYPTION_KEY=${ENCRYPTION_KEY}
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3001/health"]
      interval: 30s
      timeout: 10s
      retries: 3

  dashboard:
    build:
      context: ./dashboard
      dockerfile: Dockerfile
    ports:
      - "80:80"
    depends_on:
      - api
    restart: unless-stopped

  postgres:
    image: postgres:16-alpine
    environment:
      - POSTGRES_USER=${POSTGRES_USER}
      - POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
      - POSTGRES_DB=${POSTGRES_DB}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    ports:
      - "5432:5432"
    restart: unless-stopped
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER}"]
      interval: 10s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    command: redis-server --requirepass ${REDIS_PASSWORD}
    volumes:
      - redis_data:/data
    ports:
      - "6379:6379"
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "redis-cli", "-a", "${REDIS_PASSWORD}", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5

volumes:
  postgres_data:
  redis_data:
```

#### docker-compose.prod.yml

```yaml
version: '3.8'

services:
  api:
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
    deploy:
      resources:
        limits:
          cpus: '2'
          memory: 2G
        reservations:
          cpus: '1'
          memory: 1G

  dashboard:
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"

  postgres:
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"

  redis:
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
```

---

## Manual Deployment

### 1. Install Node.js

```bash
# Using nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
nvm install 20
nvm use 20

# Verify
node --version  # v20.x.x
npm --version   # 10.x.x
```

### 2. Install PostgreSQL

```bash
# Ubuntu/Debian
sudo sh -c 'echo "deb http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list'
wget --quiet -O - https://www.postgresql.org/media/keys/ACCC4CF8.asc | sudo apt-key add -
sudo apt-get update
sudo apt-get install -y postgresql-16

# Start service
sudo systemctl enable postgresql
sudo systemctl start postgresql
```

### 3. Install Redis

```bash
# Ubuntu/Debian
sudo apt-get install -y redis-server

# Start service
sudo systemctl enable redis-server
sudo systemctl start redis-server
```

### 4. Setup Backend

```bash
cd backend

# Install dependencies
npm ci --only=production

# Create environment file
cp .env.example .env
# Edit .env with your configuration

# Run migrations
npx knex migrate:latest

# Seed database
npx knex seed:run

# Start server
node dist/index.js
```

### 5. Setup Dashboard

```bash
cd dashboard

# Install dependencies
npm ci

# Build for production
npm run build

# Copy dist to nginx directory
sudo cp -r dist/* /var/www/endpointx/
```

### 6. Configure systemd Services

#### /etc/systemd/system/endpointx-api.service

```ini
[Unit]
Description=EndpointX API Server
After=network.target postgresql.service redis.service

[Service]
Type=simple
User=endpointx
Group=endpointx
WorkingDirectory=/opt/endpointx/backend
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
RestartSec=10
StandardOutput=syslog
StandardError=syslog
SyslogIdentifier=endpointx-api
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable endpointx-api
sudo systemctl start endpointx-api
```

---

## Environment Configuration

### Environment Variables Reference

| Variable                | Required | Default       | Description                           |
| ----------------------- | -------- | ------------- | ------------------------------------- |
| `NODE_ENV`              | Yes      | development   | Environment mode                      |
| `PORT`                  | No       | 3001          | API server port                       |
| `DATABASE_URL`          | Yes      | —             | PostgreSQL connection string          |
| `REDIS_URL`             | Yes      | —             | Redis connection string               |
| `JWT_SECRET`            | Yes      | —             | JWT signing secret (min 32 chars)     |
| `JWT_EXPIRY`            | No       | 15m           | Access token expiry                   |
| `REFRESH_TOKEN_EXPIRY`  | No       | 7d            | Refresh token expiry                  |
| `AGENT_SECRET`          | Yes      | —             | Shared secret for agent auth          |
| `ENCRYPTION_KEY`        | Yes      | —             | AES-256 encryption key (64 hex chars) |
| `BCRYPT_ROUNDS`         | No       | 12            | bcrypt cost factor                    |
| `RATE_LIMIT_WINDOW_MS`  | No       | 60000         | Rate limit window (ms)                |
| `RATE_LIMIT_MAX`        | No       | 100           | Max requests per window               |
| `CORS_ORIGIN`           | No       | *             | Allowed CORS origins                  |
| `LOG_LEVEL`             | No       | info          | Logging level                         |
| `PGSSLMODE`             | No       | require       | PostgreSQL SSL mode                   |

### Example .env File

```bash
# Application
NODE_ENV=production
PORT=3001

# Database
DATABASE_URL=postgresql://endpointx:secretpassword@localhost:5432/endpointx

# Redis
REDIS_URL=redis://:redispassword@localhost:6379

# Authentication
JWT_SECRET=a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6
JWT_EXPIRY=15m
REFRESH_TOKEN_EXPIRY=7d

# Agent
AGENT_SECRET=x9y8w7v6u5t4s3r2q1p0o9n8m7l6k5j4i3h2g1f0e9d8c7b6a5

# Encryption
ENCRYPTION_KEY=f0e1d2c3b4a59687f0e1d2c3b4a59687f0e1d2c3b4a59687f0e1d2c3b4a59687

# Security
BCRYPT_ROUNDS=12
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=100

# CORS
CORS_ORIGIN=https://endpointx.yourcompany.com

# Logging
LOG_LEVEL=info
```

---

## Database Setup

### Initial Setup

```bash
# Connect to PostgreSQL
psql -U postgres

# Create database and user
CREATE USER endpointx WITH PASSWORD 'your_secure_password';
CREATE DATABASE endpointx OWNER endpointx;
GRANT ALL PRIVILEGES ON DATABASE endpointx TO endpointx;

# Enable extensions
\c endpointx
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

\q
```

### Run Migrations

```bash
# From backend directory
npx knex migrate:latest

# Verify migrations
npx knex migrate:status
```

### Seed Default Data

```bash
npx knex seed:run
```

This creates:
- Default roles (admin, supervisor, technician, user)
- 20 granular permissions
- Role-permission mappings
- Default admin user

### Default Credentials

| Email                  | Password       | Role     |
| ---------------------- | -------------- | -------- |
| admin@endpointx.local  | Admin@123!     | admin    |

> **IMPORTANT**: Change the default admin password immediately after first login.

### Backup Database

```bash
# Manual backup
pg_dump -U endpointx -d endpointx -F c -f backup_$(date +%Y%m%d).dump

# Restore
pg_restore -U endpointx -d endpointx backup_20250115.dump
```

---

## SSL/TLS Certificates

### Let's Encrypt (Recommended)

```bash
# Install certbot
sudo apt-get install -y certbot python3-certbot-nginx

# Obtain certificate
sudo certbot --nginx -d endpointx.yourcompany.com

# Auto-renewal (certbot sets up cron automatically)
sudo certbot renew --dry-run
```

### Self-Signed Certificate (Development)

```bash
# Generate private key
openssl genrsa -out /etc/ssl/private/endpointx.key 2048

# Generate CSR
openssl req -new -key /etc/ssl/private/endpointx.key \
  -out /etc/ssl/certs/endpointx.csr

# Generate self-signed certificate
openssl x509 -req -days 365 \
  -in /etc/ssl/certs/endpointx.csr \
  -signkey /etc/ssl/private/endpointx.key \
  -out /etc/ssl/certs/endpointx.crt
```

### Commercial Certificate

1. Generate CSR using the method above
2. Submit CSR to your Certificate Authority
3. Download the signed certificate
4. Install certificate and intermediate chain

```bash
# Concatenate certificate chain
cat endpointx.crt intermediate.crt root.crt > /etc/ssl/certs/endpointx-fullchain.crt
```

---

## Nginx Configuration

### /etc/nginx/sites-available/endpointx

```nginx
# Rate limiting zones
limit_req_zone $binary_remote_addr zone=auth:10m rate=10r/m;
limit_req_zone $binary_remote_addr zone=api:10m rate=100r/m;

# Upstream
upstream endpointx_api {
    server 127.0.0.1:3001;
}

# HTTP → HTTPS redirect
server {
    listen 80;
    server_name endpointx.yourcompany.com;
    return 301 https://$server_name$request_uri;
}

# HTTPS server
server {
    listen 443 ssl http2;
    server_name endpointx.yourcompany.com;

    # SSL Configuration
    ssl_certificate /etc/ssl/certs/endpointx-fullchain.crt;
    ssl_certificate_key /etc/ssl/private/endpointx.key;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers off;
    ssl_session_timeout 1d;
    ssl_session_cache shared:SSL:10m;
    ssl_session_tickets off;

    # Security Headers
    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;
    add_header X-Frame-Options "DENY" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' wss://endpointx.yourcompany.com;" always;

    # Gzip compression
    gzip on;
    gzip_vary on;
    gzip_min_length 1024;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml text/javascript;

    # Dashboard (static files)
    location / {
        root /var/www/endpointx;
        try_files $uri $uri/ /index.html;
    }

    # API proxy
    location /api/ {
        limit_req zone=api burst=20 nodelay;
        proxy_pass http://endpointx_api;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 90s;
    }

    # Auth endpoints (stricter rate limiting)
    location /api/auth/ {
        limit_req zone=auth burst=5 nodelay;
        proxy_pass http://endpointx_api;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # WebSocket support
    location /socket.io/ {
        proxy_pass http://endpointx_api;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
    }

    # Health check
    location /health {
        proxy_pass http://endpointx_api/health;
        access_log off;
    }

    # Deny access to hidden files
    location ~ /\. {
        deny all;
        access_log off;
        log_not_found off;
    }
}
```

### Enable Site

```bash
sudo ln -s /etc/nginx/sites-available/endpointx /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

---

## Agent Deployment

### Download Agent

```bash
# From endpoint directory
curl -O https://releases.endpointx.example.com/agent/endpointx-agent-latest.tar.gz
tar -xzf endpointx-agent-latest.tar.gz
cd endpointx-agent
```

### Configuration

Create `config.json`:

```json
{
  "server_url": "https://endpointx.yourcompany.com",
  "agent_secret": "your-agent-secret",
  "heartbeat_interval": 60,
  "log_level": "info",
  "log_file": "/var/log/endpointx-agent.log"
}
```

### Installation

```bash
# Linux
sudo ./install.sh

# Windows (PowerShell as Administrator)
.\install.ps1

# macOS
sudo ./install.sh
```

### Service Management

```bash
# Linux (systemd)
sudo systemctl start endpointx-agent
sudo systemctl status endpointx-agent

# Windows
net start endpointx-agent

# macOS (launchctl)
sudo launchctl load /Library/LaunchDaemons/com.endpointx.agent.plist
```

### Mass Deployment

For enterprise environments, use one of these methods:

#### Group Policy (Windows)

1. Create MSI package
2. Deploy via Group Policy Software Installation
3. Include configuration file

#### Ansible Playbook

```yaml
---
- name: Deploy EndpointX Agent
  hosts: workstations
  become: yes
  vars:
    server_url: "https://endpointx.yourcompany.com"
    agent_secret: "your-agent-secret"
  tasks:
    - name: Download agent
      get_url:
        url: "https://releases.endpointx.example.com/agent/endpointx-agent-latest.tar.gz"
        dest: /tmp/endpointx-agent.tar.gz

    - name: Extract agent
      unarchive:
        src: /tmp/endpointx-agent.tar.gz
        dest: /opt/endpointx-agent
        remote_src: yes

    - name: Copy configuration
      template:
        src: config.json.j2
        dest: /opt/endpointx-agent/config.json

    - name: Install agent
      command: /opt/endpointx-agent/install.sh
      args:
        creates: /etc/systemd/system/endpointx-agent.service

    - name: Start agent
      systemd:
        name: endpointx-agent
        state: started
        enabled: yes
```

---

## Monitoring Setup

### Health Check Endpoint

```bash
curl http://localhost:3001/health

# Response
{
  "status": "healthy",
  "timestamp": "2025-01-15T10:30:00Z",
  "uptime": 86400,
  "database": "connected",
  "redis": "connected"
}
```

### Prometheus Metrics

Enable metrics in `.env`:

```bash
METRICS_ENABLED=true
METRICS_PORT=9090
```

Add to `docker-compose.yml`:

```yaml
  prometheus:
    image: prom/prometheus:latest
    volumes:
      - ./monitoring/prometheus.yml:/etc/prometheus/prometheus.yml
    ports:
      - "9090:9090"

  grafana:
    image: grafana/grafana:latest
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=admin
    volumes:
      - grafana_data:/var/lib/grafana
    ports:
      - "3000:3000"
```

### Monitoring Stack

| Component     | Purpose                    | Port    |
| ------------- | -------------------------- | ------- |
| Prometheus    | Metrics collection         | 9090    |
| Grafana       | Dashboard visualization    | 3000    |
| Alertmanager  | Alert routing               | 9093    |

### Key Metrics to Monitor

| Metric                         | Warning  | Critical |
| ------------------------------ | -------- | -------- |
| API response time (p95)        | >500ms   | >1000ms  |
| Error rate (5xx)               | >1%      | >5%      |
| Database connections           | >15      | >18      |
| Redis memory usage             | >70%     | >85%     |
| Disk usage                     | >70%     | >85%     |
| CPU usage                      | >70%     | >85%     |
| Memory usage                   | >70%     | >85%     |
| Agent offline count            | >5       | >10      |

---

## Backup Procedures

### Database Backups

#### Automated Backup Script

```bash
#!/bin/bash
# /opt/endpointx/scripts/backup-db.sh

BACKUP_DIR="/var/backups/endpointx"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
RETENTION_DAYS=30

# Create backup
pg_dump -U endpointx -d endpointx -F c \
  -f "${BACKUP_DIR}/endpointx_${TIMESTAMP}.dump"

# Compress
gzip "${BACKUP_DIR}/endpointx_${TIMESTAMP}.dump"

# Encrypt (optional)
gpg --encrypt --recipient backup@yourcompany.com \
  "${BACKUP_DIR}/endpointx_${TIMESTAMP}.dump.gz"

# Remove old backups
find ${BACKUP_DIR} -name "endpointx_*.dump.gz" -mtime +${RETENTION_DAYS} -delete

# Upload to cloud storage (optional)
aws s3 cp "${BACKUP_DIR}/endpointx_${TIMESTAMP}.dump.gz.gz" \
  s3://endpointx-backups/daily/
```

#### Cron Schedule

```bash
# Daily backup at 2 AM
0 2 * * * /opt/endpointx/scripts/backup-db.sh >> /var/log/endpointx-backup.log 2>&1
```

### Redis Backups

```bash
# Create Redis backup
redis-cli -a ${REDIS_PASSWORD} BGSAVE

# Copy dump.rdb to backup location
cp /var/lib/redis/dump.rdb /var/backups/endpointx/redis_$(date +%Y%m%d).rdb
```

### Application Backups

```bash
# Backup configuration
tar -czf /var/backups/endpointx/config_$(date +%Y%m%d).tar.gz \
  /opt/endpointx/backend/.env \
  /opt/endpointx/dashboard/.env
```

### Backup Verification

```bash
# Test restore (on staging environment)
pg_restore -U endpointx -d endpointx_test \
  /var/backups/endpointx/endpointx_20250115.dump.gz
```

---

## Upgrade Procedures

### Pre-Upgrade Checklist

- [ ] Read release notes for breaking changes
- [ ] Backup database
- [ ] Backup configuration files
- [ ] Test upgrade on staging environment
- [ ] Schedule maintenance window
- [ ] Notify users of downtime

### Docker Upgrade

```bash
# Pull latest images
docker compose pull

# Stop current services
docker compose down

# Run migrations
docker compose run api npx knex migrate:latest

# Start updated services
docker compose up -d

# Verify
docker compose ps
curl http://localhost:3001/health
```

### Manual Upgrade

```bash
# Backend
cd /opt/endpointx/backend
git pull origin main
npm ci --only=production
npx knex migrate:latest
npm run build
sudo systemctl restart endpointx-api

# Dashboard
cd /opt/endpointx/dashboard
git pull origin main
npm ci
npm run build
sudo cp -r dist/* /var/www/endpointx/
sudo systemctl reload nginx
```

### Rollback Procedure

```bash
# Docker
git checkout <previous-version-tag>
docker compose down
docker compose up -d

# Database (if needed)
psql -U endpointx -d endpointx < /var/backups/endpointx/pre_upgrade.sql

# Manual
cd /opt/endpointx/backend
git checkout <previous-version-tag>
npm ci --only=production
npm run build
sudo systemctl restart endpointx-api
```

---

## Troubleshooting

### Common Issues

#### API Won't Start

```bash
# Check logs
docker compose logs api
# or
sudo journalctl -u endpointx-api -f

# Common causes:
# 1. Database connection failed
# 2. Missing environment variables
# 3. Port already in use
# 4. Invalid JWT_SECRET length
```

#### Database Connection Issues

```bash
# Test connection
psql -U endpointx -d endpointx -h localhost

# Check PostgreSQL status
sudo systemctl status postgresql

# Check pg_hba.conf for authentication
sudo cat /etc/postgresql/16/main/pg_hba.conf
```

#### Agent Not Connecting

```bash
# Check agent logs
tail -f /var/log/endpointx-agent.log

# Verify server URL
curl -k https://endpointx.yourcompany.com/health

# Check firewall
sudo ufw status
sudo iptables -L
```

#### High Memory Usage

```bash
# Check container stats
docker stats

# Restart services
docker compose restart api

# Check for memory leaks
# Enable heapdump in .env
HEAPDUMP_ENABLED=true
```

#### WebSocket Connection Issues

```bash
# Test WebSocket
wscat -c wss://endpointx.yourcompany.com/socket.io/?EIO=4&transport=websocket

# Check Nginx configuration
# Ensure WebSocket headers are proxied correctly
```

### Log Locations

| Service      | Log Location                    |
| ------------ | ------------------------------- |
| API          | `/var/log/endpointx-api.log`    |
| Dashboard    | `/var/log/nginx/access.log`     |
| PostgreSQL   | `/var/log/postgresql/`          |
| Redis        | `/var/log/redis/`               |
| Agent        | `/var/log/endpointx-agent.log`  |

### Getting Help

- **Documentation**: https://docs.endpointx.example.com
- **GitHub Issues**: https://github.com/your-org/endpointx/issues
- **Email**: support@endpointx.example.com
- **Slack**: #endpointx-support
