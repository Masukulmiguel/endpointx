export const ROLES = {
  ADMIN: 1,
  SUPERVISOR: 2,
  TECHNICIAN: 3,
  USER: 4,
} as const;

export type RoleId = typeof ROLES[keyof typeof ROLES];

export const PERMISSIONS = {
  // Device permissions
  DEVICE_VIEW: 'device:view',
  DEVICE_CREATE: 'device:create',
  DEVICE_UPDATE: 'device:update',
  DEVICE_DELETE: 'device:delete',
  DEVICE_COMMAND: 'device:command',

  // User permissions
  USER_VIEW: 'user:view',
  USER_CREATE: 'user:create',
  USER_UPDATE: 'user:update',
  USER_DELETE: 'user:delete',
  USER_MANAGE_ROLES: 'user:manage_roles',

  // Group permissions
  GROUP_VIEW: 'group:view',
  GROUP_CREATE: 'group:create',
  GROUP_UPDATE: 'group:update',
  GROUP_DELETE: 'group:delete',
  GROUP_ASSIGN_DEVICES: 'group:assign_devices',

  // Policy permissions
  POLICY_VIEW: 'policy:view',
  POLICY_CREATE: 'policy:create',
  POLICY_UPDATE: 'policy:update',
  POLICY_DELETE: 'policy:delete',
  POLICY_ASSIGN: 'policy:assign',

  // Alert permissions
  ALERT_VIEW: 'alert:view',
  ALERT_ACKNOWLEDGE: 'alert:acknowledge',
  ALERT_DELETE: 'alert:delete',

  // Log permissions
  LOG_VIEW: 'log:view',
  LOG_EXPORT: 'log:export',

  // Settings permissions
  SETTINGS_VIEW: 'settings:view',
  SETTINGS_UPDATE: 'settings:update',

  // Dashboard permissions
  DASHBOARD_VIEW: 'dashboard:view',
  DASHBOARD_ANALYTICS: 'dashboard:analytics',
} as const;

export const ROLE_PERMISSIONS: Record<number, string[]> = {
  [ROLES.ADMIN]: Object.values(PERMISSIONS),
  [ROLES.SUPERVISOR]: [
    PERMISSIONS.DEVICE_VIEW,
    PERMISSIONS.DEVICE_CREATE,
    PERMISSIONS.DEVICE_UPDATE,
    PERMISSIONS.DEVICE_COMMAND,
    PERMISSIONS.USER_VIEW,
    PERMISSIONS.USER_CREATE,
    PERMISSIONS.USER_UPDATE,
    PERMISSIONS.GROUP_VIEW,
    PERMISSIONS.GROUP_CREATE,
    PERMISSIONS.GROUP_UPDATE,
    PERMISSIONS.GROUP_ASSIGN_DEVICES,
    PERMISSIONS.POLICY_VIEW,
    PERMISSIONS.POLICY_CREATE,
    PERMISSIONS.POLICY_UPDATE,
    PERMISSIONS.POLICY_ASSIGN,
    PERMISSIONS.ALERT_VIEW,
    PERMISSIONS.ALERT_ACKNOWLEDGE,
    PERMISSIONS.LOG_VIEW,
    PERMISSIONS.LOG_EXPORT,
    PERMISSIONS.DASHBOARD_VIEW,
    PERMISSIONS.DASHBOARD_ANALYTICS,
  ],
  [ROLES.TECHNICIAN]: [
    PERMISSIONS.DEVICE_VIEW,
    PERMISSIONS.DEVICE_UPDATE,
    PERMISSIONS.DEVICE_COMMAND,
    PERMISSIONS.GROUP_VIEW,
    PERMISSIONS.ALERT_VIEW,
    PERMISSIONS.ALERT_ACKNOWLEDGE,
    PERMISSIONS.LOG_VIEW,
    PERMISSIONS.DASHBOARD_VIEW,
  ],
  [ROLES.USER]: [
    PERMISSIONS.DEVICE_VIEW,
    PERMISSIONS.GROUP_VIEW,
    PERMISSIONS.ALERT_VIEW,
    PERMISSIONS.DASHBOARD_VIEW,
  ],
};

export const JWT = {
  ACCESS_SECRET: process.env.JWT_SECRET || '',
  REFRESH_SECRET: process.env.JWT_REFRESH_SECRET || '',
  ACCESS_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '1h',
  REFRESH_EXPIRES_IN: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
  ISSUER: 'endpointx',
  AUDIENCE: 'endpointx-api',
} as const;

// Validate critical secrets at startup
export const validateSecrets = (): void => {
  const weakSecrets = [
    'change_me', 'change-this', 'secret', 'password', 'dev_secret',
    'access-secret-change-me', 'refresh-secret-change-me',
    'dev_jwt_secret_change_in_production_32chars!',
    'dev_refresh_secret_change_in_production_32chars!',
  ];

  if (!JWT.ACCESS_SECRET || weakSecrets.some(s => JWT.ACCESS_SECRET.includes(s))) {
    throw new Error(
      'JWT_SECRET is missing or too weak. Set a strong JWT_SECRET environment variable.\n' +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(64).toString(\'hex\'))"'
    );
  }

  if (!JWT.REFRESH_SECRET || weakSecrets.some(s => JWT.REFRESH_SECRET.includes(s))) {
    throw new Error(
      'JWT_REFRESH_SECRET is missing or too weak. Set a strong JWT_REFRESH_SECRET environment variable.\n' +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(64).toString(\'hex\'))"'
    );
  }

  if (!process.env.AGENT_SECRET || process.env.AGENT_SECRET.length < 32) {
    throw new Error(
      'AGENT_SECRET is missing or too short (minimum 32 characters). Set a strong AGENT_SECRET environment variable.'
    );
  }
};

export const RATE_LIMIT = {
  WINDOW_MS: 15 * 60 * 1000,
  MAX_REQUESTS: parseInt(process.env.RATE_LIMIT_MAX || '500', 10),
  AUTH_MAX_REQUESTS: parseInt(process.env.AUTH_RATE_LIMIT_MAX || '20', 10),
  HEARTBEAT_MAX_REQUESTS: parseInt(process.env.HEARTBEAT_RATE_LIMIT_MAX || '300', 10),
  HEARTBEAT_IP_MAX_REQUESTS: parseInt(process.env.HEARTBEAT_RATE_LIMIT_IP_MAX || '1000', 10),
  SKIP_SUCCESSFUL: false,
  STANDARD_HEADERS: true,
  LEGACY_HEADERS: false,
} as const;

export const HEARTBEAT = {
  INTERVAL_MS: parseInt(process.env.HEARTBEAT_INTERVAL || '30000', 10),
  OFFLINE_THRESHOLD_MS: parseInt(process.env.OFFLINE_THRESHOLD || '90000', 10),
  TIMEOUT_MS: 10000,
} as const;

export const AUTH = {
  MAX_LOGIN_ATTEMPTS: parseInt(process.env.MAX_LOGIN_ATTEMPTS || '5', 10),
  LOCKOUT_DURATION_MS: parseInt(process.env.LOCKOUT_DURATION || '900000', 10),
  BCRYPT_ROUNDS: 12,
  REFRESH_TOKEN_LENGTH: 64,
  TOKEN_HASH_ALGORITHM: 'sha256',
} as const;

export const PAGINATION = {
  DEFAULT_PAGE: 1,
  DEFAULT_LIMIT: 20,
  MAX_LIMIT: 100,
} as const;

export const HTTP_STATUS = {
  OK: 200,
  CREATED: 201,
  NO_CONTENT: 204,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNPROCESSABLE: 422,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_ERROR: 500,
} as const;
