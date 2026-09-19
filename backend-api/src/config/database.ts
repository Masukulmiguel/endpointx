import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import path from 'path';
import fs from 'fs';

let db: SqlJsDatabase;
const dbPath = path.join(__dirname, '../../data/endpointx.db');

// Ensure data directory exists
const dataDir = path.dirname(dbPath);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Load or create database
const loadDatabase = async (): Promise<SqlJsDatabase> => {
  const SQL = await initSqlJs();

  if (fs.existsSync(dbPath)) {
    const buffer = fs.readFileSync(dbPath);
    return new SQL.Database(buffer);
  }

  return new SQL.Database();
};

// Save database to file
const saveDatabase = () => {
  if (db) {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(dbPath, buffer);
  }
};

// Auto-save periodically
setInterval(saveDatabase, 5000);

// Wrapper to mimic pg pool.query interface
export const query = (text: string, params?: any[]): any => {
  const start = Date.now();
  try {
    // Convert PostgreSQL-style $1, $2 params to SQLite ? style
    let sqliteQuery = text.replace(/\$\d+/g, '?');

    // Handle NOW() for SQLite
    sqliteQuery = sqliteQuery.replace(/NOW\(\)/g, "datetime('now')");
    // Handle ::int cast
    sqliteQuery = sqliteQuery.replace(/::int/g, '');

    // Check query type
    const trimmedUpper = sqliteQuery.trim().toUpperCase();
    const isSelect = trimmedUpper.startsWith('SELECT');
    const hasReturning = sqliteQuery.toUpperCase().includes('RETURNING');

    let rows;
    if (isSelect || hasReturning) {
      const stmt = db.prepare(sqliteQuery);
      if (params && params.length > 0) {
        stmt.bind(params);
      }
      rows = [];
      while (stmt.step()) {
        rows.push(stmt.getAsObject());
      }
      stmt.free();
    } else {
      db.run(sqliteQuery, params || []);
      // Get last insert rowid and changes count
      const changesResult = db.exec('SELECT changes() as changes, last_insert_rowid() as lastInsertRowid');
      const changes = changesResult.length > 0 ? changesResult[0].values[0][0] : 0;
      const lastInsertRowid = changesResult.length > 0 ? changesResult[0].values[0][1] : 0;
      rows = [{ changes, lastInsertRowid }];
    }

    const duration = Date.now() - start;
    if (duration > 1000) {
      console.warn(`Slow query (${duration}ms):`, text);
    }

    return { rows, rowCount: rows ? rows.length : 0 };
  } catch (error) {
    console.error('Query error:', { text, params, error });
    throw error;
  }
};

// Initialize database schema
export const initDatabase = async () => {
  db = await loadDatabase();

  db.run('PRAGMA journal_mode = WAL');
  db.run('PRAGMA foreign_keys = ON');

  db.run(`
    CREATE TABLE IF NOT EXISTS roles (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      display_name TEXT NOT NULL,
      description TEXT,
      is_system INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS permissions (
      id TEXT PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      category TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS role_permissions (
      role_id TEXT REFERENCES roles(id) ON DELETE CASCADE,
      permission_id TEXT REFERENCES permissions(id) ON DELETE CASCADE,
      PRIMARY KEY (role_id, permission_id)
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      username TEXT UNIQUE NOT NULL,
      full_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role_id TEXT REFERENCES roles(id),
      is_active INTEGER DEFAULT 1,
      mfa_enabled INTEGER DEFAULT 0,
      mfa_secret TEXT,
      last_login TEXT,
      login_attempts INTEGER DEFAULT 0,
      locked_until TEXT,
      password_changed_at TEXT DEFAULT (datetime('now')),
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS user_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL,
      ip_address TEXT,
      user_agent TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      agent_id TEXT UNIQUE NOT NULL,
      hostname TEXT NOT NULL,
      display_name TEXT,
      os_type TEXT NOT NULL,
      os_version TEXT,
      os_build TEXT,
      ip_address TEXT,
      mac_address TEXT,
      user_id TEXT REFERENCES users(id),
      status TEXT DEFAULT 'offline',
      agent_version TEXT,
      cpu_model TEXT,
      cpu_cores INTEGER,
      cpu_usage REAL,
      ram_total INTEGER,
      ram_used INTEGER,
      ram_usage REAL,
      disk_total INTEGER,
      disk_used INTEGER,
      disk_usage REAL,
      last_heartbeat TEXT,
      last_inventory TEXT,
      registered_at TEXT DEFAULT (datetime('now')),
      is_authorized INTEGER DEFAULT 1,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS device_heartbeats (
      id TEXT PRIMARY KEY,
      device_id TEXT REFERENCES devices(id) ON DELETE CASCADE,
      cpu_usage REAL,
      ram_usage REAL,
      disk_usage REAL,
      network_in INTEGER DEFAULT 0,
      network_out INTEGER DEFAULT 0,
      active_processes INTEGER,
      ip_address TEXT,
      recorded_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS device_software (
      id TEXT PRIMARY KEY,
      device_id TEXT REFERENCES devices(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      version TEXT,
      publisher TEXT,
      install_date TEXT,
      recorded_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS device_services (
      id TEXT PRIMARY KEY,
      device_id TEXT REFERENCES devices(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      display_name TEXT,
      status TEXT,
      startup_type TEXT,
      recorded_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS device_processes (
      id TEXT PRIMARY KEY,
      device_id TEXT REFERENCES devices(id) ON DELETE CASCADE,
      pid INTEGER NOT NULL,
      name TEXT,
      cpu_usage REAL,
      memory_usage INTEGER,
      user_name TEXT,
      recorded_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS device_network_interfaces (
      id TEXT PRIMARY KEY,
      device_id TEXT REFERENCES devices(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      mac_address TEXT,
      ipv4_address TEXT,
      ipv6_address TEXT,
      is_connected INTEGER DEFAULT 1,
      speed_mbps INTEGER,
      recorded_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS security_events (
      id TEXT PRIMARY KEY,
      device_id TEXT REFERENCES devices(id),
      event_type TEXT NOT NULL,
      severity TEXT DEFAULT 'info',
      title TEXT NOT NULL,
      description TEXT,
      source TEXT,
      raw_data TEXT,
      is_resolved INTEGER DEFAULT 0,
      resolved_by TEXT REFERENCES users(id),
      resolved_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id TEXT PRIMARY KEY,
      device_id TEXT REFERENCES devices(id),
      alert_type TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'medium',
      title TEXT NOT NULL,
      description TEXT,
      metadata TEXT,
      is_dismissed INTEGER DEFAULT 0,
      dismissed_by TEXT REFERENCES users(id),
      dismissed_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS agent_commands (
      id TEXT PRIMARY KEY,
      device_id TEXT REFERENCES devices(id) ON DELETE CASCADE,
      command_type TEXT NOT NULL,
      parameters TEXT,
      status TEXT DEFAULT 'pending',
      issued_by TEXT REFERENCES users(id),
      result TEXT,
      error_message TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      executed_at TEXT,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      user_email TEXT,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      description TEXT,
      ip_address TEXT,
      user_agent TEXT,
      metadata TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      description TEXT,
      updated_by TEXT REFERENCES users(id),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Seed default data
  seedDefaults();

  saveDatabase();
};

const generateId = (): string => {
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
};

const seedDefaults = () => {
  const result = db.exec('SELECT COUNT(*) as count FROM roles');
  const count = result.length > 0 ? result[0].values[0][0] : 0;
  if (count > 0) return;

  // Insert roles
  const roles = [
    ['role_admin', 'admin', 'Administrator', 'Full system access', 1],
    ['role_supervisor', 'supervisor', 'Supervisor', 'Can view and manage devices and users', 1],
    ['role_technician', 'technician', 'Technician', 'Can view devices and execute commands', 1],
    ['role_user', 'user', 'User', 'Basic access to own device information', 1],
  ];

  roles.forEach(r => {
    db.run('INSERT INTO roles (id, name, display_name, description, is_system) VALUES (?, ?, ?, ?, ?)', r);
  });

  // Insert permissions
  const permissions = [
    ['perm_devices_view', 'devices.view', 'View Devices', 'View device list and details', 'devices'],
    ['perm_devices_manage', 'devices.manage', 'Manage Devices', 'Edit device properties and settings', 'devices'],
    ['perm_devices_block', 'devices.block', 'Block/Unblock Devices', 'Block or unblock devices', 'devices'],
    ['perm_devices_quarantine', 'devices.quarantine', 'Quarantine Devices', 'Place devices in quarantine', 'devices'],
    ['perm_devices_commands', 'devices.commands', 'Execute Device Commands', 'Send commands to devices', 'devices'],
    ['perm_users_view', 'users.view', 'View Users', 'View user list and profiles', 'users'],
    ['perm_users_manage', 'users.manage', 'Manage Users', 'Create, edit, and delete users', 'users'],
    ['perm_roles_view', 'roles.view', 'View Roles', 'View roles and permissions', 'roles'],
    ['perm_roles_manage', 'roles.manage', 'Manage Roles', 'Create, edit, and delete roles', 'roles'],
    ['perm_security_view', 'security.view', 'View Security Events', 'View security events and alerts', 'security'],
    ['perm_security_manage', 'security.manage', 'Manage Security', 'Dismiss alerts and manage security', 'security'],
    ['perm_logs_view', 'logs.view', 'View Audit Logs', 'View audit logs', 'logs'],
    ['perm_logs_export', 'logs.export', 'Export Audit Logs', 'Export audit logs', 'logs'],
    ['perm_settings_view', 'settings.view', 'View Settings', 'View application settings', 'settings'],
    ['perm_settings_manage', 'settings.manage', 'Manage Settings', 'Change application settings', 'settings'],
    ['perm_agents_view', 'agents.view', 'View Agents', 'View agent information', 'agents'],
    ['perm_agents_manage', 'agents.manage', 'Manage Agents', 'Manage agent configurations', 'agents'],
    ['perm_network_view', 'network.view', 'View Network', 'View network information', 'network'],
    ['perm_alerts_view', 'alerts.view', 'View Alerts', 'View alerts', 'alerts'],
    ['perm_alerts_manage', 'alerts.manage', 'Manage Alerts', 'Manage and dismiss alerts', 'alerts'],
  ];

  permissions.forEach(p => {
    db.run('INSERT INTO permissions (id, code, name, description, category) VALUES (?, ?, ?, ?, ?)', p);
  });

  // Assign all permissions to admin
  permissions.forEach(p => {
    db.run('INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)', ['role_admin', p[0]]);
  });

  // Supervisor permissions
  ['perm_devices_view', 'perm_devices_manage', 'perm_devices_block', 'perm_devices_commands', 'perm_users_view', 'perm_security_view', 'perm_security_manage', 'perm_logs_view', 'perm_alerts_view', 'perm_alerts_manage', 'perm_agents_view', 'perm_network_view'].forEach(p => {
    db.run('INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)', ['role_supervisor', p]);
  });

  // Technician permissions
  ['perm_devices_view', 'perm_devices_commands', 'perm_security_view', 'perm_agents_view', 'perm_network_view', 'perm_alerts_view'].forEach(p => {
    db.run('INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)', ['role_technician', p]);
  });

  // User permissions
  ['perm_devices_view', 'perm_alerts_view'].forEach(p => {
    db.run('INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)', ['role_user', p]);
  });

  // Default admin user (password: REDACTED_PASSWORD)
  const bcrypt = require('bcryptjs');
  const hash = bcrypt.hashSync('REDACTED_PASSWORD', 10);
  db.run('INSERT INTO users (id, email, username, full_name, password_hash, role_id) VALUES (?, ?, ?, ?, ?, ?)',
    ['user_admin', 'admin@endpointx.local', 'admin', 'System Administrator', hash, 'role_admin']);

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

  settings.forEach(s => {
    db.run('INSERT INTO app_settings (key, value, description) VALUES (?, ?, ?)', s);
  });
};

export { db, saveDatabase };
export default { query, initDatabase };
