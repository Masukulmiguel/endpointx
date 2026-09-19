# EndpointX API Documentation

## Base URL

```
Production:  https://api.endpointx.example.com
Development: http://localhost:3001
```

## Common Headers

```http
Content-Type: application/json
Authorization: Bearer <access_token>
X-Request-ID: <uuid>
```

## Authentication

All API endpoints require authentication unless noted otherwise. Authentication uses JWT Bearer tokens.

### Obtaining a Token

```http
POST /api/auth/login
Content-Type: application/json

{
  "email": "admin@company.com",
  "password": "securepassword"
}
```

**Response (200 OK):**

```json
{
  "success": true,
  "data": {
    "accessToken": "eyJhbGciOiJIUzI1NiIs...",
    "refreshToken": "dGhpcyBpcyBhIHJlZnJl...",
    "user": {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "email": "admin@company.com",
      "role": "admin"
    }
  }
}
```

### Using the Token

```http
GET /api/devices
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
```

### Token Refresh

```http
POST /api/auth/refresh
Content-Type: application/json

{
  "refreshToken": "dGhpcyBpcyBhIHJlZnJl..."
}
```

---

## Authentication Endpoints

### POST /api/auth/register

Register a new admin user.

**Request:**

```json
{
  "email": "newadmin@company.com",
  "password": "SecureP@ss123",
  "name": "John Doe"
}
```

**Response (201 Created):**

```json
{
  "success": true,
  "data": {
    "user": {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "email": "newadmin@company.com",
      "name": "John Doe",
      "role": "admin",
      "createdAt": "2025-01-15T10:30:00Z"
    }
  }
}
```

**Errors:**
- `400` - Invalid input (missing fields, weak password)
- `409` - Email already exists

---

### POST /api/auth/login

Authenticate a user and receive tokens.

**Request:**

```json
{
  "email": "admin@company.com",
  "password": "securepassword"
}
```

**Response (200 OK):**

```json
{
  "success": true,
  "data": {
    "accessToken": "eyJhbGciOiJIUzI1NiIs...",
    "refreshToken": "dGhpcyBpcyBhIHJlZnJl...",
    "user": {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "email": "admin@company.com",
      "name": "Admin User",
      "role": "admin"
    }
  }
}
```

**Errors:**
- `400` - Missing email or password
- `401` - Invalid credentials
- `423` - Account locked (too many failed attempts)
- `429` - Rate limit exceeded

---

### POST /api/auth/logout

Invalidate the current refresh token.

**Headers:** `Authorization: Bearer <access_token>`

**Request:**

```json
{
  "refreshToken": "dGhpcyBpcyBhIHJlZnJl..."
}
```

**Response (200 OK):**

```json
{
  "success": true,
  "message": "Logged out successfully"
}
```

---

### POST /api/auth/refresh

Refresh an expired access token.

**Request:**

```json
{
  "refreshToken": "dGhpcyBpcyBhIHJlZnJl..."
}
```

**Response (200 OK):**

```json
{
  "success": true,
  "data": {
    "accessToken": "eyJhbGciOiJIUzI1NiIs...",
    "refreshToken": "dGhpcyBpcyBhIHJlZnJl..."
  }
}
```

**Errors:**
- `401` - Invalid or expired refresh token

---

### GET /api/auth/profile

Get the current user's profile.

**Headers:** `Authorization: Bearer <access_token>`

**Response (200 OK):**

```json
{
  "success": true,
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "email": "admin@company.com",
    "name": "Admin User",
    "role": {
      "id": "role-uuid",
      "name": "admin"
    },
    "mfaEnabled": false,
    "lastLogin": "2025-01-15T10:30:00Z",
    "createdAt": "2025-01-01T00:00:00Z"
  }
}
```

---

### PUT /api/auth/profile

Update the current user's profile.

**Headers:** `Authorization: Bearer <access_token>`

**Request:**

```json
{
  "name": "John Updated",
  "currentPassword": "oldpassword",
  "newPassword": "NewSecureP@ss123"
}
```

**Response (200 OK):**

```json
{
  "success": true,
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "name": "John Updated",
    "email": "admin@company.com",
    "updatedAt": "2025-01-15T11:00:00Z"
  }
}
```

---

## Device Endpoints

### POST /api/devices/register

Register a new device (called by agent).

**Request:**

```json
{
  "agentSecret": "shared-secret-from-env",
  "deviceName": "WORKSTATION-001",
  "hostname": "workstation001",
  "osType": "windows",
  "osVersion": "Windows 11 23H2",
  "ipAddresses": ["192.168.1.100"],
  "macAddresses": ["AA:BB:CC:DD:EE:FF"],
  "manufacturer": "Dell",
  "model": "OptiPlex 7090",
  "serialNumber": "XYZ123456",
  "totalMemory": 16384,
  "cpuCores": 8
}
```

**Response (201 Created):**

```json
{
  "success": true,
  "data": {
    "deviceId": "device-uuid-001",
    "agentId": "agent-uuid-001",
    "status": "pending"
  }
}
```

**Errors:**
- `400` - Invalid agent secret or missing fields
- `409` - Device already registered

---

### POST /api/devices/heartbeat

Send heartbeat with system metrics (called by agent).

**Request:**

```json
{
  "agentId": "agent-uuid-001",
  "deviceId": "device-uuid-001",
  "metrics": {
    "cpuUsage": 45.2,
    "ramUsage": 68.7,
    "ramTotal": 16384,
    "ramUsed": 11258,
    "diskUsage": 52.1,
    "diskTotal": 512000,
    "diskUsed": 266752,
    "networkIn": 1024000,
    "networkOut": 512000,
    "uptime": 864000
  }
}
```

**Response (200 OK):**

```json
{
  "success": true,
  "data": {
    "status": "online",
    "commands": [
      {
        "id": "cmd-uuid-001",
        "type": "collect_inventory",
        "command": "systeminfo",
        "timeout": 30
      }
    ]
  }
}
```

---

### GET /api/devices

List all devices (requires `device:read` permission).

**Headers:** `Authorization: Bearer <access_token>`

**Query Parameters:**

| Parameter   | Type    | Default | Description                    |
| ----------- | ------- | ------- | ------------------------------ |
| `page`      | number  | 1       | Page number                    |
| `limit`     | number  | 20      | Items per page (max 100)       |
| `status`    | string  | —       | Filter: online, offline, blocked, quarantined |
| `osType`    | string  | —       | Filter: windows, linux, macos  |
| `search`    | string  | —       | Search by name or hostname     |
| `sortBy`    | string  | createdAt | Sort field                   |
| `sortOrder` | string  | desc    | Sort order: asc, desc          |

**Response (200 OK):**

```json
{
  "success": true,
  "data": {
    "devices": [
      {
        "id": "device-uuid-001",
        "deviceName": "WORKSTATION-001",
        "hostname": "workstation001",
        "osType": "windows",
        "osVersion": "Windows 11 23H2",
        "status": "online",
        "lastSeen": "2025-01-15T10:30:00Z",
        "ipAddresses": ["192.168.1.100"],
        "metrics": {
          "cpuUsage": 45.2,
          "ramUsage": 68.7,
          "diskUsage": 52.1
        }
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 150,
      "totalPages": 8
    }
  }
}
```

---

### GET /api/devices/:id

Get a specific device by ID.

**Headers:** `Authorization: Bearer <access_token>`

**Response (200 OK):**

```json
{
  "success": true,
  "data": {
    "id": "device-uuid-001",
    "deviceName": "WORKSTATION-001",
    "hostname": "workstation001",
    "osType": "windows",
    "osVersion": "Windows 11 23H2",
    "status": "online",
    "agentId": "agent-uuid-001",
    "ipAddresses": ["192.168.1.100"],
    "macAddresses": ["AA:BB:CC:DD:EE:FF"],
    "manufacturer": "Dell",
    "model": "OptiPlex 7090",
    "serialNumber": "XYZ123456",
    "totalMemory": 16384,
    "cpuCores": 8,
    "lastSeen": "2025-01-15T10:30:00Z",
    "registeredAt": "2025-01-10T08:00:00Z",
    "metrics": {
      "cpuUsage": 45.2,
      "ramUsage": 68.7,
      "diskUsage": 52.1
    }
  }
}
```

---

### PUT /api/devices/:id

Update a device.

**Headers:** `Authorization: Bearer <access_token>`
**Permissions:** `device:write`

**Request:**

```json
{
  "deviceName": "WORKSTATION-001-UPDATED",
  "tags": ["finance", "critical"]
}
```

**Response (200 OK):**

```json
{
  "success": true,
  "data": {
    "id": "device-uuid-001",
    "deviceName": "WORKSTATION-001-UPDATED",
    "updatedAt": "2025-01-15T11:00:00Z"
  }
}
```

---

### DELETE /api/devices/:id

Delete a device.

**Headers:** `Authorization: Bearer <access_token>`
**Permissions:** `device:delete`

**Response (200 OK):**

```json
{
  "success": true,
  "message": "Device deleted successfully"
}
```

---

### POST /api/devices/:id/block

Block a device.

**Headers:** `Authorization: Bearer <access_token>`
**Permissions:** `device:block`

**Response (200 OK):**

```json
{
  "success": true,
  "data": {
    "id": "device-uuid-001",
    "status": "blocked",
    "blockedAt": "2025-01-15T11:00:00Z",
    "blockedBy": "admin-user-uuid"
  }
}
```

---

### POST /api/devices/:id/unblock

Unblock a device.

**Headers:** `Authorization: Bearer <access_token>`
**Permissions:** `device:unblock`

**Response (200 OK):**

```json
{
  "success": true,
  "data": {
    "id": "device-uuid-001",
    "status": "online",
    "unblockedAt": "2025-01-15T12:00:00Z",
    "unblockedBy": "admin-user-uuid"
  }
}
```

---

### POST /api/devices/:id/quarantine

Quarantine a device.

**Headers:** `Authorization: Bearer <access_token>`
**Permissions:** `device:quarantine`

**Request:**

```json
{
  "reason": "Suspicious network activity detected"
}
```

**Response (200 OK):**

```json
{
  "success": true,
  "data": {
    "id": "device-uuid-001",
    "status": "quarantined",
    "quarantinedAt": "2025-01-15T11:00:00Z",
    "quarantinedBy": "admin-user-uuid",
    "quarantineReason": "Suspicious network activity detected"
  }
}
```

---

## Command Endpoints

### POST /api/commands

Create a new command for a device.

**Headers:** `Authorization: Bearer <access_token>`
**Permissions:** `command:create`

**Request:**

```json
{
  "deviceId": "device-uuid-001",
  "command": "collect_inventory",
  "parameters": {
    "includeSoftware": true,
    "includeHardware": true
  },
  "timeout": 60
}
```

**Response (201 Created):**

```json
{
  "success": true,
  "data": {
    "id": "cmd-uuid-001",
    "deviceId": "device-uuid-001",
    "command": "collect_inventory",
    "status": "pending",
    "createdAt": "2025-01-15T10:30:00Z"
  }
}
```

---

### GET /api/commands

List all commands.

**Headers:** `Authorization: Bearer <access_token>`
**Permissions:** `command:read`

**Query Parameters:**

| Parameter  | Type   | Default    | Description                              |
| ---------- | ------ | ---------- | ---------------------------------------- |
| `page`     | number | 1          | Page number                              |
| `limit`    | number | 20         | Items per page (max 100)                 |
| `deviceId` | string | —          | Filter by device ID                      |
| `status`   | string | —          | Filter: pending, executing, completed, failed, cancelled |
| `command`  | string | —          | Filter by command type                   |

**Response (200 OK):**

```json
{
  "success": true,
  "data": {
    "commands": [
      {
        "id": "cmd-uuid-001",
        "deviceId": "device-uuid-001",
        "deviceName": "WORKSTATION-001",
        "command": "collect_inventory",
        "status": "completed",
        "createdBy": "admin-user-uuid",
        "createdAt": "2025-01-15T10:30:00Z",
        "executedAt": "2025-01-15T10:30:05Z",
        "completedAt": "2025-01-15T10:30:15Z"
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 500,
      "totalPages": 25
    }
  }
}
```

---

### GET /api/commands/:id

Get a specific command.

**Headers:** `Authorization: Bearer <access_token>`
**Permissions:** `command:read`

**Response (200 OK):**

```json
{
  "success": true,
  "data": {
    "id": "cmd-uuid-001",
    "deviceId": "device-uuid-001",
    "deviceName": "WORKSTATION-001",
    "command": "collect_inventory",
    "parameters": {
      "includeSoftware": true,
      "includeHardware": true
    },
    "status": "completed",
    "output": "{\"software\": [...], \"hardware\": [...]}",
    "exitCode": 0,
    "createdBy": "admin-user-uuid",
    "createdAt": "2025-01-15T10:30:00Z",
    "executedAt": "2025-01-15T10:30:05Z",
    "completedAt": "2025-01-15T10:30:15Z"
  }
}
```

---

### POST /api/commands/:id/cancel

Cancel a pending command.

**Headers:** `Authorization: Bearer <access_token>`
**Permissions:** `command:cancel`

**Response (200 OK):**

```json
{
  "success": true,
  "data": {
    "id": "cmd-uuid-001",
    "status": "cancelled",
    "cancelledAt": "2025-01-15T10:31:00Z"
  }
}
```

**Errors:**
- `400` - Command cannot be cancelled (already executing or completed)

---

### POST /api/commands/:id/result

Submit command result (called by agent).

**Request:**

```json
{
  "agentId": "agent-uuid-001",
  "deviceId": "device-uuid-001",
  "status": "completed",
  "output": "{\"software\": [{\"name\": \"Chrome\", \"version\": \"120.0\"}]}",
  "exitCode": 0
}
```

**Response (200 OK):**

```json
{
  "success": true,
  "message": "Command result recorded"
}
```

---

## User Endpoints

### GET /api/users

List all users.

**Headers:** `Authorization: Bearer <access_token>`
**Permissions:** `user:read`

**Query Parameters:**

| Parameter | Type   | Default | Description                    |
| --------- | ------ | ------- | ------------------------------ |
| `page`    | number | 1       | Page number                    |
| `limit`   | number | 20      | Items per page (max 100)       |
| `role`    | string | —       | Filter by role name            |
| `search`  | string | —       | Search by name or email        |

**Response (200 OK):**

```json
{
  "success": true,
  "data": {
    "users": [
      {
        "id": "user-uuid-001",
        "email": "admin@company.com",
        "name": "Admin User",
        "role": {
          "id": "role-uuid-001",
          "name": "admin"
        },
        "isActive": true,
        "lastLogin": "2025-01-15T10:30:00Z",
        "createdAt": "2025-01-01T00:00:00Z"
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 10,
      "totalPages": 1
    }
  }
}
```

---

### GET /api/users/:id

Get a specific user.

**Headers:** `Authorization: Bearer <access_token>`
**Permissions:** `user:read`

---

### POST /api/users

Create a new user.

**Headers:** `Authorization: Bearer <access_token>`
**Permissions:** `user:create`

**Request:**

```json
{
  "email": "tech@company.com",
  "password": "SecureP@ss123",
  "name": "Jane Smith",
  "roleId": "role-uuid-003"
}
```

**Response (201 Created):**

```json
{
  "success": true,
  "data": {
    "id": "user-uuid-002",
    "email": "tech@company.com",
    "name": "Jane Smith",
    "role": {
      "id": "role-uuid-003",
      "name": "technician"
    },
    "isActive": true,
    "createdAt": "2025-01-15T11:00:00Z"
  }
}
```

---

### PUT /api/users/:id

Update a user.

**Headers:** `Authorization: Bearer <access_token>`
**Permissions:** `user:write`

**Request:**

```json
{
  "name": "Jane Smith-Updated",
  "roleId": "role-uuid-002",
  "isActive": true
}
```

---

### DELETE /api/users/:id

Delete a user (soft delete).

**Headers:** `Authorization: Bearer <access_token>`
**Permissions:** `user:delete`

**Response (200 OK):**

```json
{
  "success": true,
  "message": "User deleted successfully"
}
```

---

## Role Endpoints

### GET /api/roles

List all roles.

**Headers:** `Authorization: Bearer <access_token>`
**Permissions:** `role:read`

**Response (200 OK):**

```json
{
  "success": true,
  "data": {
    "roles": [
      {
        "id": "role-uuid-001",
        "name": "admin",
        "description": "Full system access",
        "isDefault": false,
        "permissionCount": 20,
        "userCount": 2
      },
      {
        "id": "role-uuid-002",
        "name": "supervisor",
        "description": "Device and command management",
        "isDefault": false,
        "permissionCount": 14,
        "userCount": 5
      },
      {
        "id": "role-uuid-003",
        "name": "technician",
        "description": "Device monitoring and commands",
        "isDefault": true,
        "permissionCount": 8,
        "userCount": 10
      },
      {
        "id": "role-uuid-004",
        "name": "user",
        "description": "View own devices only",
        "isDefault": false,
        "permissionCount": 3,
        "userCount": 0
      }
    ]
  }
}
```

---

### GET /api/roles/:id

Get a specific role with its permissions.

**Headers:** `Authorization: Bearer <access_token>`
**Permissions:** `role:read`

**Response (200 OK):**

```json
{
  "success": true,
  "data": {
    "id": "role-uuid-001",
    "name": "admin",
    "description": "Full system access",
    "isDefault": false,
    "permissions": [
      {
        "id": "perm-uuid-001",
        "name": "device:read",
        "description": "View devices",
        "category": "device"
      },
      {
        "id": "perm-uuid-002",
        "name": "device:write",
        "description": "Modify devices",
        "category": "device"
      }
    ],
    "createdAt": "2025-01-01T00:00:00Z"
  }
}
```

---

### POST /api/roles

Create a new role.

**Headers:** `Authorization: Bearer <access_token>`
**Permissions:** `role:create`

**Request:**

```json
{
  "name": "custom_role",
  "description": "Custom role with specific permissions",
  "permissionIds": [
    "perm-uuid-001",
    "perm-uuid-003",
    "perm-uuid-005"
  ]
}
```

**Response (201 Created):**

```json
{
  "success": true,
  "data": {
    "id": "role-uuid-005",
    "name": "custom_role",
    "description": "Custom role with specific permissions",
    "isDefault": false,
    "permissionCount": 3,
    "createdAt": "2025-01-15T11:00:00Z"
  }
}
```

---

### PUT /api/roles/:id

Update a role.

**Headers:** `Authorization: Bearer <access_token>`
**Permissions:** `role:write`

**Request:**

```json
{
  "name": "custom_role_updated",
  "description": "Updated description",
  "permissionIds": [
    "perm-uuid-001",
    "perm-uuid-002",
    "perm-uuid-003"
  ]
}
```

---

### DELETE /api/roles/:id

Delete a role.

**Headers:** `Authorization: Bearer <access_token>`
**Permissions:** `role:delete`

**Errors:**
- `400` - Cannot delete a default role
- `409` - Role is assigned to users

---

### GET /api/roles/:id/permissions

Get permissions for a role.

**Headers:** `Authorization: Bearer <access_token>`
**Permissions:** `role:read`

---

### PUT /api/roles/:id/permissions

Update permissions for a role.

**Headers:** `Authorization: Bearer <access_token>`
**Permissions:** `role:write`

**Request:**

```json
{
  "permissionIds": [
    "perm-uuid-001",
    "perm-uuid-002",
    "perm-uuid-003"
  ]
}
```

---

## Alert Endpoints

### GET /api/alerts

List all alerts.

**Headers:** `Authorization: Bearer <access_token>`
**Permissions:** `alert:read`

**Query Parameters:**

| Parameter  | Type    | Default | Description                    |
| ---------- | ------- | ------- | ------------------------------ |
| `page`     | number  | 1       | Page number                    |
| `limit`    | number  | 20      | Items per page                 |
| `severity` | string  | —       | Filter: low, medium, high, critical |
| `status`   | string  | —       | Filter: active, dismissed, resolved |
| `type`     | string  | —       | Filter by alert type           |

**Response (200 OK):**

```json
{
  "success": true,
  "data": {
    "alerts": [
      {
        "id": "alert-uuid-001",
        "type": "security",
        "severity": "high",
        "title": "Unauthorized access attempt",
        "message": "Multiple failed login attempts from IP 192.168.1.200",
        "deviceId": "device-uuid-001",
        "status": "active",
        "createdAt": "2025-01-15T10:00:00Z"
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 50,
      "totalPages": 3
    }
  }
}
```

---

### GET /api/alerts/stats

Get alert statistics.

**Headers:** `Authorization: Bearer <access_token>`
**Permissions:** `alert:read`

**Response (200 OK):**

```json
{
  "success": true,
  "data": {
    "total": 150,
    "active": 25,
    "dismissed": 100,
    "resolved": 25,
    "bySeverity": {
      "low": 50,
      "medium": 60,
      "high": 30,
      "critical": 10
    },
    "last24Hours": 15,
    "last7Days": 45
  }
}
```

---

### GET /api/alerts/:id

Get a specific alert.

**Headers:** `Authorization: Bearer <access_token>`
**Permissions:** `alert:read`

---

### POST /api/alerts/:id/dismiss

Dismiss an alert.

**Headers:** `Authorization: Bearer <access_token>`
**Permissions:** `alert:dismiss`

**Response (200 OK):**

```json
{
  "success": true,
  "data": {
    "id": "alert-uuid-001",
    "status": "dismissed",
    "dismissedAt": "2025-01-15T11:00:00Z",
    "dismissedBy": "admin-user-uuid"
  }
}
```

---

## Security Endpoints

### GET /api/security/events

List security events.

**Headers:** `Authorization: Bearer <access_token>`
**Permissions:** `security:read`

**Query Parameters:**

| Parameter  | Type   | Default | Description                    |
| ---------- | ------ | ------- | ------------------------------ |
| `page`     | number | 1       | Page number                    |
| `limit`    | number | 20      | Items per page                 |
| `type`     | string | —       | Filter by event type           |
| `severity` | string | —       | Filter: low, medium, high, critical |
| `deviceId` | string | —       | Filter by device               |

**Response (200 OK):**

```json
{
  "success": true,
  "data": {
    "events": [
      {
        "id": "event-uuid-001",
        "type": "unauthorized_access",
        "severity": "critical",
        "description": "Unauthorized USB device connected",
        "deviceId": "device-uuid-001",
        "deviceName": "WORKSTATION-001",
        "ipAddress": "192.168.1.100",
        "status": "open",
        "createdAt": "2025-01-15T10:00:00Z"
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 200,
      "totalPages": 10
    }
  }
}
```

---

### GET /api/security/stats

Get security event statistics.

**Headers:** `Authorization: Bearer <access_token>`
**Permissions:** `security:read`

**Response (200 OK):**

```json
{
  "success": true,
  "data": {
    "totalEvents": 500,
    "openEvents": 75,
    "resolvedEvents": 425,
    "byType": {
      "unauthorized_access": 100,
      "malware_detected": 50,
      "policy_violation": 200,
      "data_exfiltration": 25,
      "suspicious_activity": 125
    },
    "bySeverity": {
      "low": 100,
      "medium": 200,
      "high": 150,
      "critical": 50
    },
    "last24Hours": 20,
    "last7Days": 80
  }
}
```

---

### GET /api/security/events/:id

Get a specific security event.

**Headers:** `Authorization: Bearer <access_token>`
**Permissions:** `security:read`

---

### POST /api/security/events/:id/resolve

Resolve a security event.

**Headers:** `Authorization: Bearer <access_token>`
**Permissions:** `security:resolve`

**Request:**

```json
{
  "resolution": "USB device removed and blocked via group policy",
  "notes": "User was educated on USB policy"
}
```

**Response (200 OK):**

```json
{
  "success": true,
  "data": {
    "id": "event-uuid-001",
    "status": "resolved",
    "resolution": "USB device removed and blocked via group policy",
    "resolvedAt": "2025-01-15T12:00:00Z",
    "resolvedBy": "admin-user-uuid"
  }
}
```

---

## Audit Endpoints

### GET /api/audit

List audit log entries.

**Headers:** `Authorization: Bearer <access_token>`
**Permissions:** `audit:read`

**Query Parameters:**

| Parameter  | Type   | Default    | Description                    |
| ---------- | ------ | ---------- | ------------------------------ |
| `page`     | number | 1          | Page number                    |
| `limit`    | number | 20         | Items per page (max 100)       |
| `userId`   | string | —          | Filter by user                 |
| `action`   | string | —          | Filter by action type          |
| `resource` | string | —          | Filter by resource type        |
| `from`     | string | —          | Start date (ISO 8601)          |
| `to`       | string | —          | End date (ISO 8601)            |

**Response (200 OK):**

```json
{
  "success": true,
  "data": {
    "logs": [
      {
        "id": "audit-uuid-001",
        "userId": "user-uuid-001",
        "userName": "Admin User",
        "action": "create",
        "resource": "device",
        "resourceId": "device-uuid-001",
        "details": {
          "deviceName": "WORKSTATION-001",
          "osType": "windows"
        },
        "ipAddress": "192.168.1.50",
        "userAgent": "Mozilla/5.0...",
        "createdAt": "2025-01-15T10:30:00Z"
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 10000,
      "totalPages": 500
    }
  }
}
```

---

### GET /api/audit/export

Export audit logs as CSV.

**Headers:** `Authorization: Bearer <access_token>`
**Permissions:** `audit:export`

**Query Parameters:**

| Parameter | Type   | Description         |
| --------- | ------ | ------------------- |
| `from`    | string | Start date (ISO)    |
| `to`      | string | End date (ISO)      |
| `format`  | string | csv (default)       |

**Response:** CSV file download

---

### GET /api/audit/stats

Get audit log statistics.

**Headers:** `Authorization: Bearer <access_token>`
**Permissions:** `audit:read`

**Response (200 OK):**

```json
{
  "success": true,
  "data": {
    "totalLogs": 50000,
    "byAction": {
      "create": 10000,
      "read": 25000,
      "update": 10000,
      "delete": 5000
    },
    "byResource": {
      "device": 15000,
      "user": 5000,
      "command": 20000,
      "role": 3000,
      "settings": 7000
    },
    "activeUsers": 15,
    "last24Hours": 500,
    "last7Days": 2000
  }
}
```

---

### GET /api/audit/:id

Get a specific audit log entry.

**Headers:** `Authorization: Bearer <access_token>`
**Permissions:** `audit:read`

---

## Dashboard Endpoint

### GET /api/dashboard/overview

Get dashboard overview statistics.

**Headers:** `Authorization: Bearer <access_token>`
**Permissions:** `dashboard:read`

**Response (200 OK):**

```json
{
  "success": true,
  "data": {
    "devices": {
      "total": 150,
      "online": 120,
      "offline": 20,
      "blocked": 5,
      "quarantined": 5
    },
    "commands": {
      "pending": 10,
      "executing": 5,
      "completedToday": 45,
      "failedToday": 2
    },
    "alerts": {
      "active": 15,
      "critical": 3,
      "high": 7,
      "medium": 5
    },
    "security": {
      "openEvents": 25,
      "resolvedToday": 10
    },
    "recentActivity": [
      {
        "id": "event-uuid",
        "type": "device_online",
        "description": "WORKSTATION-001 came online",
        "timestamp": "2025-01-15T10:30:00Z"
      }
    ]
  }
}
```

---

## Settings Endpoints

### GET /api/settings

Get application settings.

**Headers:** `Authorization: Bearer <access_token>`
**Permissions:** `settings:read`

**Response (200 OK):**

```json
{
  "success": true,
  "data": {
    "general": {
      "companyName": "Acme Corp",
      "timezone": "America/New_York",
      "language": "en"
    },
    "security": {
      "passwordMinLength": 12,
      "passwordRequireUppercase": true,
      "passwordRequireNumber": true,
      "passwordRequireSpecial": true,
      "maxLoginAttempts": 5,
      "lockoutDurationMinutes": 30,
      "sessionTimeoutMinutes": 60,
      "mfaEnabled": false
    },
    "agent": {
      "heartbeatIntervalSeconds": 60,
      "commandTimeoutSeconds": 30,
      "maxRetryAttempts": 3
    },
    "notifications": {
      "emailEnabled": false,
      "smtpHost": "",
      "smtpPort": 587,
      "alertEmailRecipients": []
    }
  }
}
```

---

### PUT /api/settings

Update application settings.

**Headers:** `Authorization: Bearer <access_token>`
**Permissions:** `settings:write`

**Request:**

```json
{
  "general": {
    "companyName": "Acme Corp Updated",
    "timezone": "America/Chicago"
  },
  "security": {
    "passwordMinLength": 14,
    "mfaEnabled": true
  }
}
```

**Response (200 OK):**

```json
{
  "success": true,
  "data": {
    "general": {
      "companyName": "Acme Corp Updated",
      "timezone": "America/Chicago",
      "language": "en"
    },
    "security": {
      "passwordMinLength": 14,
      "mfaEnabled": true
    }
  },
  "message": "Settings updated successfully"
}
```

---

## WebSocket Events

### Connection

```javascript
const socket = io("https://api.endpointx.example.com", {
  auth: {
    token: "eyJhbGciOiJIUzI1NiIs..."
  }
});
```

### Client → Server Events

| Event              | Payload                    | Description                    |
| ------------------ | -------------------------- | ------------------------------ |
| `subscribe:device` | `{ deviceId: string }`     | Subscribe to device updates    |
| `unsubscribe:device` | `{ deviceId: string }`   | Unsubscribe from device updates|

### Server → Client Events

| Event                    | Payload                              | Description                      |
| ------------------------ | ------------------------------------ | -------------------------------- |
| `device:status_changed`  | `{ deviceId, status, timestamp }`    | Device went online/offline/etc   |
| `device:metrics_updated` | `{ deviceId, metrics, timestamp }`   | New metrics received             |
| `command:created`        | `{ commandId, deviceId, command }`   | New command queued               |
| `command:completed`      | `{ commandId, status, output }`      | Command finished executing       |
| `alert:new`              | `{ alert }`                          | New alert generated              |
| `security:event`         | `{ event }`                          | New security event               |
| `audit:new`              | `{ logEntry }`                       | New audit log entry              |

### Event Example

```javascript
socket.on("device:status_changed", (data) => {
  console.log(`Device ${data.deviceId} is now ${data.status}`);
  // Update UI accordingly
});

socket.on("alert:new", (data) => {
  showNotification(data.alert.title, data.alert.severity);
});

socket.emit("subscribe:device", { deviceId: "device-uuid-001" });
```

---

## Error Response Format

All errors follow a consistent format:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid input provided",
    "details": [
      {
        "field": "email",
        "message": "Invalid email format"
      }
    ]
  }
}
```

### Error Codes

| HTTP Status | Code                    | Description                              |
| ----------- | ----------------------- | ---------------------------------------- |
| 400         | `VALIDATION_ERROR`      | Invalid input data                       |
| 400         | `BAD_REQUEST`           | Malformed request                        |
| 401         | `UNAUTHORIZED`          | Missing or invalid authentication        |
| 401         | `INVALID_CREDENTIALS`   | Wrong email or password                  |
| 403         | `FORBIDDEN`             | Insufficient permissions                 |
| 404         | `NOT_FOUND`             | Resource not found                       |
| 409         | `CONFLICT`              | Resource already exists                  |
| 422         | `UNPROCESSABLE`         | Business logic validation failed         |
| 429         | `RATE_LIMIT_EXCEEDED`   | Too many requests                        |
| 500         | `INTERNAL_ERROR`        | Server error                             |
| 503         | `SERVICE_UNAVAILABLE`   | Service temporarily unavailable          |

---

## Rate Limiting

Rate limits are applied per IP address and can be configured per endpoint.

### Default Limits

| Endpoint Category     | Requests / Minute | Requests / Hour |
| --------------------- | ----------------- | --------------- |
| Authentication        | 10                | 50              |
| API (general)         | 100               | 2000            |
| Device registration   | 5                 | 20              |
| Heartbeat             | 2                 | 120             |
| Dashboard             | 30                | 500             |
| Export                | 5                 | 20              |

### Rate Limit Headers

```http
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1705312800
```

### Rate Limit Response (429)

```json
{
  "success": false,
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "message": "Too many requests. Please try again later.",
    "retryAfter": 30
  }
}
```

---

## Pagination

All list endpoints support pagination via `page` and `limit` query parameters.

### Response Format

```json
{
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 150,
    "totalPages": 8,
    "hasNext": true,
    "hasPrevious": false
  }
}
```

### Client Implementation

```javascript
// Fetch page 2 with 50 items per page
const response = await fetch("/api/devices?page=2&limit=50", {
  headers: { Authorization: `Bearer ${token}` }
});
```
