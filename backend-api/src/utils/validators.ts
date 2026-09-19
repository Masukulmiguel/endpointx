import { z } from 'zod';

export const LoginSchema = z.object({
  email: z.string().min(1, 'Email is required').email('Invalid email format'),
  password: z.string().min(1, 'Password is required'),
});

export const RegisterSchema = z.object({
  email: z.string().min(1, 'Email is required').email('Invalid email format'),
  username: z.string().min(3, 'Username must be at least 3 characters').max(50, 'Username is too long'),
  full_name: z.string().min(1, 'Full name is required').max(100, 'Full name is too long'),
  password: z.string().min(8, 'Password must be at least 8 characters').max(128, 'Password is too long'),
  role_id: z.string().optional().default('role_user'),
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
  command_type: z.enum(['reboot', 'shutdown', 'lock', 'unlock', 'inventory', 'update_agent', 'quarantine', 'scan', 'get_info']),
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

export type LoginInput = z.infer<typeof LoginSchema>;
export type RegisterInput = z.infer<typeof RegisterSchema>;
export type DeviceRegisterInput = z.infer<typeof DeviceRegisterSchema>;
export type HeartbeatInput = z.infer<typeof HeartbeatSchema>;
export type CommandInput = z.infer<typeof CommandSchema>;
