export declare const ROLES: {
    readonly ADMIN: 1;
    readonly SUPERVISOR: 2;
    readonly TECHNICIAN: 3;
    readonly USER: 4;
};
export type RoleId = typeof ROLES[keyof typeof ROLES];
export declare const PERMISSIONS: {
    readonly DEVICE_VIEW: "device:view";
    readonly DEVICE_CREATE: "device:create";
    readonly DEVICE_UPDATE: "device:update";
    readonly DEVICE_DELETE: "device:delete";
    readonly DEVICE_COMMAND: "device:command";
    readonly USER_VIEW: "user:view";
    readonly USER_CREATE: "user:create";
    readonly USER_UPDATE: "user:update";
    readonly USER_DELETE: "user:delete";
    readonly USER_MANAGE_ROLES: "user:manage_roles";
    readonly GROUP_VIEW: "group:view";
    readonly GROUP_CREATE: "group:create";
    readonly GROUP_UPDATE: "group:update";
    readonly GROUP_DELETE: "group:delete";
    readonly GROUP_ASSIGN_DEVICES: "group:assign_devices";
    readonly POLICY_VIEW: "policy:view";
    readonly POLICY_CREATE: "policy:create";
    readonly POLICY_UPDATE: "policy:update";
    readonly POLICY_DELETE: "policy:delete";
    readonly POLICY_ASSIGN: "policy:assign";
    readonly ALERT_VIEW: "alert:view";
    readonly ALERT_ACKNOWLEDGE: "alert:acknowledge";
    readonly ALERT_DELETE: "alert:delete";
    readonly LOG_VIEW: "log:view";
    readonly LOG_EXPORT: "log:export";
    readonly SETTINGS_VIEW: "settings:view";
    readonly SETTINGS_UPDATE: "settings:update";
    readonly DASHBOARD_VIEW: "dashboard:view";
    readonly DASHBOARD_ANALYTICS: "dashboard:analytics";
};
export declare const ROLE_PERMISSIONS: Record<number, string[]>;
export declare const JWT: {
    readonly ACCESS_SECRET: string;
    readonly REFRESH_SECRET: string;
    readonly ACCESS_EXPIRES_IN: string;
    readonly REFRESH_EXPIRES_IN: string;
    readonly ISSUER: "endpointx";
    readonly AUDIENCE: "endpointx-api";
};
export declare const RATE_LIMIT: {
    readonly WINDOW_MS: number;
    readonly MAX_REQUESTS: number;
    readonly AUTH_MAX_REQUESTS: 5;
    readonly SKIP成功的: false;
    readonly STANDARD_HEADERS: true;
    readonly LEGACY_HEADERS: false;
};
export declare const HEARTBEAT: {
    readonly INTERVAL_MS: number;
    readonly OFFLINE_THRESHOLD_MS: number;
    readonly TIMEOUT_MS: 10000;
};
export declare const AUTH: {
    readonly MAX_LOGIN_ATTEMPTS: number;
    readonly LOCKOUT_DURATION_MS: number;
    readonly BCRYPT_ROUNDS: 12;
    readonly REFRESH_TOKEN_LENGTH: 64;
    readonly TOKEN_HASH_ALGORITHM: "sha256";
};
export declare const PAGINATION: {
    readonly DEFAULT_PAGE: 1;
    readonly DEFAULT_LIMIT: 20;
    readonly MAX_LIMIT: 100;
};
export declare const HTTP_STATUS: {
    readonly OK: 200;
    readonly CREATED: 201;
    readonly NO_CONTENT: 204;
    readonly BAD_REQUEST: 400;
    readonly UNAUTHORIZED: 401;
    readonly FORBIDDEN: 403;
    readonly NOT_FOUND: 404;
    readonly CONFLICT: 409;
    readonly UNPROCESSABLE: 422;
    readonly TOO_MANY_REQUESTS: 429;
    readonly INTERNAL_ERROR: 500;
};
