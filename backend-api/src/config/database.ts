import { Pool, PoolClient, QueryResult } from 'pg';
import fs from 'fs';
import path from 'path';
import logger from '../utils/logger';

let pool: Pool;

// Database configuration
const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'endpointx',
  user: process.env.DB_USER || 'endpointx',
  password: process.env.DB_PASSWORD || 'endpointx_secret',
  max: parseInt(process.env.DB_POOL_MAX || '20', 10),
  idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT || '30000', 10),
  connectionTimeoutMillis: parseInt(process.env.DB_CONNECT_TIMEOUT || '5000', 10),
};

// Wrapper that maintains compatibility with existing route code
export const query = async (text: string, params?: any[]): Promise<{ rows: any[]; rowCount: number }> => {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    const duration = Date.now() - start;

    if (duration > 1000) {
      logger.warn('Slow query detected', { text: text.substring(0, 200), duration, rowCount: result.rowCount });
    }

    return { rows: result.rows, rowCount: result.rowCount ?? 0 };
  } catch (error) {
    logger.error('Query error', { text: text.substring(0, 200), params, error: (error as Error).message });
    throw error;
  }
};

// Get a client from the pool for transactions
export const getClient = async (): Promise<PoolClient> => {
  return pool.connect();
};

// Initialize database schema
export const initDatabase = async (): Promise<void> => {
  pool = new Pool(dbConfig);

  // Test connection
  try {
    const client = await pool.connect();
    logger.info('Connected to PostgreSQL database', { host: dbConfig.host, database: dbConfig.database });
    client.release();
  } catch (error) {
    logger.error('Failed to connect to PostgreSQL', { error: (error as Error).message });
    throw error;
  }

  // Run schema migration
  await runMigrations();

  // Seed default data
  await seedDefaults();

  logger.info('Database initialized successfully');
};

// Schema migration
const runMigrations = async (): Promise<void> => {
  const schemaPath = path.join(__dirname, '..', '..', '..', 'database', 'init.sql');

  if (fs.existsSync(schemaPath)) {
    const schema = fs.readFileSync(schemaPath, 'utf-8');
    try {
      // Split by semicolons and execute each statement
      const statements = schema
        .split(';')
        .map(s => s.trim())
        .filter(s => s.length > 0 && !s.startsWith('--'));

      for (const stmt of statements) {
        try {
          await pool.query(stmt);
        } catch (err) {
          const msg = (err as Error).message;
          // Ignore "already exists" errors
          if (!msg.includes('already exists')) {
            logger.warn('Schema statement warning', { error: msg, statement: stmt.substring(0, 100) });
          }
        }
      }
      logger.info('Database schema applied from init.sql');
    } catch (error) {
      logger.error('Failed to apply schema', { error: (error as Error).message });
      throw error;
    }
  } else {
    // Inline schema creation
    await createInlineSchema();
  }
};

// Inline schema for when init.sql is not available
const createInlineSchema = async (): Promise<void> => {
  const schema = `
    CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
    CREATE EXTENSION IF NOT EXISTS "pgcrypto";

    CREATE TABLE IF NOT EXISTS roles (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      name VARCHAR(100) UNIQUE NOT NULL,
      display_name VARCHAR(150) NOT NULL,
      description TEXT,
      is_system BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS permissions (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      code VARCHAR(100) UNIQUE NOT NULL,
      name VARCHAR(150) NOT NULL,
      description TEXT,
      category VARCHAR(50) NOT NULL
    );

    CREATE TABLE IF NOT EXISTS role_permissions (
      role_id UUID REFERENCES roles(id) ON DELETE CASCADE,
      permission_id UUID REFERENCES permissions(id) ON DELETE CASCADE,
      PRIMARY KEY (role_id, permission_id)
    );

    CREATE TABLE IF NOT EXISTS users (
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

    CREATE TABLE IF NOT EXISTS user_sessions (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      refresh_token_hash VARCHAR(255) NOT NULL,
      ip_address INET,
      user_agent TEXT,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS devices (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      agent_id VARCHAR(255) UNIQUE NOT NULL,
      hostname VARCHAR(255) NOT NULL,
      display_name VARCHAR(255),
      os_type VARCHAR(50) NOT NULL,
      os_version VARCHAR(100),
      os_build VARCHAR(50),
      ip_address INET,
      mac_address VARCHAR(17),
      user_id UUID REFERENCES users(id) ON SET NULL,
      status VARCHAR(20) DEFAULT 'offline',
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
      registered_at TIMESTAMPTZ DEFAULT NOW(),
      is_authorized BOOLEAN DEFAULT TRUE,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS device_heartbeats (
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

    CREATE TABLE IF NOT EXISTS device_software (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      device_id UUID REFERENCES devices(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL,
      version VARCHAR(100),
      publisher VARCHAR(255),
      install_date DATE,
      recorded_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS device_services (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      device_id UUID REFERENCES devices(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL,
      display_name VARCHAR(255),
      status VARCHAR(50),
      startup_type VARCHAR(50),
      recorded_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS device_processes (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      device_id UUID REFERENCES devices(id) ON DELETE CASCADE,
      pid INTEGER NOT NULL,
      name VARCHAR(255),
      cpu_usage DECIMAL(5,2),
      memory_usage BIGINT,
      user_name VARCHAR(255),
      recorded_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS device_network_interfaces (
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

    CREATE TABLE IF NOT EXISTS security_events (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      device_id UUID REFERENCES devices(id) ON DELETE SET NULL,
      event_type VARCHAR(100) NOT NULL,
      severity VARCHAR(20) DEFAULT 'info',
      title VARCHAR(255) NOT NULL,
      description TEXT,
      source VARCHAR(100),
      raw_data JSONB,
      is_resolved BOOLEAN DEFAULT FALSE,
      resolved_by UUID REFERENCES users(id),
      resolved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      device_id UUID REFERENCES devices(id) ON DELETE SET NULL,
      alert_type VARCHAR(50) NOT NULL,
      severity VARCHAR(20) NOT NULL DEFAULT 'medium',
      title VARCHAR(255) NOT NULL,
      description TEXT,
      metadata JSONB,
      is_dismissed BOOLEAN DEFAULT FALSE,
      dismissed_by UUID REFERENCES users(id),
      dismissed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS agent_commands (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      device_id UUID REFERENCES devices(id) ON DELETE CASCADE,
      command_type VARCHAR(50) NOT NULL,
      parameters JSONB,
      status VARCHAR(20) DEFAULT 'pending',
      issued_by UUID REFERENCES users(id),
      result TEXT,
      error_message TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      executed_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      user_id UUID REFERENCES users(id) ON SET NULL,
      user_email VARCHAR(255),
      action VARCHAR(50) NOT NULL,
      target_type VARCHAR(50),
      target_id VARCHAR(255),
      description TEXT,
      ip_address INET,
      user_agent TEXT,
      metadata JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key VARCHAR(100) PRIMARY KEY,
      value TEXT,
      description TEXT,
      updated_by UUID REFERENCES users(id),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_devices_agent_id ON devices(agent_id);
    CREATE INDEX IF NOT EXISTS idx_devices_status ON devices(status);
    CREATE INDEX IF NOT EXISTS idx_devices_user_id ON devices(user_id);
    CREATE INDEX IF NOT EXISTS idx_devices_last_heartbeat ON devices(last_heartbeat);
    CREATE INDEX IF NOT EXISTS idx_heartbeats_device_id ON device_heartbeats(device_id);
    CREATE INDEX IF NOT EXISTS idx_heartbeats_recorded_at ON device_heartbeats(recorded_at);
    CREATE INDEX IF NOT EXISTS idx_security_events_device_id ON security_events(device_id);
    CREATE INDEX IF NOT EXISTS idx_security_events_created_at ON security_events(created_at);
    CREATE INDEX IF NOT EXISTS idx_alerts_device_id ON alerts(device_id);
    CREATE INDEX IF NOT EXISTS idx_alerts_alert_type ON alerts(alert_type);
    CREATE INDEX IF NOT EXISTS idx_alerts_severity ON alerts(severity);
    CREATE INDEX IF NOT EXISTS idx_alerts_is_dismissed ON alerts(is_dismissed);
    CREATE INDEX IF NOT EXISTS idx_commands_device_id ON agent_commands(device_id);
    CREATE INDEX IF NOT EXISTS idx_commands_status ON agent_commands(status);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_sessions_expires_at ON user_sessions(expires_at);
  `;

  await pool.query(schema);
  logger.info('Inline database schema created');
};

// Seed default data
const seedDefaults = async (): Promise<void> => {
  const result = await pool.query('SELECT COUNT(*) as count FROM roles');
  const count = parseInt(result.rows[0]?.count || '0', 10);
  if (count > 0) return;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Insert permissions
    const permissions = [
      ['devices.view', 'View Devices', 'View device list and details', 'devices'],
      ['devices.manage', 'Manage Devices', 'Edit device properties and settings', 'devices'],
      ['devices.block', 'Block/Unblock Devices', 'Block or unblock devices', 'devices'],
      ['devices.quarantine', 'Quarantine Devices', 'Place devices in quarantine', 'devices'],
      ['devices.commands', 'Execute Device Commands', 'Send commands to devices', 'devices'],
      ['users.view', 'View Users', 'View user list and profiles', 'users'],
      ['users.manage', 'Manage Users', 'Create, edit, and delete users', 'users'],
      ['roles.view', 'View Roles', 'View roles and permissions', 'roles'],
      ['roles.manage', 'Manage Roles', 'Create, edit, and delete roles', 'roles'],
      ['security.view', 'View Security Events', 'View security events and alerts', 'security'],
      ['security.manage', 'Manage Security', 'Dismiss alerts and manage security', 'security'],
      ['logs.view', 'View Audit Logs', 'View audit logs', 'logs'],
      ['logs.export', 'Export Audit Logs', 'Export audit logs', 'logs'],
      ['settings.view', 'View Settings', 'View application settings', 'settings'],
      ['settings.manage', 'Manage Settings', 'Change application settings', 'settings'],
      ['agents.view', 'View Agents', 'View agent information', 'agents'],
      ['agents.manage', 'Manage Agents', 'Manage agent configurations', 'agents'],
      ['network.view', 'View Network', 'View network information', 'network'],
      ['alerts.view', 'View Alerts', 'View alerts', 'alerts'],
      ['alerts.manage', 'Manage Alerts', 'Manage and dismiss alerts', 'alerts'],
    ];

    for (const [code, name, desc, category] of permissions) {
      await client.query(
        'INSERT INTO permissions (code, name, description, category) VALUES ($1, $2, $3, $4) ON CONFLICT (code) DO NOTHING',
        [code, name, desc, category]
      );
    }

    // Insert roles
    const roles = [
      ['admin', 'Administrator', 'Full system access', true],
      ['supervisor', 'Supervisor', 'Can view and manage devices and users', true],
      ['technician', 'Technician', 'Can view devices and execute commands', true],
      ['user', 'User', 'Basic access to own device information', true],
    ];

    for (const [name, displayName, desc, isSystem] of roles) {
      await client.query(
        'INSERT INTO roles (name, display_name, description, is_system) VALUES ($1, $2, $3, $4) ON CONFLICT (name) DO NOTHING',
        [name, displayName, desc, isSystem]
      );
    }

    // Assign permissions to roles
    const rolePerms: Record<string, string[]> = {
      admin: permissions.map(p => p[0]),
      supervisor: ['devices.view', 'devices.manage', 'devices.block', 'devices.commands', 'users.view', 'security.view', 'security.manage', 'logs.view', 'alerts.view', 'alerts.manage', 'agents.view', 'network.view'],
      technician: ['devices.view', 'devices.commands', 'security.view', 'agents.view', 'network.view', 'alerts.view'],
      user: ['devices.view', 'alerts.view'],
    };

    for (const [roleName, permCodes] of Object.entries(rolePerms)) {
      const roleResult = await client.query('SELECT id FROM roles WHERE name = $1', [roleName]);
      if (roleResult.rows.length === 0) continue;
      const roleId = roleResult.rows[0].id;

      for (const permCode of permCodes) {
        await client.query(
          'INSERT INTO role_permissions (role_id, permission_id) SELECT $1, id FROM permissions WHERE code = $2 ON CONFLICT DO NOTHING',
          [roleId, permCode]
        );
      }
    }

    // Default admin user (password: REDACTED_PASSWORD)
    const bcrypt = require('bcryptjs');
    const hash = bcrypt.hashSync('REDACTED_PASSWORD', 12);
    await client.query(
      `INSERT INTO users (email, username, full_name, password_hash, role_id)
       SELECT 'admin@endpointx.local', 'admin', 'System Administrator', $1, id FROM roles WHERE name = 'admin'
       ON CONFLICT (email) DO NOTHING`,
      [hash]
    );

    // Default settings
    const settings = [
      ['heartbeat_interval', '60', 'Agent heartbeat interval in seconds'],
      ['offline_threshold', '300', 'Time in seconds before device is marked offline'],
      ['max_login_attempts', '5', 'Maximum failed login attempts before lockout'],
      ['lockout_duration', '900', 'Account lockout duration in seconds'],
      ['session_timeout', '900', 'Session timeout in seconds'],
      ['mfa_required', 'false', 'Require MFA for all users'],
      ['agent_min_version', '1.0.0', 'Minimum required agent version'],
    ];

    for (const [key, value, desc] of settings) {
      await client.query(
        'INSERT INTO app_settings (key, value, description) VALUES ($1, $2, $3) ON CONFLICT (key) DO NOTHING',
        [key, value, desc]
      );
    }

    await client.query('COMMIT');
    logger.info('Default data seeded successfully');
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('Failed to seed default data', { error: (error as Error).message });
    throw error;
  } finally {
    client.release();
  }
};

// Graceful shutdown
export const closeDatabase = async (): Promise<void> => {
  if (pool) {
    await pool.end();
    logger.info('Database pool closed');
  }
};

export default { query, initDatabase, closeDatabase, getClient };
