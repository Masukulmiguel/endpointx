const API_BASE = window.location.hostname === 'localhost'
  ? '/api'
  : 'https://endpointx.onrender.com/api';

export interface SSOProvider {
  id: string;
  name: string;
  provider_type: string;
  is_active: boolean;
  created_at: string;
  tenant_id?: string;
  domain?: string;
}

export interface SSOProviderInput {
  name: string;
  provider_type: 'azure_ad' | 'google' | 'okta' | 'oidc';
  client_id: string;
  client_secret: string;
  redirect_uri: string;
  tenant_id?: string;
  domain?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  userinfo_endpoint?: string;
}

export interface SSOCallbackData {
  code: string;
  state: string;
}

class SSOResponse<T> {
  success!: boolean;
  data!: T;
}

function getAuthHeaders(): Record<string, string> {
  const token = localStorage.getItem('access_token');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: { message: 'Request failed' } }));
    throw new Error(error.error?.message || `HTTP ${response.status}`);
  }
  const result: SSOResponse<T> = await response.json();
  if (!result.success) {
    throw new Error('Request was not successful');
  }
  return result.data;
}

export const ssoService = {
  async getProviders(): Promise<SSOProvider[]> {
    const response = await fetch(`${API_BASE}/sso/providers`, {
      headers: getAuthHeaders(),
    });
    return handleResponse<SSOProvider[]>(response);
  },

  async addProvider(data: SSOProviderInput): Promise<{ id: string; name: string; provider_type: string; is_active: boolean }> {
    const response = await fetch(`${API_BASE}/sso/providers`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(data),
    });
    return handleResponse(response);
  },

  async removeProvider(id: string): Promise<void> {
    const response = await fetch(`${API_BASE}/sso/providers/${id}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });
    await handleResponse(response);
  },

  async authorize(providerId: string): Promise<string> {
    const response = await fetch(`${API_BASE}/sso/authorize/${providerId}`, {
      headers: getAuthHeaders(),
    });
    const data = await handleResponse<{ url: string }>(response);
    return data.url;
  },

  async handleCallback(providerId: string, code: string, state: string): Promise<{
    accessToken: string;
    refreshToken: string;
    user: {
      id: string;
      email: string;
      username: string;
      full_name: string;
      role_id: string;
      role_name: string;
      permissions: string[];
      sso_provider_id: string;
      is_new_user: boolean;
    };
  }> {
    const response = await fetch(`${API_BASE}/sso/callback/${providerId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, state }),
    });
    return handleResponse(response);
  },

  async disconnect(): Promise<void> {
    const response = await fetch(`${API_BASE}/sso/disconnect`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });
    await handleResponse(response);
  },
};

export default ssoService;
