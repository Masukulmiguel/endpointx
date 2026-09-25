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

// Schema migration - always use inline schema (no file dependency)
const runMigrations = async (): Promise<void> => {
  await createInlineSchema();
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

    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      token_hash VARCHAR(255) NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_hash ON password_reset_tokens(token_hash);

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
      user_id UUID REFERENCES users(id) ON DELETE SET NULL,
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
      last_agent_hash VARCHAR(64),
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
      user_id UUID REFERENCES users(id) ON DELETE SET NULL,
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

    CREATE TABLE IF NOT EXISTS device_groups (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      name VARCHAR(100) UNIQUE NOT NULL,
      description TEXT,
      color VARCHAR(7) DEFAULT '#0080ff',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS device_group_members (
      group_id UUID REFERENCES device_groups(id) ON DELETE CASCADE,
      device_id UUID REFERENCES devices(id) ON DELETE CASCADE,
      PRIMARY KEY (group_id, device_id)
    );

    CREATE TABLE IF NOT EXISTS compliance_policies (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      name VARCHAR(100) NOT NULL,
      description TEXT,
      rules JSONB NOT NULL DEFAULT '{}',
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS policy_assignments (
      policy_id UUID REFERENCES compliance_policies(id) ON DELETE CASCADE,
      group_id UUID REFERENCES device_groups(id) ON DELETE CASCADE,
      PRIMARY KEY (policy_id, group_id)
    );

    CREATE TABLE IF NOT EXISTS compliance_results (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      device_id UUID REFERENCES devices(id) ON DELETE CASCADE,
      policy_id UUID REFERENCES compliance_policies(id) ON DELETE CASCADE,
      is_compliant BOOLEAN NOT NULL,
      violations JSONB DEFAULT '[]',
      checked_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS software_packages (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      name VARCHAR(100) NOT NULL,
      version VARCHAR(50),
      installer_url TEXT NOT NULL,
      installer_type VARCHAR(10) NOT NULL,
      silent_args TEXT DEFAULT '/quiet /norestart',
      uninstall_args TEXT DEFAULT '/quiet',
      file_size BIGINT DEFAULT 0,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS software_deployments (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      package_id UUID REFERENCES software_packages(id) ON DELETE CASCADE,
      device_id UUID REFERENCES devices(id) ON DELETE CASCADE,
      status VARCHAR(20) DEFAULT 'pending',
      installed_at TIMESTAMPTZ,
      error_message TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS notification_log (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      recipient_email VARCHAR(255) NOT NULL,
      subject VARCHAR(255) NOT NULL,
      body TEXT,
      status VARCHAR(20) DEFAULT 'pending',
      sent_at TIMESTAMPTZ,
      error_message TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS device_commands_extended (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      command_id UUID REFERENCES agent_commands(id) ON DELETE CASCADE,
      action VARCHAR(50) NOT NULL,
      package_id UUID REFERENCES software_packages(id) ON DELETE SET NULL,
      parameters JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS user_mfa (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      mfa_secret TEXT,
      enabled BOOLEAN DEFAULT FALSE,
      method VARCHAR(10) DEFAULT 'totp',
      backup_codes TEXT DEFAULT '[]',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS hermes_scan_policies (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      name VARCHAR(100) UNIQUE NOT NULL,
      description TEXT,
      ports TEXT,
      excluded_ports TEXT,
      excluded_hosts TEXT,
      max_concurrency INTEGER DEFAULT 5,
      request_timeout_ms INTEGER DEFAULT 2000,
      rate_limit_per_sec INTEGER DEFAULT 20,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS hermes_scans (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      scan_type VARCHAR(50) NOT NULL,
      policy_id UUID REFERENCES hermes_scan_policies(id),
      status VARCHAR(20) DEFAULT 'pending',
      scope TEXT[],
      started_by UUID REFERENCES users(id),
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      stats JSONB DEFAULT '{}',
      error_message TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS hermes_assets (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      device_id UUID REFERENCES devices(id) ON DELETE SET NULL,
      hostname VARCHAR(255),
      ip_address TEXT,
      os_type VARCHAR(50),
      os_version VARCHAR(100),
      is_authorized BOOLEAN DEFAULT FALSE,
      agent_online BOOLEAN DEFAULT FALSE,
      last_seen TIMESTAMPTZ,
      internet_exposed BOOLEAN DEFAULT FALSE,
      posture_score INTEGER DEFAULT 0,
      posture_factors JSONB DEFAULT '{}',
      metadata JSONB DEFAULT '{}',
      first_seen TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS hermes_ports (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      asset_id UUID REFERENCES hermes_assets(id) ON DELETE CASCADE,
      scan_id UUID REFERENCES hermes_scans(id) ON DELETE SET NULL,
      port INTEGER NOT NULL,
      protocol VARCHAR(10) NOT NULL DEFAULT 'tcp',
      state VARCHAR(20) NOT NULL DEFAULT 'unknown',
      service VARCHAR(100),
      product VARCHAR(150),
      version VARCHAR(100),
      banner TEXT,
      detection_method VARCHAR(50),
      confidence DECIMAL(5,2) DEFAULT 0,
      risk VARCHAR(20) DEFAULT 'info',
      first_seen TIMESTAMPTZ DEFAULT NOW(),
      last_seen TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(asset_id, port, protocol)
    );

    CREATE TABLE IF NOT EXISTS hermes_services (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      asset_id UUID REFERENCES hermes_assets(id) ON DELETE CASCADE,
      port_id UUID REFERENCES hermes_ports(id) ON DELETE CASCADE,
      name VARCHAR(100),
      product VARCHAR(150),
      version VARCHAR(100),
      cpe TEXT,
      confidence DECIMAL(5,2) DEFAULT 0,
      detection_method VARCHAR(50),
      detected_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS hermes_cves (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      cve_id VARCHAR(30) UNIQUE NOT NULL,
      cvss_score DECIMAL(4,1),
      severity VARCHAR(20),
      description TEXT,
      affected_product VARCHAR(150),
      affected_version VARCHAR(100),
      cpe TEXT,
      remediation TEXT,
      cve_references TEXT[],
      source VARCHAR(50) DEFAULT 'local',
      published_at TIMESTAMPTZ,
      fetched_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS hermes_findings (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      scan_id UUID REFERENCES hermes_scans(id) ON DELETE SET NULL,
      asset_id UUID REFERENCES hermes_assets(id) ON DELETE CASCADE,
      port_id UUID REFERENCES hermes_ports(id) ON DELETE SET NULL,
      cve_id VARCHAR(30),
      finding_type VARCHAR(50) NOT NULL,
      severity VARCHAR(20) NOT NULL DEFAULT 'info',
      title VARCHAR(255) NOT NULL,
      description TEXT,
      evidence JSONB DEFAULT '[]',
      confidence DECIMAL(5,2) DEFAULT 0,
      risk_score DECIMAL(5,2) DEFAULT 0,
      risk_reasons TEXT[],
      is_potential BOOLEAN DEFAULT FALSE,
      status VARCHAR(30) DEFAULT 'open',
      acknowledged_by UUID REFERENCES users(id),
      acknowledged_at TIMESTAMPTZ,
      acknowledged_reason TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS hermes_risk_scores (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      asset_id UUID REFERENCES hermes_assets(id) ON DELETE CASCADE,
      score INTEGER NOT NULL DEFAULT 0,
      grade VARCHAR(10),
      confidence DECIMAL(5,2) DEFAULT 0,
      factors JSONB DEFAULT '{}',
      reasons TEXT[],
      calculated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS hermes_alerts (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      alert_type VARCHAR(50) NOT NULL,
      severity VARCHAR(20) NOT NULL DEFAULT 'medium',
      asset_id UUID REFERENCES hermes_assets(id) ON DELETE SET NULL,
      title VARCHAR(255) NOT NULL,
      description TEXT,
      evidence JSONB DEFAULT '[]',
      recommended_action TEXT,
      is_open BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS hermes_recommendations (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      finding_id UUID REFERENCES hermes_findings(id) ON DELETE CASCADE,
      asset_id UUID REFERENCES hermes_assets(id) ON DELETE SET NULL,
      title VARCHAR(255) NOT NULL,
      description TEXT,
      action_type VARCHAR(50),
      action_payload JSONB DEFAULT '{}',
      status VARCHAR(20) DEFAULT 'pending',
      requires_approval BOOLEAN DEFAULT TRUE,
      decided_by UUID REFERENCES users(id),
      decided_at TIMESTAMPTZ,
      decision_reason TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS hermes_baselines (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      asset_id UUID REFERENCES hermes_assets(id) ON DELETE CASCADE,
      baseline_type VARCHAR(50) NOT NULL,
      snapshot JSONB NOT NULL DEFAULT '{}',
      captured_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(asset_id, baseline_type)
    );

    CREATE TABLE IF NOT EXISTS hermes_exceptions (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      finding_id UUID REFERENCES hermes_findings(id) ON DELETE CASCADE,
      exception_type VARCHAR(30) NOT NULL,
      reason TEXT,
      created_by UUID REFERENCES users(id),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      expires_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS hermes_audit_logs (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      action VARCHAR(80) NOT NULL,
      actor_id UUID REFERENCES users(id),
      actor_email VARCHAR(255),
      target_type VARCHAR(50),
      target_id VARCHAR(255),
      details JSONB DEFAULT '{}',
      ip_address TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
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
    CREATE INDEX IF NOT EXISTS idx_device_groups_name ON device_groups(name);
    CREATE INDEX IF NOT EXISTS idx_device_group_members_device_id ON device_group_members(device_id);
    CREATE INDEX IF NOT EXISTS idx_compliance_policies_is_active ON compliance_policies(is_active);
    CREATE INDEX IF NOT EXISTS idx_compliance_results_device_id ON compliance_results(device_id);
    CREATE INDEX IF NOT EXISTS idx_compliance_results_policy_id ON compliance_results(policy_id);
    CREATE INDEX IF NOT EXISTS idx_compliance_results_checked_at ON compliance_results(checked_at);
    CREATE INDEX IF NOT EXISTS idx_software_packages_name ON software_packages(name);
    CREATE INDEX IF NOT EXISTS idx_software_deployments_device_id ON software_deployments(device_id);
    CREATE INDEX IF NOT EXISTS idx_software_deployments_package_id ON software_deployments(package_id);
    CREATE INDEX IF NOT EXISTS idx_software_deployments_status ON software_deployments(status);
    CREATE INDEX IF NOT EXISTS idx_notification_log_status ON notification_log(status);
    CREATE INDEX IF NOT EXISTS idx_notification_log_recipient ON notification_log(recipient_email);
    CREATE INDEX IF NOT EXISTS idx_user_mfa_user_id ON user_mfa(user_id);
    CREATE INDEX IF NOT EXISTS idx_hermes_scans_status ON hermes_scans(status);
    CREATE INDEX IF NOT EXISTS idx_hermes_scans_created ON hermes_scans(created_at);
    CREATE INDEX IF NOT EXISTS idx_hermes_assets_ip ON hermes_assets(ip_address);
    CREATE INDEX IF NOT EXISTS idx_hermes_assets_device ON hermes_assets(device_id);
    CREATE INDEX IF NOT EXISTS idx_hermes_ports_asset ON hermes_ports(asset_id);
    CREATE INDEX IF NOT EXISTS idx_hermes_ports_state ON hermes_ports(state);
    CREATE INDEX IF NOT EXISTS idx_hermes_findings_asset ON hermes_findings(asset_id);
    CREATE INDEX IF NOT EXISTS idx_hermes_findings_severity ON hermes_findings(severity);
    CREATE INDEX IF NOT EXISTS idx_hermes_findings_status ON hermes_findings(status);
    CREATE INDEX IF NOT EXISTS idx_hermes_alerts_open ON hermes_alerts(is_open);
    CREATE INDEX IF NOT EXISTS idx_hermes_recommendations_status ON hermes_recommendations(status);
    CREATE INDEX IF NOT EXISTS idx_hermes_audit_created ON hermes_audit_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_hermes_cves_cve ON hermes_cves(cve_id);

    DO $$ BEGIN
      ALTER TABLE users ADD COLUMN IF NOT EXISTS sso_provider_id VARCHAR(100);
    EXCEPTION WHEN duplicate_column THEN null;
    END $$;

    DO $$ BEGIN
      ALTER TABLE users ADD COLUMN IF NOT EXISTS sso_subject VARCHAR(255);
    EXCEPTION WHEN duplicate_column THEN null;
    END $$;

    DO $$ BEGIN
      ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_agent_hash VARCHAR(64);
    EXCEPTION WHEN duplicate_column THEN null;
    END $$;

    ALTER TABLE devices ADD COLUMN IF NOT EXISTS device_type VARCHAR(30) DEFAULT 'UNKNOWN';
    ALTER TABLE devices ADD COLUMN IF NOT EXISTS manufacturer VARCHAR(150);
    ALTER TABLE devices ADD COLUMN IF NOT EXISTS model VARCHAR(150);
    ALTER TABLE devices ADD COLUMN IF NOT EXISTS ipv6_address TEXT;
    ALTER TABLE devices ADD COLUMN IF NOT EXISTS vlan VARCHAR(50);
    ALTER TABLE devices ADD COLUMN IF NOT EXISTS ssid VARCHAR(150);
    ALTER TABLE devices ADD COLUMN IF NOT EXISTS switch_name VARCHAR(150);
    ALTER TABLE devices ADD COLUMN IF NOT EXISTS switch_port VARCHAR(50);
    ALTER TABLE devices ADD COLUMN IF NOT EXISTS access_point VARCHAR(150);
    ALTER TABLE devices ADD COLUMN IF NOT EXISTS location VARCHAR(200);
    ALTER TABLE devices ADD COLUMN IF NOT EXISTS ownership VARCHAR(20) DEFAULT 'CORPORATE';
    ALTER TABLE devices ADD COLUMN IF NOT EXISTS trust_level VARCHAR(20) DEFAULT 'UNKNOWN';
    ALTER TABLE devices ADD COLUMN IF NOT EXISTS quarantine_status VARCHAR(20) DEFAULT 'NORMAL';
    ALTER TABLE devices ADD COLUMN IF NOT EXISTS security_score INTEGER DEFAULT 0;
    ALTER TABLE devices ADD COLUMN IF NOT EXISTS security_posture JSONB DEFAULT '{}';
    ALTER TABLE devices ADD COLUMN IF NOT EXISTS managed BOOLEAN DEFAULT FALSE;
    ALTER TABLE devices ADD COLUMN IF NOT EXISTS mdm_enrolled BOOLEAN DEFAULT FALSE;
    ALTER TABLE devices ADD COLUMN IF NOT EXISTS encryption_status VARCHAR(20);
    ALTER TABLE devices ADD COLUMN IF NOT EXISTS security_patch_level VARCHAR(50);
    ALTER TABLE devices ADD COLUMN IF NOT EXISTS department VARCHAR(100);
    ALTER TABLE devices ADD COLUMN IF NOT EXISTS approval_status VARCHAR(20) DEFAULT 'approved';
    ALTER TABLE devices ADD COLUMN IF NOT EXISTS battery_level INTEGER;
    ALTER TABLE devices ADD COLUMN IF NOT EXISTS first_seen TIMESTAMPTZ DEFAULT NOW();

    CREATE TABLE IF NOT EXISTS network_discovery_runs (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      source VARCHAR(40) NOT NULL,
      status VARCHAR(20) DEFAULT 'running',
      stats JSONB DEFAULT '{}',
      error_message TEXT,
      started_by UUID REFERENCES users(id),
      started_at TIMESTAMPTZ DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS network_nodes (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      node_type VARCHAR(40) NOT NULL,
      name VARCHAR(200),
      hostname VARCHAR(255),
      ip_address TEXT,
      mac_address VARCHAR(17),
      vendor VARCHAR(150),
      parent_id UUID REFERENCES network_nodes(id) ON DELETE SET NULL,
      vlan VARCHAR(50),
      site VARCHAR(100),
      metadata JSONB DEFAULT '{}',
      source VARCHAR(40),
      device_id UUID REFERENCES devices(id) ON DELETE SET NULL,
      first_seen TIMESTAMPTZ DEFAULT NOW(),
      last_seen TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS nac_policies (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      name VARCHAR(150) NOT NULL,
      priority INTEGER DEFAULT 100,
      description TEXT,
      conditions JSONB NOT NULL DEFAULT '{}',
      action VARCHAR(30) NOT NULL DEFAULT 'LIMITED_ACCESS',
      vlan VARCHAR(50),
      is_active BOOLEAN DEFAULT TRUE,
      created_by UUID REFERENCES users(id),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS nac_decisions (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      device_id UUID REFERENCES devices(id) ON DELETE CASCADE,
      policy_id UUID REFERENCES nac_policies(id) ON DELETE SET NULL,
      decision VARCHAR(30) NOT NULL,
      reason TEXT,
      evidence JSONB DEFAULT '[]',
      auto_applied BOOLEAN DEFAULT FALSE,
      created_by UUID REFERENCES users(id),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS security_incidents (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      incident_id VARCHAR(40) UNIQUE NOT NULL,
      severity VARCHAR(20) NOT NULL DEFAULT 'medium',
      status VARCHAR(30) DEFAULT 'detection',
      title VARCHAR(255) NOT NULL,
      description TEXT,
      affected_devices UUID[],
      detection_source VARCHAR(50),
      evidence JSONB DEFAULT '[]',
      timeline JSONB DEFAULT '[]',
      actions_taken JSONB DEFAULT '[]',
      resolution TEXT,
      assigned_to UUID REFERENCES users(id),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS device_events (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      device_id UUID REFERENCES devices(id) ON DELETE CASCADE,
      event_type VARCHAR(60) NOT NULL,
      severity VARCHAR(20) DEFAULT 'info',
      title VARCHAR(255) NOT NULL,
      description TEXT,
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS network_monitor_metrics (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      device_id UUID REFERENCES devices(id) ON DELETE CASCADE,
      metric_type VARCHAR(40) NOT NULL,
      value DECIMAL(18,4),
      labels JSONB DEFAULT '{}',
      recorded_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS connectors (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      name VARCHAR(100) NOT NULL,
      vendor VARCHAR(50) NOT NULL,
      connector_type VARCHAR(40) NOT NULL,
      config JSONB DEFAULT '{}',
      capabilities JSONB DEFAULT '{}',
      is_enabled BOOLEAN DEFAULT TRUE,
      status VARCHAR(20) DEFAULT 'not_configured',
      last_sync TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_devices_device_type ON devices(device_type);
    ALTER TABLE devices ADD COLUMN IF NOT EXISTS device_type VARCHAR(30) DEFAULT 'UNKNOWN';
    ALTER TABLE devices ADD COLUMN IF NOT EXISTS manufacturer VARCHAR(150);
    ALTER TABLE devices ADD COLUMN IF NOT EXISTS model VARCHAR(150);
    ALTER TABLE devices ADD COLUMN IF NOT EXISTS ipv6_address TEXT;
    ALTER TABLE devices ADD COLUMN IF NOT EXISTS vlan VARCHAR(50);
    ALTER TABLE devices ADD COLUMN IF NOT EXISTS ssid VARCHAR(150);
    ALTER TABLE devices ADD COLUMN IF NOT EXISTS switch_name VARCHAR(150);
    ALTER TABLE devices ADD COLUMN IF NOT EXISTS switch_port VARCHAR(50);
    ALTER TABLE devices ADD COLUMN IF NOT EXISTS access_point VARCHAR(150);
    ALTER TABLE devices ADD COLUMN IF NOT EXISTS location VARCHAR(200);
    ALTER TABLE devices ADD COLUMN IF NOT EXISTS ownership VARCHAR(20) DEFAULT 'CORPORATE';
    ALTER TABLE devices ADD COLUMN IF NOT EXISTS trust_level VARCHAR(20) DEFAULT 'UNKNOWN';
    ALTER TABLE devices ADD COLUMN IF NOT EXISTS quarantine_status VARCHAR(20) DEFAULT 'NORMAL';
    ALTER TABLE devices ADD COLUMN IF NOT EXISTS security_score INTEGER DEFAULT 0;
    ALTER TABLE devices ADD COLUMN IF NOT EXISTS security_posture JSONB DEFAULT '{}';
    ALTER TABLE devices ADD COLUMN IF NOT EXISTS managed BOOLEAN DEFAULT FALSE;
    ALTER TABLE devices ADD COLUMN IF NOT EXISTS mdm_enrolled BOOLEAN DEFAULT FALSE;
    ALTER TABLE devices ADD COLUMN IF NOT EXISTS encryption_status VARCHAR(20);
    ALTER TABLE devices ADD COLUMN IF NOT EXISTS security_patch_level VARCHAR(50);
    ALTER TABLE devices ADD COLUMN IF NOT EXISTS department VARCHAR(100);
    ALTER TABLE devices ADD COLUMN IF NOT EXISTS approval_status VARCHAR(20) DEFAULT 'approved';
    ALTER TABLE devices ADD COLUMN IF NOT EXISTS battery_level INTEGER;
    ALTER TABLE devices ADD COLUMN IF NOT EXISTS first_seen TIMESTAMPTZ DEFAULT NOW();

    CREATE TABLE IF NOT EXISTS network_discovery_runs (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      source VARCHAR(40) NOT NULL,
      status VARCHAR(20) DEFAULT 'running',
      stats JSONB DEFAULT '{}',
      error_message TEXT,
      started_by UUID REFERENCES users(id),
      started_at TIMESTAMPTZ DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS network_nodes (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      node_type VARCHAR(40) NOT NULL,
      name VARCHAR(200),
      hostname VARCHAR(255),
      ip_address TEXT,
      mac_address VARCHAR(17),
      vendor VARCHAR(150),
      parent_id UUID REFERENCES network_nodes(id) ON DELETE SET NULL,
      vlan VARCHAR(50),
      site VARCHAR(100),
      metadata JSONB DEFAULT '{}',
      source VARCHAR(40),
      device_id UUID REFERENCES devices(id) ON DELETE SET NULL,
      first_seen TIMESTAMPTZ DEFAULT NOW(),
      last_seen TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS nac_policies (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      name VARCHAR(150) NOT NULL,
      priority INTEGER DEFAULT 100,
      description TEXT,
      conditions JSONB NOT NULL DEFAULT '{}',
      action VARCHAR(30) NOT NULL DEFAULT 'LIMITED_ACCESS',
      vlan VARCHAR(50),
      is_active BOOLEAN DEFAULT TRUE,
      created_by UUID REFERENCES users(id),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS nac_decisions (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      device_id UUID REFERENCES devices(id) ON DELETE CASCADE,
      policy_id UUID REFERENCES nac_policies(id) ON DELETE SET NULL,
      decision VARCHAR(30) NOT NULL,
      reason TEXT,
      evidence JSONB DEFAULT '[]',
      auto_applied BOOLEAN DEFAULT FALSE,
      created_by UUID REFERENCES users(id),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS security_incidents (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      incident_id VARCHAR(40) UNIQUE NOT NULL,
      severity VARCHAR(20) NOT NULL DEFAULT 'medium',
      status VARCHAR(30) DEFAULT 'detection',
      title VARCHAR(255) NOT NULL,
      description TEXT,
      affected_devices UUID[],
      detection_source VARCHAR(50),
      evidence JSONB DEFAULT '[]',
      timeline JSONB DEFAULT '[]',
      actions_taken JSONB DEFAULT '[]',
      resolution TEXT,
      assigned_to UUID REFERENCES users(id),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS device_events (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      device_id UUID REFERENCES devices(id) ON DELETE CASCADE,
      event_type VARCHAR(60) NOT NULL,
      severity VARCHAR(20) DEFAULT 'info',
      title VARCHAR(255) NOT NULL,
      description TEXT,
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS network_monitor_metrics (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      device_id UUID REFERENCES devices(id) ON DELETE CASCADE,
      metric_type VARCHAR(40) NOT NULL,
      value DECIMAL(18,4),
      labels JSONB DEFAULT '{}',
      recorded_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS connectors (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      name VARCHAR(100) NOT NULL,
      vendor VARCHAR(50) NOT NULL,
      connector_type VARCHAR(40) NOT NULL,
      config JSONB DEFAULT '{}',
      capabilities JSONB DEFAULT '{}',
      is_enabled BOOLEAN DEFAULT TRUE,
      status VARCHAR(20) DEFAULT 'not_configured',
      last_sync TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_devices_device_type ON devices(device_type);
  `;

  await pool.query(schema);
  logger.info('Inline database schema created');
};

// Seed default data
const seedDefaults = async (): Promise<void> => {
  // Full permission catalog (safe for existing DBs)
  const allPerms: Array<[string, string, string, string]> = [
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
    ['groups.view', 'View Groups', 'View device groups', 'groups'],
    ['groups.manage', 'Manage Groups', 'Create, edit, and delete device groups', 'groups'],
    ['policies.view', 'View Policies', 'View compliance policies', 'policies'],
    ['policies.manage', 'Manage Policies', 'Create, edit, and delete compliance policies', 'policies'],
    ['software.view', 'View Software', 'View software packages and deployments', 'software'],
    ['software.manage', 'Manage Software', 'Create and manage software packages', 'software'],
    ['software.deploy', 'Deploy Software', 'Deploy software to devices', 'software'],
    ['compliance.view', 'View Compliance', 'View compliance results and status', 'compliance'],
    ['hermes.view', 'View HERMES', 'View HERMES security intelligence', 'hermes'],
    ['hermes.manage', 'Manage HERMES', 'Start and stop HERMES scans', 'hermes'],
    ['hermes.approve', 'Approve HERMES Actions', 'Approve or reject HERMES recommendations', 'hermes'],
  ];
  for (const [code, name, desc, category] of allPerms) {
    await pool.query(
      'INSERT INTO permissions (code, name, description, category) VALUES ($1, $2, $3, $4) ON CONFLICT (code) DO NOTHING',
      [code, name, desc, category]
    );
  }
  // Admin always gets every permission (repairs existing DBs missing newer codes)
  const adminRole = await pool.query(`SELECT id FROM roles WHERE name = 'admin'`);
  if (adminRole.rows.length > 0) {
    for (const [code] of allPerms) {
      await pool.query(
        `INSERT INTO role_permissions (role_id, permission_id)
         SELECT $1, id FROM permissions WHERE code = $2
         ON CONFLICT DO NOTHING`,
        [adminRole.rows[0].id, code]
      );
    }
  }

  const policySeed = [
    ['Safe Scan', 'Discovery, port detection, service identification, version detection, vulnerability correlation', '21,22,53,80,110,143,443,445,993,995,3306,3389,5432,5900,8080,8443', '1,3,7,9,11,13,15,17,19,20,21,22,23,25,67,68,69,110,137,138,139,161,162,389,445,514,631,873,2049,3389,5353,5900,6000', ''],
    ['Standard Scan', 'Safe Scan plus configuration, applications, services and security posture', '21,22,23,25,53,80,110,111,135,139,143,389,443,445,993,995,1433,1521,2049,3306,3389,5432,5900,6379,8080,8443,9200,27017', '1,3,7,9,11,13,15,17,19,20,67,68,69,137,138,161,162,514,631,873,2049,5353,6000', ''],
    ['Deep Assessment', 'Deeper non-destructive checks on explicitly authorized assets only', '1-1024,1433,1521,2049,2375,3000,3306,3389,5432,5601,5900,5984,6379,8000,8080,8081,8443,8888,9000,9090,9200,9300,11211,27017', '1,3,7,9,11,13,15,17,19,20,67,68,69,137,138,161,162,514,631,873,2049,5353,6000', ''],
  ];
  for (const [name, description, ports, excludedPorts, excludedHosts] of policySeed) {
    await pool.query(
      `INSERT INTO hermes_scan_policies (name, description, ports, excluded_ports, excluded_hosts)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (name) DO NOTHING`,
      [name, description, ports, excludedPorts, excludedHosts]
    );
  }

  const result = await pool.query('SELECT COUNT(*) as count FROM roles');
  const count = parseInt(result.rows[0]?.count || '0', 10);
  if (count > 0) return;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Insert permissions (catalog already upserted above)
    const permissions = allPerms;

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
    // Free early-access ("user"): view-only demo including HERMES (no manage/approve)
    const rolePerms: Record<string, string[]> = {
      admin: permissions.map(p => p[0]),
      supervisor: ['devices.view', 'devices.manage', 'devices.block', 'devices.commands', 'users.view', 'security.view', 'security.manage', 'logs.view', 'alerts.view', 'alerts.manage', 'agents.view', 'network.view', 'hermes.view'],
      technician: ['devices.view', 'devices.commands', 'security.view', 'agents.view', 'network.view', 'alerts.view', 'hermes.view'],
      user: [
        'devices.view',
        'alerts.view',
        'security.view',
        'hermes.view',
        'agents.view',
        'network.view',
        'groups.view',
        'policies.view',
        'software.view',
        'compliance.view',
        'logs.view',
      ],
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
      ['agent_min_version', '1.1.0', 'Minimum required agent version'],
      ['hermes_allowed_cidrs', '192.168.0.0/16,10.0.0.0/8,172.16.0.0/12', 'HERMES allowed CIDR ranges'],
      ['hermes_emergency_stop', 'false', 'Emergency stop for all HERMES scans'],
      ['hermes_daily_scan_enabled', 'true', 'Enable daily HERMES scan'],
    ];

    for (const [key, value, desc] of settings) {
      await client.query(
        'INSERT INTO app_settings (key, value, description) VALUES ($1, $2, $3) ON CONFLICT (key) DO NOTHING',
        [key, value, desc]
      );
    }

    // Ensure agent_min_version is current on existing DBs (seed used to insert 1.0.0)
    await client.query(
      `INSERT INTO app_settings (key, value, description)
       VALUES ('agent_min_version', '1.1.0', 'Minimum required agent version')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value WHERE app_settings.value = '1.0.0'`
    );

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
