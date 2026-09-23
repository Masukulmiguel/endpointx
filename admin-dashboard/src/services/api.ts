const API_BASE = window.location.hostname === 'localhost' 
  ? '/api' 
  : 'https://endpointx.onrender.com/api';

class ApiClient {
  private accessToken: string | null = null;
  private refreshToken: string | null = null;

  constructor() {
    this.accessToken = localStorage.getItem('access_token');
    this.refreshToken = localStorage.getItem('refresh_token');
  }

  async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string>),
    };

    if (this.accessToken) {
      headers['Authorization'] = `Bearer ${this.accessToken}`;
    }

    let response = await fetch(`${API_BASE}${endpoint}`, {
      ...options,
      headers,
    });

    // Handle token refresh
    if (response.status === 401 && this.refreshToken) {
      const refreshed = await this.refreshAccessToken();
      if (refreshed) {
        headers['Authorization'] = `Bearer ${this.accessToken}`;
        response = await fetch(`${API_BASE}${endpoint}`, {
          ...options,
          headers,
        });
      }
    }

    if (!response.ok) {
      const body = await response.json().catch(() => null);
      const message =
        (typeof body?.error === 'string' && body.error) ||
        body?.error?.message ||
        body?.message ||
        `HTTP ${response.status}`;
      throw new Error(message);
    }

    return response.json();
  }

  private async refreshAccessToken(): Promise<boolean> {
    try {
      const response = await fetch(`${API_BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: this.refreshToken }),
      });

      if (!response.ok) {
        this.logout();
        return false;
      }

      const data = await response.json();
      this.setTokens(data.data.accessToken, data.data.refreshToken);
      return true;
    } catch {
      this.logout();
      return false;
    }
  }

  setTokens(accessToken: string, refreshToken: string) {
    this.accessToken = accessToken;
    this.refreshToken = refreshToken;
    localStorage.setItem('access_token', accessToken);
    localStorage.setItem('refresh_token', refreshToken);
  }

  logout() {
    this.accessToken = null;
    this.refreshToken = null;
    localStorage.removeItem('access_token');
    localStorage.removeItem('refresh_token');
  }

  isAuthenticated(): boolean {
    return !!this.accessToken;
  }

  // Auth
  async login(email: string, password: string) {
    return this.request('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
  }

  async getProfile() {
    return this.request('/auth/profile');
  }

  async updateProfile(data: any) {
    return this.request('/auth/profile', {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async changePassword(data: { current_password: string; new_password: string }) {
    return this.request('/auth/change-password', {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  // Dashboard
  async getDashboardOverview() {
    return this.request('/dashboard/overview');
  }

  // Devices
  async getDevices(params?: Record<string, any>) {
    const query = params ? '?' + new URLSearchParams(params).toString() : '';
    return this.request(`/devices${query}`);
  }

  async getDevice(id: string) {
    return this.request(`/devices/${id}`);
  }

  async updateDevice(id: string, data: any) {
    return this.request(`/devices/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async deleteDevice(id: string) {
    return this.request(`/devices/${id}`, { method: 'DELETE' });
  }

  async blockDevice(id: string) {
    return this.request(`/devices/${id}/block`, { method: 'POST' });
  }

  async unblockDevice(id: string) {
    return this.request(`/devices/${id}/unblock`, { method: 'POST' });
  }

  async quarantineDevice(id: string) {
    return this.request(`/devices/${id}/quarantine`, { method: 'POST' });
  }

  async getDeviceHistory(id: string, params?: Record<string, any>) {
    const query = params ? '?' + new URLSearchParams(params).toString() : '';
    return this.request(`/devices/${id}/history${query}`);
  }

  // Commands
  async executeCommand(data: { device_id: string; command_type: string; parameters?: any }) {
    return this.request('/commands', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async getCommands(params?: Record<string, any>) {
    const query = params ? '?' + new URLSearchParams(params).toString() : '';
    return this.request(`/commands${query}`);
  }

  // Users
  async getUsers(params?: Record<string, any>) {
    const query = params ? '?' + new URLSearchParams(params).toString() : '';
    return this.request(`/users${query}`);
  }

  async getUser(id: string) {
    return this.request(`/users/${id}`);
  }

  async createUser(data: any) {
    return this.request('/users', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async updateUser(id: string, data: any) {
    return this.request(`/users/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async deleteUser(id: string) {
    return this.request(`/users/${id}`, { method: 'DELETE' });
  }

  // Roles
  async getRoles() {
    return this.request('/roles');
  }

  async getRole(id: string) {
    return this.request(`/roles/${id}`);
  }

  async getPermissions() {
    return this.request('/roles/permissions');
  }

  async createRole(data: any) {
    return this.request('/roles', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async updateRole(id: string, data: any) {
    return this.request(`/roles/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async deleteRole(id: string) {
    return this.request(`/roles/${id}`, { method: 'DELETE' });
  }

  // Alerts
  async getAlerts(params?: Record<string, any>) {
    const query = params ? '?' + new URLSearchParams(params).toString() : '';
    return this.request(`/alerts${query}`);
  }

  async getAlertStats() {
    return this.request('/alerts/stats');
  }

  async dismissAlert(id: string) {
    return this.request(`/alerts/${id}/dismiss`, { method: 'POST' });
  }

  // Security
  async getSecurityEvents(params?: Record<string, any>) {
    const query = params ? '?' + new URLSearchParams(params).toString() : '';
    return this.request(`/security/events${query}`);
  }

  async getSecurityStats() {
    return this.request('/security/events/stats');
  }

  async resolveSecurityEvent(id: string) {
    return this.request(`/security/events/${id}/resolve`, { method: 'POST' });
  }

  // Audit
  async getAuditLogs(params?: Record<string, any>) {
    const query = params ? '?' + new URLSearchParams(params).toString() : '';
    return this.request(`/audit${query}`);
  }

  async getAuditStats() {
    return this.request('/audit/stats');
  }

  async exportAuditLogs(params?: Record<string, any>) {
    const query = params ? '?' + new URLSearchParams(params).toString() : '';
    const response = await fetch(`${API_BASE}/audit/export${query}`, {
      headers: { 'Authorization': `Bearer ${this.accessToken}` },
    });
    return response.blob();
  }

  // Settings
  async getSettings() {
    return this.request('/settings');
  }

  async updateSetting(key: string, value: string) {
    return this.request(`/settings/${key}`, {
      method: 'PUT',
      body: JSON.stringify({ value }),
    });
  }

  // Groups
  async getGroups(params?: Record<string, any>) {
    const query = params ? '?' + new URLSearchParams(params).toString() : '';
    return this.request(`/groups${query}`);
  }

  async createGroup(data: any) {
    return this.request('/groups', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async updateGroup(id: string, data: any) {
    return this.request(`/groups/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async deleteGroup(id: string) {
    return this.request(`/groups/${id}`, { method: 'DELETE' });
  }

  async assignDevicesToGroup(groupId: string, deviceIds: string[]) {
    return this.request(`/groups/${groupId}/devices`, {
      method: 'POST',
      body: JSON.stringify({ device_ids: deviceIds }),
    });
  }

  async removeDeviceFromGroup(groupId: string, deviceId: string) {
    return this.request(`/groups/${groupId}/devices/${deviceId}`, { method: 'DELETE' });
  }

  // Compliance Policies
  async getPolicies(params?: Record<string, any>) {
    const query = params ? '?' + new URLSearchParams(params).toString() : '';
    return this.request(`/compliance/policies${query}`);
  }

  async createPolicy(data: any) {
    return this.request('/compliance/policies', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async updatePolicy(id: string, data: any) {
    return this.request(`/compliance/policies/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async deletePolicy(id: string) {
    return this.request(`/compliance/policies/${id}`, { method: 'DELETE' });
  }

  async checkCompliance(policyId: string) {
    return this.request(`/compliance/policies/${policyId}/check`, { method: 'POST' });
  }

  async getComplianceResults(policyId: string) {
    return this.request(`/compliance/policies/${policyId}/results`);
  }

  // Software
  async getSoftwarePackages(params?: Record<string, any>) {
    const query = params ? '?' + new URLSearchParams(params).toString() : '';
    return this.request(`/software/packages${query}`);
  }

  async createSoftwarePackage(data: any) {
    return this.request('/software/packages', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async updateSoftwarePackage(id: string, data: any) {
    return this.request(`/software/packages/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async deleteSoftwarePackage(id: string) {
    return this.request(`/software/packages/${id}`, { method: 'DELETE' });
  }

  async deploySoftware(data: any) {
    return this.request('/software/deploy', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async getSoftwareDeployments(params?: Record<string, any>) {
    const query = params ? '?' + new URLSearchParams(params).toString() : '';
    return this.request(`/software/deployments${query}`);
  }

  // Reports
  async getReportsSummary() {
    return this.request('/reports/summary');
  }

  async exportDevicesCsv() {
    const response = await fetch(`${API_BASE}/reports/devices?format=csv`, {
      headers: { 'Authorization': `Bearer ${this.accessToken}` },
    });
    return response.blob();
  }

  async exportDevicesPdf() {
    const response = await fetch(`${API_BASE}/reports/devices?format=pdf`, {
      headers: { 'Authorization': `Bearer ${this.accessToken}` },
    });
    return response.blob();
  }

  async exportAlertsCsv() {
    const response = await fetch(`${API_BASE}/reports/alerts?format=csv`, {
      headers: { 'Authorization': `Bearer ${this.accessToken}` },
    });
    return response.blob();
  }

  async exportComplianceCsv() {
    const response = await fetch(`${API_BASE}/reports/compliance?format=csv`, {
      headers: { 'Authorization': `Bearer ${this.accessToken}` },
    });
    return response.blob();
  }

  // MFA
  async getMfaStatus() {
    return this.request('/auth/mfa/status');
  }

  async setupMfa() {
    return this.request('/auth/mfa/setup', { method: 'POST' });
  }

  async verifyMfa(code: string) {
    return this.request('/auth/mfa/verify', {
      method: 'POST',
      body: JSON.stringify({ code }),
    });
  }

  async disableMfa(password: string, code: string) {
    return this.request('/auth/mfa/disable', {
      method: 'POST',
      body: JSON.stringify({ password, code }),
    });
  }

  async getBackupCodes() {
    return this.request('/auth/mfa/backup-codes');
  }

  // SSO
  async getSsoProviders() {
    return this.request('/auth/sso/providers');
  }

  async createSsoProvider(data: any) {
    return this.request('/auth/sso/providers', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async deleteSsoProvider(id: string) {
    return this.request(`/auth/sso/providers/${id}`, { method: 'DELETE' });
  }

  // Notifications
  async getNotifications(params?: Record<string, any>) {
    const query = params ? '?' + new URLSearchParams(params).toString() : '';
    return this.request(`/notifications${query}`);
  }

  async getNotificationSettings() {
    return this.request('/notifications/settings');
  }

  async updateNotificationSettings(data: any) {
    return this.request('/notifications/settings', {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async sendTestEmail(email: string) {
    return this.request('/notifications/test', {
      method: 'POST',
      body: JSON.stringify({ email }),
    });
  }
}

export const api = new ApiClient();
export default api;
