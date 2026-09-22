import { z } from 'zod';

// Password policy: min 12 chars, uppercase, lowercase, number, special char
const passwordSchema = z.string()
  .min(12, 'Password must be at least 12 characters')
  .max(128, 'Password is too long')
  .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
  .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
  .regex(/[0-9]/, 'Password must contain at least one number')
  .regex(/[^A-Za-z0-9]/, 'Password must contain at least one special character');

export const LoginSchema = z.object({
  email: z.string().min(1, 'Email is required').email('Invalid email format'),
  password: z.string().min(1, 'Password is required'),
});

export const InviteUserSchema = z.object({
  email: z.string().min(1, 'Email is required').email('Invalid email format'),
  username: z.string().min(3, 'Username must be at least 3 characters').max(50).optional(),
  full_name: z.string().min(1, 'Full name is required').max(100).optional(),
  role_id: z.string().uuid().optional(),
});

export const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: passwordSchema,
});

export const DeviceRegisterSchema = z.object({
  hostname: z.string().min(1, 'Hostname is required').max(255),
  os_type: z.enum(['windows', 'macos', 'linux']),
  os_version: z.string().min(1, 'OS version is required').max(100),
  os_build: z.string().max(100).optional().default(''),
  mac_address: z.string().optional().default(''),
});

export const HeartbeatSchema = z.object({
  cpu_usage: z.number().min(0).max(100).optional().default(0),
  ram_usage: z.number().min(0).max(100).optional().default(0),
  disk_usage: z.number().min(0).max(100).optional().default(0),
  network_in: z.number().min(0).optional().default(0),
  network_out: z.number().min(0).optional().default(0),
  active_processes: z.number().int().min(0).optional().default(0),
});

export const CommandSchema = z.object({
  device_id: z.string().min(1),
  command_type: z.enum(['reboot', 'shutdown', 'lock', 'unlock', 'inventory', 'update_agent', 'quarantine', 'scan', 'get_info', 'install_software', 'uninstall_software']),
  parameters: z.record(z.any()).optional().default({}),
});

export const UserUpdateSchema = z.object({
  email: z.string().email().optional(),
  full_name: z.string().min(1).max(100).optional(),
  is_active: z.boolean().optional(),
  role_id: z.string().optional(),
}).refine((data) => Object.keys(data).length > 0, {
  message: 'At least one field must be provided',
});

export const RoleCreateSchema = z.object({
  name: z.string().min(1).max(50),
  display_name: z.string().min(1).max(100),
  description: z.string().max(500).optional().default(''),
});

export const PaginationSchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  search: z.string().max(255).optional().default(''),
  status: z.string().optional(),
  sort: z.string().optional().default('created_at'),
  order: z.enum(['asc', 'desc']).optional().default('desc'),
});

// Device Groups
export const DeviceGroupSchema = z.object({
  name: z.string().min(1, 'Group name is required').max(100),
  description: z.string().max(500).optional().default(''),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Invalid hex color').optional().default('#6366f1'),
});

export const DeviceGroupAssignSchema = z.object({
  device_ids: z.array(z.string().uuid()).min(1, 'At least one device required'),
});

// Compliance Policies
export const CompliancePolicySchema = z.object({
  name: z.string().min(1, 'Policy name is required').max(100),
  description: z.string().max(500).optional().default(''),
  rules: z.object({
    min_os_version: z.string().optional(),
    require_firewall: z.boolean().optional().default(true),
    require_antivirus: z.boolean().optional().default(true),
    max_cpu_usage: z.number().min(0).max(100).optional(),
    max_disk_usage: z.number().min(0).max(100).optional(),
    required_agent_version: z.string().optional(),
    blocked_software: z.array(z.string()).optional().default([]),
    required_software: z.array(z.string()).optional().default([]),
  }),
  group_ids: z.array(z.string().uuid()).optional().default([]),
});

// Software Deployment
export const SoftwareDeploySchema = z.object({
  name: z.string().min(1, 'Software name is required').max(100),
  version: z.string().max(50).optional(),
  installer_url: z.string().url('Invalid URL'),
  installer_type: z.enum(['msi', 'exe', 'msix', 'deb', 'rpm', 'pkg']),
  silent_args: z.string().optional().default('/quiet /norestart'),
  uninstall_args: z.string().optional().default('/quiet'),
  group_ids: z.array(z.string().uuid()).optional().default([]),
  device_ids: z.array(z.string().uuid()).optional().default([]),
});

// MFA
export const MfaVerifySchema = z.object({
  token: z.string().length(6, 'MFA token must be 6 digits').regex(/^\d+$/, 'MFA token must be digits'),
});

// Settings
export const SettingsUpdateSchema = z.object({
  value: z.string().min(1, 'Value is required'),
});

export type LoginInput = z.infer<typeof LoginSchema>;
export type InviteUserInput = z.infer<typeof InviteUserSchema>;
export type ChangePasswordInput = z.infer<typeof ChangePasswordSchema>;
export type DeviceRegisterInput = z.infer<typeof DeviceRegisterSchema>;
export type HeartbeatInput = z.infer<typeof HeartbeatSchema>;
export type CommandInput = z.infer<typeof CommandSchema>;
export type DeviceGroupInput = z.infer<typeof DeviceGroupSchema>;
export type CompliancePolicyInput = z.infer<typeof CompliancePolicySchema>;
export type SoftwareDeployInput = z.infer<typeof SoftwareDeploySchema>;
