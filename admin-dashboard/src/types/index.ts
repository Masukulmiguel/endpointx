export interface User {
  id: string;
  email: string;
  username: string;
  full_name: string;
  role_id: string;
  role_name?: string;
  is_active: boolean;
  mfa_enabled: boolean;
  last_login: string | null;
  created_at: string;
  updated_at: string;
  permissions?: string[];
}

export interface Device {
  id: string;
  agent_id: string;
  hostname: string;
  display_name: string | null;
  os_type: string;
  os_version: string | null;
  os_build: string | null;
  ip_address: string | null;
  mac_address: string | null;
  user_id: string | null;
  user_name?: string;
  status: 'online' | 'offline' | 'alert' | 'blocked' | 'quarantine';
  agent_version: string | null;
  cpu_model: string | null;
  cpu_cores: number | null;
  cpu_usage: number | null;
  ram_total: number | null;
  ram_used: number | null;
  ram_usage: number | null;
  disk_total: number | null;
  disk_used: number | null;
  disk_usage: number | null;
  last_heartbeat: string | null;
  last_inventory: string | null;
  registered_at: string;
  is_authorized: boolean;
  notes: string | null;
  device_type?: string | null;
  manufacturer?: string | null;
  model?: string | null;
  ownership?: string | null;
  approval_status?: string | null;
  battery_level?: number | null;
  latitude?: number | null;
  longitude?: number | null;
  location_updated_at?: string | null;
}

export interface DeviceDetail extends Device {
  software: Software[];
  services: Service[];
  processes: Process[];
  network_interfaces: NetworkInterface[];
  recent_heartbeats: Heartbeat[];
  recent_events: SecurityEvent[];
  recent_commands: Command[];
}

export interface Software {
  id: string;
  name: string;
  version: string | null;
  publisher: string | null;
  install_date: string | null;
}

export interface Service {
  id: string;
  name: string;
  display_name: string | null;
  status: string | null;
  startup_type: string | null;
}

export interface Process {
  id: string;
  pid: number;
  name: string | null;
  cpu_usage: number | null;
  memory_usage: number | null;
  user_name: string | null;
}

export interface NetworkInterface {
  id: string;
  name: string;
  mac_address: string | null;
  ipv4_address: string | null;
  ipv6_address: string | null;
  is_connected: boolean;
  speed_mbps: number | null;
}

export interface Heartbeat {
  id: string;
  device_id: string;
  cpu_usage: number;
  ram_usage: number;
  disk_usage: number;
  network_in: number;
  network_out: number;
  active_processes: number;
  ip_address: string | null;
  recorded_at: string;
}

export interface SecurityEvent {
  id: string;
  device_id: string | null;
  device_name?: string;
  event_type: string;
  severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
  title: string;
  description: string | null;
  source: string | null;
  is_resolved: boolean;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
}

export interface Alert {
  id: string;
  device_id: string | null;
  device_name?: string;
  alert_type: string;
  severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
  title: string;
  description: string | null;
  metadata: any;
  is_dismissed: boolean;
  dismissed_by: string | null;
  dismissed_at: string | null;
  created_at: string;
}

export interface AuditLog {
  id: string;
  user_id: string | null;
  user_email: string | null;
  user_name?: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  description: string | null;
  ip_address: string | null;
  user_agent: string | null;
  metadata: any;
  created_at: string;
}

export interface Role {
  id: string;
  name: string;
  display_name: string;
  description: string | null;
  is_system: boolean;
  permission_count?: number;
  permissions?: Permission[];
  created_at: string;
}

export interface Permission {
  id: string;
  code: string;
  name: string;
  description: string | null;
  category: string;
}

export interface Command {
  id: string;
  device_id: string;
  device_name?: string;
  command_type: string;
  parameters: any;
  status: 'pending' | 'sent' | 'executing' | 'completed' | 'failed' | 'timeout';
  issued_by: string;
  issued_by_name?: string;
  result: string | null;
  error_message: string | null;
  created_at: string;
  executed_at: string | null;
  completed_at: string | null;
}

export interface DashboardOverview {
  total_devices: number;
  online_devices: number;
  offline_devices: number;
  alert_devices: number;
  blocked_devices: number;
  quarantine_devices: number;
  total_users: number;
  active_users: number;
  total_alerts: number;
  unresolved_alerts: number;
  recent_events: SecurityEvent[];
  critical_alerts: Alert[];
  device_status_distribution: { status: string; count: number }[];
  heartbeat_trend: { time: string; count: number }[];
  alerts_by_type: { type: string; count: number }[];
  events_by_severity: { severity: string; count: number }[];
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  total_pages: number;
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: {
    message: string;
    code?: string;
  };
}

export interface DeviceGroup {
  id: string;
  name: string;
  description: string;
  color: string;
  device_count: number;
  created_at: string;
  updated_at: string;
}

export interface CompliancePolicy {
  id: string;
  name: string;
  description: string;
  rules: Record<string, any>;
  is_active: boolean;
  created_at: string;
}

export interface ComplianceResult {
  id: string;
  device_id: string;
  policy_id: string;
  is_compliant: boolean;
  violations: string[];
  checked_at: string;
}

export interface SoftwarePackage {
  id: string;
  name: string;
  version: string;
  installer_url: string;
  installer_type: string;
  silent_args: string;
  file_size: number;
  is_active: boolean;
  created_at: string;
}

export interface SoftwareDeployment {
  id: string;
  package_id: string;
  device_id: string;
  status: string;
  installed_at: string;
  error_message: string;
  created_at: string;
}

export interface SSOProvider {
  id: string;
  name: string;
  provider_type: string;
  is_active: boolean;
  created_at: string;
}

export interface MFAStatus {
  enabled: boolean;
  method: string | null;
}

export interface NotificationEntry {
  id: string;
  recipient_email: string;
  subject: string;
  status: string;
  sent_at: string;
  created_at: string;
}
