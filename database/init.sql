-- EndpointX Database Schema
-- IAM + Endpoint Management Platform

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================
-- ENUMS
-- ============================================

CREATE TYPE user_role AS ENUM ('admin', 'supervisor', 'technician', 'user');
CREATE TYPE device_status AS ENUM ('online', 'offline', 'alert', 'blocked', 'quarantine');
CREATE TYPE alert_severity AS ENUM ('info', 'low', 'medium', 'high', 'critical');
CREATE TYPE alert_type AS ENUM (
    'unknown_device',
    'failed_login',
    'config_change',
    'antivirus_disabled',
    'firewall_disabled',
    'suspicious_software',
    'system_outdated',
    'abnormal_network',
    'device_offline',
    'brute_force',
    'unauthorized_access',
    'tamper_detected'
);
CREATE TYPE command_status AS ENUM ('pending', 'sent', 'executing', 'completed', 'failed', 'timeout');
CREATE TYPE command_type AS ENUM (
    'reboot', 'shutdown', 'lock', 'unlock',
    'inventory', 'update_agent', 'quarantine',
    'remove', 'scan', 'get_info', 'uninstall_agent'
);
CREATE TYPE log_action AS ENUM (
    'login', 'logout', 'login_failed', 'password_change',
    'device_register', 'device_block', 'device_unblock',
    'device_quarantine', 'device_remove', 'command_execute',
    'user_create', 'user_update', 'user_delete',
    'role_create', 'role_update', 'role_delete',
    'settings_update', 'alert_dismiss', 'mfa_enable', 'mfa_disable'
);

-- ============================================
-- TABLES
-- ============================================

-- Roles
CREATE TABLE roles (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(100) UNIQUE NOT NULL,
    display_name VARCHAR(150) NOT NULL,
    description TEXT,
    is_system BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Permissions
CREATE TABLE permissions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code VARCHAR(100) UNIQUE NOT NULL,
    name VARCHAR(150) NOT NULL,
    description TEXT,
    category VARCHAR(50) NOT NULL
);

-- Role-Permission mapping
CREATE TABLE role_permissions (
    role_id UUID REFERENCES roles(id) ON DELETE CASCADE,
    permission_id UUID REFERENCES permissions(id) ON DELETE CASCADE,
    PRIMARY KEY (role_id, permission_id)
);

-- Users
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
    username VARCHAR(100) UNIQUE NOT NULL,
    full_name VARCHAR(200) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role_id UUID REFERENCES roles(id),
    is_active BOOLEAN DEFAULT TRUE,
    mfa_enabled BOOLEAN DEFAULT FALSE,
    mfa_secret VARCHAR(255),
    mfa_backup_codes TEXT[],
    last_login TIMESTAMPTZ,
    failed_login_attempts INTEGER DEFAULT 0,
    locked_until TIMESTAMPTZ,
    must_change_password BOOLEAN DEFAULT FALSE,
    password_changed_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- User sessions
CREATE TABLE user_sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    refresh_token_hash VARCHAR(255) NOT NULL,
    ip_address INET,
    user_agent TEXT,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Devices
CREATE TABLE devices (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    agent_id VARCHAR(255) UNIQUE NOT NULL,
    hostname VARCHAR(255) NOT NULL,
    display_name VARCHAR(255),
    os_type VARCHAR(50) NOT NULL,
    os_version VARCHAR(100),
    os_build VARCHAR(50),
    ip_address INET,
    mac_address VARCHAR(17),
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    status device_status DEFAULT 'offline',
    agent_version VARCHAR(20),
    cpu_model VARCHAR(255),
    cpu_cores INTEGER,
    cpu_usage DECIMAL(5,2),
    ram_total BIGINT,
    ram_used BIGINT,
    ram_usage DECIMAL(5,2),
    disk_total BIGINT,
    disk_used BIGINT,
    disk_usage DECIMAL(5,2),
    last_heartbeat TIMESTAMPTZ,
    last_inventory TIMESTAMPTZ,
    last_agent_hash VARCHAR(64),
    registered_at TIMESTAMPTZ DEFAULT NOW(),
    is_authorized BOOLEAN DEFAULT TRUE,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Device heartbeat history
CREATE TABLE device_heartbeats (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    device_id UUID REFERENCES devices(id) ON DELETE CASCADE,
    cpu_usage DECIMAL(5,2),
    ram_usage DECIMAL(5,2),
    disk_usage DECIMAL(5,2),
    network_in BIGINT DEFAULT 0,
    network_out BIGINT DEFAULT 0,
    active_processes INTEGER,
    ip_address INET,
    recorded_at TIMESTAMPTZ DEFAULT NOW()
);

-- Device installed software
CREATE TABLE device_software (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    device_id UUID REFERENCES devices(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    version VARCHAR(100),
    publisher VARCHAR(255),
    install_date DATE,
    recorded_at TIMESTAMPTZ DEFAULT NOW()
);

-- Device services
CREATE TABLE device_services (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    device_id UUID REFERENCES devices(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    display_name VARCHAR(255),
    status VARCHAR(50),
    startup_type VARCHAR(50),
    recorded_at TIMESTAMPTZ DEFAULT NOW()
);

-- Device processes
CREATE TABLE device_processes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    device_id UUID REFERENCES devices(id) ON DELETE CASCADE,
    pid INTEGER NOT NULL,
    name VARCHAR(255),
    cpu_usage DECIMAL(5,2),
    memory_usage BIGINT,
    user_name VARCHAR(255),
    recorded_at TIMESTAMPTZ DEFAULT NOW()
);

-- Device network interfaces
CREATE TABLE device_network_interfaces (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    device_id UUID REFERENCES devices(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    mac_address VARCHAR(17),
    ipv4_address INET,
    ipv6_address INET,
    is_connected BOOLEAN DEFAULT TRUE,
    speed_mbps INTEGER,
    recorded_at TIMESTAMPTZ DEFAULT NOW()
);

-- Security events
CREATE TABLE security_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    device_id UUID REFERENCES devices(id) ON DELETE SET NULL,
    event_type VARCHAR(100) NOT NULL,
    severity alert_severity DEFAULT 'info',
    title VARCHAR(255) NOT NULL,
    description TEXT,
    source VARCHAR(100),
    raw_data JSONB,
    is_resolved BOOLEAN DEFAULT FALSE,
    resolved_by UUID REFERENCES users(id),
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Alerts
CREATE TABLE alerts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    device_id UUID REFERENCES devices(id) ON DELETE SET NULL,
    alert_type alert_type NOT NULL,
    severity alert_severity NOT NULL DEFAULT 'medium',
    title VARCHAR(255) NOT NULL,
    description TEXT,
    metadata JSONB,
    is_dismissed BOOLEAN DEFAULT FALSE,
    dismissed_by UUID REFERENCES users(id),
    dismissed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Agent commands
CREATE TABLE agent_commands (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    device_id UUID REFERENCES devices(id) ON DELETE CASCADE,
    command_type command_type NOT NULL,
    parameters JSONB,
    status command_status DEFAULT 'pending',
    issued_by UUID REFERENCES users(id),
    result TEXT,
    error_message TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    executed_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ
);

-- Audit logs (immutable)
CREATE TABLE audit_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    user_email VARCHAR(255),
    action log_action NOT NULL,
    target_type VARCHAR(50),
    target_id VARCHAR(255),
    description TEXT,
    ip_address INET,
    user_agent TEXT,
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Application settings
CREATE TABLE app_settings (
    key VARCHAR(100) PRIMARY KEY,
    value TEXT,
    description TEXT,
    updated_by UUID REFERENCES users(id),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- INDEXES
-- ============================================

CREATE INDEX idx_devices_agent_id ON devices(agent_id);
CREATE INDEX idx_devices_status ON devices(status);
CREATE INDEX idx_devices_user_id ON devices(user_id);
CREATE INDEX idx_devices_last_heartbeat ON devices(last_heartbeat);

CREATE INDEX idx_heartbeats_device_id ON device_heartbeats(device_id);
CREATE INDEX idx_heartbeats_recorded_at ON device_heartbeats(recorded_at);

CREATE INDEX idx_security_events_device_id ON security_events(device_id);
CREATE INDEX idx_security_events_created_at ON security_events(created_at);
CREATE INDEX idx_security_events_severity ON security_events(severity);

CREATE INDEX idx_alerts_device_id ON alerts(device_id);
CREATE INDEX idx_alerts_alert_type ON alerts(alert_type);
CREATE INDEX idx_alerts_severity ON alerts(severity);
CREATE INDEX idx_alerts_is_dismissed ON alerts(is_dismissed);

CREATE INDEX idx_commands_device_id ON agent_commands(device_id);
CREATE INDEX idx_commands_status ON agent_commands(status);

CREATE INDEX idx_audit_logs_user_id ON audit_logs(user_id);
CREATE INDEX idx_audit_logs_action ON audit_logs(action);
CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at);
CREATE INDEX idx_audit_logs_target ON audit_logs(target_type, target_id);

CREATE INDEX idx_user_sessions_user_id ON user_sessions(user_id);
CREATE INDEX idx_user_sessions_expires_at ON user_sessions(expires_at);

-- ============================================
-- FUNCTIONS & TRIGGERS
-- ============================================

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trigger_devices_updated_at
    BEFORE UPDATE ON devices
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trigger_roles_updated_at
    BEFORE UPDATE ON roles
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Prevent audit log deletion by non-superuser
CREATE OR REPLACE FUNCTION prevent_audit_log_modification()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Audit logs cannot be modified or deleted';
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_prevent_audit_log_delete
    BEFORE DELETE ON audit_logs
    FOR EACH STATEMENT EXECUTE FUNCTION prevent_audit_log_modification();

CREATE TRIGGER trigger_prevent_audit_log_update
    BEFORE UPDATE ON audit_logs
    FOR EACH STATEMENT EXECUTE FUNCTION prevent_audit_log_modification();

-- ============================================
-- SEED DATA
-- ============================================

-- Default permissions
INSERT INTO permissions (code, name, description, category) VALUES
    ('devices.view', 'View Devices', 'View device list and details', 'devices'),
    ('devices.manage', 'Manage Devices', 'Edit device properties and settings', 'devices'),
    ('devices.block', 'Block/Unblock Devices', 'Block or unblock devices', 'devices'),
    ('devices.quarantine', 'Quarantine Devices', 'Place devices in quarantine', 'devices'),
    ('devices.commands', 'Execute Device Commands', 'Send commands to devices', 'devices'),
    ('users.view', 'View Users', 'View user list and profiles', 'users'),
    ('users.manage', 'Manage Users', 'Create, edit, and delete users', 'users'),
    ('roles.view', 'View Roles', 'View roles and permissions', 'roles'),
    ('roles.manage', 'Manage Roles', 'Create, edit, and delete roles', 'roles'),
    ('security.view', 'View Security Events', 'View security events and alerts', 'security'),
    ('security.manage', 'Manage Security', 'Dismiss alerts and manage security', 'security'),
    ('logs.view', 'View Audit Logs', 'View audit logs', 'logs'),
    ('logs.export', 'Export Audit Logs', 'Export audit logs', 'logs'),
    ('settings.view', 'View Settings', 'View application settings', 'settings'),
    ('settings.manage', 'Manage Settings', 'Change application settings', 'settings'),
    ('agents.view', 'View Agents', 'View agent information', 'agents'),
    ('agents.manage', 'Manage Agents', 'Manage agent configurations', 'agents'),
    ('network.view', 'View Network', 'View network information', 'network'),
    ('alerts.view', 'View Alerts', 'View alerts', 'alerts'),
    ('alerts.manage', 'Manage Alerts', 'Manage and dismiss alerts', 'alerts');

-- Default roles
INSERT INTO roles (name, display_name, description, is_system) VALUES
    ('admin', 'Administrator', 'Full system access', TRUE),
    ('supervisor', 'Supervisor', 'Can view and manage devices and users', TRUE),
    ('technician', 'Technician', 'Can view devices and execute commands', TRUE),
    ('user', 'User', 'Basic access to own device information', TRUE);

-- Assign all permissions to admin
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.name = 'admin';

-- Supervisor permissions
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.name = 'supervisor'
AND p.code IN ('devices.view', 'devices.manage', 'devices.block', 'devices.commands', 'users.view', 'security.view', 'security.manage', 'logs.view', 'alerts.view', 'alerts.manage', 'agents.view', 'network.view');

-- Technician permissions
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.name = 'technician'
AND p.code IN ('devices.view', 'devices.commands', 'security.view', 'agents.view', 'network.view', 'alerts.view');

-- User permissions
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.name = 'user'
AND p.code IN ('devices.view', 'alerts.view');

-- Default settings
INSERT INTO app_settings (key, value, description) VALUES
    ('heartbeat_interval', '60', 'Agent heartbeat interval in seconds'),
    ('offline_threshold', '300', 'Time in seconds before device is marked offline'),
    ('max_login_attempts', '5', 'Maximum failed login attempts before lockout'),
    ('lockout_duration', '900', 'Account lockout duration in seconds'),
    ('session_timeout', '900', 'Session timeout in seconds'),
    ('mfa_required', 'false', 'Require MFA for all users'),
    ('agent_min_version', '1.1.0', 'Minimum required agent version');

-- Admin account: created by the application on first startup from SEED_ADMIN_PASSWORD.
-- No credentials are stored in this repository.
