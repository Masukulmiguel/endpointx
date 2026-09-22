import React, { useState, useCallback } from 'react';
import {
  Key,
  Shield,
  Copy,
  Plus,
  Trash2,
  X,
  Check,
  Lock,
  Eye,
  EyeOff,
  AlertTriangle,
} from 'lucide-react';
import { useApi, useApiMutation } from '../hooks/useApi';
import AlertBanner from '../components/AlertBanner';
import LoadingSpinner from '../components/LoadingSpinner';

interface MFAStatus {
  enabled: boolean;
  method: string | null;
}

interface SSOProvider {
  id: string;
  name: string;
  provider_type: string;
  is_active: boolean;
  created_at: string;
}

const ssoTypes = ['Azure AD', 'Google', 'Okta', 'Generic'];

export default function MfaPage() {
  const [showSetup, setShowSetup] = useState(false);
  const [totpCode, setTotpCode] = useState('');
  const [showDisableModal, setShowDisableModal] = useState(false);
  const [disablePassword, setDisablePassword] = useState('');
  const [disableTotp, setDisableTotp] = useState('');
  const [showAddSSO, setShowAddSSO] = useState(false);
  const [ssoForm, setSsoForm] = useState({ name: '', provider_type: 'Azure AD', client_id: '', client_secret: '', tenant_id: '' });
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const { data: mfaData, loading: mfaLoading, refetch: refetchMfa } = useApi<MFAStatus>('/auth/mfa/status');
  const { data: ssoData, loading: ssoLoading, refetch: refetchSso } = useApi<{ providers: SSOProvider[] }>('/auth/sso/providers');
  const { data: codesData, refetch: refetchCodes } = useApi<{ codes: string[] }>('/auth/mfa/backup-codes');
  const { loading: setupLoading, mutate: setupMfa } = useApiMutation('/auth/mfa/setup', 'POST');
  const { loading: verifyLoading, mutate: verifyMfa } = useApiMutation('/auth/mfa/verify', 'POST');
  const { loading: disableLoading, mutate: disableMfa } = useApiMutation('/auth/mfa/disable', 'POST');
  const { loading: ssoSaving, mutate: createSso } = useApiMutation('/auth/sso/providers', 'POST');
  const { loading: ssoDeleting, mutate: deleteSso } = useApiMutation('', 'DELETE');

  const mfa = mfaData;
  const providers = Array.isArray(ssoData?.providers) ? ssoData.providers : [];
  const backupCodes = codesData?.codes || [];

  const handleSetup = useCallback(async () => {
    const result = await setupMfa({});
    if (result) {
      setShowSetup(true);
    }
  }, [setupMfa]);

  const handleVerify = useCallback(async () => {
    if (!totpCode.trim()) {
      setToast({ type: 'error', message: 'Enter the 6-digit code' });
      return;
    }
    const result = await verifyMfa({ code: totpCode.trim() });
    if (result) {
      refetchMfa();
      refetchCodes();
      setShowSetup(false);
      setTotpCode('');
      setToast({ type: 'success', message: 'MFA enabled successfully' });
    } else {
      setToast({ type: 'error', message: 'Invalid code' });
    }
  }, [totpCode, verifyMfa, refetchMfa, refetchCodes]);

  const handleDisable = useCallback(async () => {
    if (!disablePassword || !disableTotp) {
      setToast({ type: 'error', message: 'Password and TOTP code required' });
      return;
    }
    const result = await disableMfa({ password: disablePassword, code: disableTotp });
    if (result) {
      refetchMfa();
      setShowDisableModal(false);
      setDisablePassword('');
      setDisableTotp('');
      setToast({ type: 'success', message: 'MFA disabled' });
    } else {
      setToast({ type: 'error', message: 'Disable failed' });
    }
  }, [disablePassword, disableTotp, disableMfa, refetchMfa]);

  const handleCopyCodes = useCallback(() => {
    navigator.clipboard.writeText(backupCodes.join('\n'));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [backupCodes]);

  const handleCreateSSO = useCallback(async () => {
    if (!ssoForm.name.trim() || !ssoForm.client_id.trim()) {
      setToast({ type: 'error', message: 'Name and Client ID required' });
      return;
    }
    const result = await createSso(ssoForm);
    if (result) {
      refetchSso();
      setShowAddSSO(false);
      setSsoForm({ name: '', provider_type: 'Azure AD', client_id: '', client_secret: '', tenant_id: '' });
      setToast({ type: 'success', message: 'SSO provider added' });
    }
  }, [ssoForm, createSso, refetchSso]);

  const handleDeleteSSO = useCallback(
    async (id: string) => {
      const result = await deleteSso(`/auth/sso/providers/${id}`, undefined as any);
      if (result !== null) {
        refetchSso();
        setToast({ type: 'success', message: 'Provider removed' });
      }
    },
    [deleteSso, refetchSso]
  );

  if (mfaLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Security Settings</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          Manage multi-factor authentication and SSO
        </p>
      </div>

      {toast && (
        <AlertBanner type={toast.type} message={toast.message} onClose={() => setToast(null)} />
      )}

      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-indigo-100 dark:bg-indigo-900/30">
              <Key className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Multi-Factor Authentication</h2>
              <p className="text-xs text-gray-500 dark:text-gray-400">Add an extra layer of security to your account</p>
            </div>
          </div>
        </div>
        <div className="px-6 py-4">
          {mfa?.enabled ? (
            <div className="space-y-4">
              <div className="flex items-center gap-3 p-4 bg-emerald-50 dark:bg-emerald-900/20 rounded-lg border border-emerald-200 dark:border-emerald-800">
                <Shield className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
                <div>
                  <p className="text-sm font-medium text-emerald-700 dark:text-emerald-400">MFA is enabled</p>
                  <p className="text-xs text-emerald-600 dark:text-emerald-500">Method: {mfa.method || 'TOTP'}</p>
                </div>
              </div>
              {backupCodes.length > 0 && (
                <div className="p-4 bg-gray-50 dark:bg-gray-700/50 rounded-lg">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-sm font-medium text-gray-900 dark:text-white">Backup Codes</p>
                    <button
                      onClick={handleCopyCodes}
                      className="inline-flex items-center gap-1 text-xs text-indigo-600 dark:text-indigo-400 hover:underline"
                    >
                      {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                      {copied ? 'Copied!' : 'Copy'}
                    </button>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    {backupCodes.map((code, i) => (
                      <code key={i} className="px-2 py-1 text-xs bg-white dark:bg-gray-800 rounded border border-gray-200 dark:border-gray-600 text-gray-700 dark:text-gray-300 font-mono">
                        {code}
                      </code>
                    ))}
                  </div>
                </div>
              )}
              <button
                onClick={() => setShowDisableModal(true)}
                className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors"
              >
                <Lock className="w-4 h-4" />
                Disable MFA
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              {showSetup ? (
                <div className="space-y-4">
                  <div className="p-4 bg-gray-50 dark:bg-gray-700/50 rounded-lg">
                    <p className="text-sm text-gray-700 dark:text-gray-300 mb-3">
                      Scan this QR code with your authenticator app, then enter the 6-digit code below.
                    </p>
                    <div className="w-48 h-48 bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-600 flex items-center justify-center mb-4">
                      <p className="text-xs text-gray-400 dark:text-gray-500">QR Code</p>
                    </div>
                    <div className="flex items-center gap-3">
                      <input
                        type="text"
                        value={totpCode}
                        onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                        className="w-32 px-3 py-2.5 text-sm bg-gray-100 dark:bg-gray-700 border border-transparent rounded-lg text-gray-900 dark:text-white focus:ring-2 focus:ring-indigo-500 outline-none font-mono text-center tracking-widest"
                        placeholder="000000"
                        maxLength={6}
                      />
                      <button
                        onClick={handleVerify}
                        disabled={verifyLoading || totpCode.length !== 6}
                        className="inline-flex items-center gap-2 px-4 py-2.5 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors"
                      >
                        {verifyLoading ? 'Verifying...' : 'Verify & Enable'}
                      </button>
                      <button
                        onClick={() => { setShowSetup(false); setTotpCode(''); }}
                        className="px-4 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <button
                  onClick={handleSetup}
                  disabled={setupLoading}
                  className="inline-flex items-center gap-2 px-4 py-2.5 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors"
                >
                  <Key className="w-4 h-4" />
                  {setupLoading ? 'Setting up...' : 'Enable MFA'}
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-indigo-100 dark:bg-indigo-900/30">
              <Shield className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-gray-900 dark:text-white">SSO Configuration</h2>
              <p className="text-xs text-gray-500 dark:text-gray-400">Manage single sign-on providers</p>
            </div>
          </div>
          <button
            onClick={() => setShowAddSSO(true)}
            className="inline-flex items-center gap-2 px-3 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors"
          >
            <Plus className="w-4 h-4" />
            Add Provider
          </button>
        </div>
        <div className="px-6 py-4">
          {ssoLoading ? (
            <LoadingSpinner size="sm" />
          ) : providers.length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-gray-400">No SSO providers configured</p>
          ) : (
            <div className="space-y-3">
              {providers.map((provider) => (
                <div key={provider.id} className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-700/50 rounded-lg">
                  <div className="flex items-center gap-3">
                    <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-indigo-100 dark:bg-indigo-900/30">
                      <Shield className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-gray-900 dark:text-white">{provider.name}</p>
                      <p className="text-xs text-gray-500 dark:text-gray-400">{provider.provider_type}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                      provider.is_active
                        ? 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400'
                        : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400'
                    }`}>
                      {provider.is_active ? 'Active' : 'Inactive'}
                    </span>
                    <button
                      onClick={() => handleDeleteSSO(provider.id)}
                      className="p-1.5 rounded-md text-gray-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                      title="Remove"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-indigo-100 dark:bg-indigo-900/30">
              <Lock className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Password Policy</h2>
              <p className="text-xs text-gray-500 dark:text-gray-400">Current password requirements</p>
            </div>
          </div>
        </div>
        <div className="px-6 py-4">
          <ul className="space-y-2 text-sm text-gray-700 dark:text-gray-300">
            <li className="flex items-center gap-2"><Check className="w-4 h-4 text-emerald-500" /> Minimum 8 characters</li>
            <li className="flex items-center gap-2"><Check className="w-4 h-4 text-emerald-500" /> At least one uppercase letter</li>
            <li className="flex items-center gap-2"><Check className="w-4 h-4 text-emerald-500" /> At least one lowercase letter</li>
            <li className="flex items-center gap-2"><Check className="w-4 h-4 text-emerald-500" /> At least one number</li>
            <li className="flex items-center gap-2"><Check className="w-4 h-4 text-emerald-500" /> At least one special character</li>
          </ul>
        </div>
      </div>

      {showAddSSO && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl w-full max-w-md mx-4 border border-gray-200 dark:border-gray-700">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-700">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Add SSO Provider</h2>
              <button
                onClick={() => setShowAddSSO(false)}
                className="p-1.5 rounded-md text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="px-6 py-4 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Name *</label>
                <input
                  type="text"
                  value={ssoForm.name}
                  onChange={(e) => setSsoForm({ ...ssoForm, name: e.target.value })}
                  className="w-full px-3 py-2.5 text-sm bg-gray-100 dark:bg-gray-700 border border-transparent rounded-lg text-gray-900 dark:text-white focus:ring-2 focus:ring-indigo-500 outline-none"
                  placeholder="e.g., Company SSO"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Provider Type</label>
                <select
                  value={ssoForm.provider_type}
                  onChange={(e) => setSsoForm({ ...ssoForm, provider_type: e.target.value })}
                  className="w-full px-3 py-2.5 text-sm bg-gray-100 dark:bg-gray-700 border border-transparent rounded-lg text-gray-900 dark:text-white focus:ring-2 focus:ring-indigo-500 outline-none"
                >
                  {ssoTypes.map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Client ID *</label>
                <input
                  type="text"
                  value={ssoForm.client_id}
                  onChange={(e) => setSsoForm({ ...ssoForm, client_id: e.target.value })}
                  className="w-full px-3 py-2.5 text-sm bg-gray-100 dark:bg-gray-700 border border-transparent rounded-lg text-gray-900 dark:text-white focus:ring-2 focus:ring-indigo-500 outline-none"
                  placeholder="Client ID"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Client Secret</label>
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={ssoForm.client_secret}
                    onChange={(e) => setSsoForm({ ...ssoForm, client_secret: e.target.value })}
                    className="w-full px-3 py-2.5 pr-10 text-sm bg-gray-100 dark:bg-gray-700 border border-transparent rounded-lg text-gray-900 dark:text-white focus:ring-2 focus:ring-indigo-500 outline-none"
                    placeholder="Client Secret"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Tenant ID</label>
                <input
                  type="text"
                  value={ssoForm.tenant_id}
                  onChange={(e) => setSsoForm({ ...ssoForm, tenant_id: e.target.value })}
                  className="w-full px-3 py-2.5 text-sm bg-gray-100 dark:bg-gray-700 border border-transparent rounded-lg text-gray-900 dark:text-white focus:ring-2 focus:ring-indigo-500 outline-none"
                  placeholder="Tenant ID (if applicable)"
                />
              </div>
            </div>
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200 dark:border-gray-700">
              <button
                onClick={() => setShowAddSSO(false)}
                className="px-4 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateSSO}
                disabled={ssoSaving}
                className="inline-flex items-center gap-2 px-4 py-2.5 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors"
              >
                {ssoSaving ? 'Adding...' : 'Add Provider'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showDisableModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl w-full max-w-md mx-4 border border-gray-200 dark:border-gray-700">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-700">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Disable MFA</h2>
              <button
                onClick={() => setShowDisableModal(false)}
                className="p-1.5 rounded-md text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="px-6 py-4 space-y-4">
              <div className="p-3 bg-amber-50 dark:bg-amber-900/20 rounded-lg border border-amber-200 dark:border-amber-800">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400" />
                  <p className="text-sm text-amber-700 dark:text-amber-400">
                    This will reduce your account security. You'll need your password and a TOTP code to confirm.
                  </p>
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Password</label>
                <input
                  type="password"
                  value={disablePassword}
                  onChange={(e) => setDisablePassword(e.target.value)}
                  className="w-full px-3 py-2.5 text-sm bg-gray-100 dark:bg-gray-700 border border-transparent rounded-lg text-gray-900 dark:text-white focus:ring-2 focus:ring-indigo-500 outline-none"
                  placeholder="Current password"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">TOTP Code</label>
                <input
                  type="text"
                  value={disableTotp}
                  onChange={(e) => setDisableTotp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  className="w-32 px-3 py-2.5 text-sm bg-gray-100 dark:bg-gray-700 border border-transparent rounded-lg text-gray-900 dark:text-white focus:ring-2 focus:ring-indigo-500 outline-none font-mono text-center tracking-widest"
                  placeholder="000000"
                  maxLength={6}
                />
              </div>
            </div>
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200 dark:border-gray-700">
              <button
                onClick={() => setShowDisableModal(false)}
                className="px-4 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleDisable}
                disabled={disableLoading}
                className="inline-flex items-center gap-2 px-4 py-2.5 bg-red-600 text-white text-sm font-medium rounded-lg hover:bg-red-700 disabled:opacity-50 transition-colors"
              >
                {disableLoading ? 'Disabling...' : 'Disable MFA'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
