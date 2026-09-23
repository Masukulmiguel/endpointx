import React, { useState, useEffect, useCallback } from 'react';
import {
  Settings,
  Server,
  Shield,
  Monitor,
  Save,
  CheckCircle,
} from 'lucide-react';
import { useApi, useApiMutation } from '../hooks/useApi';
import AlertBanner from '../components/AlertBanner';
import ErrorState from '../components/ErrorState';
import LoadingSpinner from '../components/LoadingSpinner';

interface SettingsData {
  [key: string]: string;
}

interface SettingGroup {
  title: string;
  description: string;
  icon: React.ElementType;
  settings: {
    key: string;
    label: string;
    type: 'text' | 'number' | 'toggle';
    description: string;
  }[];
}

const settingGroups: SettingGroup[] = [
  {
    title: 'Agent Settings',
    description: 'Configure endpoint agent behavior',
    icon: Server,
    settings: [
      { key: 'heartbeat_interval', label: 'Heartbeat Interval (seconds)', type: 'number', description: 'How often agents send heartbeat data' },
      { key: 'offline_threshold', label: 'Offline Threshold (seconds)', type: 'number', description: 'Time before an agent is marked offline' },
      { key: 'agent_min_version', label: 'Minimum Agent Version', type: 'text', description: 'Minimum required agent version' },
    ],
  },
  {
    title: 'Security Settings',
    description: 'Authentication and session policies',
    icon: Shield,
    settings: [
      { key: 'max_login_attempts', label: 'Max Login Attempts', type: 'number', description: 'Maximum failed login attempts before lockout' },
      { key: 'lockout_duration', label: 'Lockout Duration (seconds)', type: 'number', description: 'Duration of account lockout after max attempts' },
      { key: 'session_timeout', label: 'Session Timeout (seconds)', type: 'number', description: 'Duration before an inactive session expires' },
      { key: 'mfa_required', label: 'Require MFA', type: 'toggle', description: 'Enforce multi-factor authentication for all users' },
    ],
  },
  {
    title: 'Display Settings',
    description: 'UI and display preferences',
    icon: Monitor,
    settings: [
      { key: 'items_per_page', label: 'Items Per Page', type: 'number', description: 'Default number of items per page in tables' },
    ],
  },
];

export default function SettingsPage() {
  const { data: settingsRaw, loading, error, refetch } = useApi<{ settings: { key: string; value: string }[] }>('/settings');
  const { loading: saving, mutate: updateSetting } = useApiMutation('', 'PUT');
  const [localValues, setLocalValues] = useState<SettingsData>({});
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  useEffect(() => {
    if (settingsRaw?.settings) {
      const obj: SettingsData = {};
      settingsRaw.settings.forEach((s) => { obj[s.key] = s.value; });
      setLocalValues(obj);
    }
  }, [settingsRaw]);

  const handleValueChange = (key: string, value: string) => {
    setLocalValues((prev) => ({ ...prev, [key]: value }));
  };

  const handleSave = useCallback(
    async (key: string) => {
      const value = localValues[key];
      if (value === undefined) return;
      const result = await updateSetting(`/settings/${key}`, { value });
      if (result) {
        refetch();
        setToast({ type: 'success', message: `${key.replace(/_/g, ' ')} updated successfully` });
      } else {
        setToast({ type: 'error', message: `Failed to update ${key.replace(/_/g, ' ')}` });
      }
    },
    [localValues, updateSetting, refetch]
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (error) {
    return <ErrorState error={error} onRetry={refetch} title="Failed to load settings" />;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Settings</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          Configure application settings
        </p>
      </div>

      {toast && (
        <AlertBanner type={toast.type} message={toast.message} onClose={() => setToast(null)} />
      )}

      {settingGroups.map((group) => {
        const Icon = group.icon;
        return (
          <div
            key={group.title}
            className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden"
          >
            <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
              <div className="flex items-center gap-3">
                <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-indigo-100 dark:bg-indigo-900/30">
                  <Icon className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
                </div>
                <div>
                  <h2 className="text-sm font-semibold text-gray-900 dark:text-white">{group.title}</h2>
                  <p className="text-xs text-gray-500 dark:text-gray-400">{group.description}</p>
                </div>
              </div>
            </div>
            <div className="divide-y divide-gray-100 dark:divide-gray-700/50">
              {group.settings.map((setting) => (
                <div key={setting.key} className="px-6 py-4 flex flex-col sm:flex-row sm:items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <label className="text-sm font-medium text-gray-900 dark:text-white">{setting.label}</label>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{setting.description}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    {setting.type === 'toggle' ? (
                      <button
                        type="button"
                        onClick={() => {
                          const newVal = localValues[setting.key] === 'true' ? 'false' : 'true';
                          handleValueChange(setting.key, newVal);
                        }}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                          localValues[setting.key] === 'true'
                            ? 'bg-indigo-600'
                            : 'bg-gray-300 dark:bg-gray-600'
                        }`}
                      >
                        <span
                          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                            localValues[setting.key] === 'true' ? 'translate-x-6' : 'translate-x-1'
                          }`}
                        />
                      </button>
                    ) : (
                      <input
                        type={setting.type}
                        value={localValues[setting.key] || ''}
                        onChange={(e) => handleValueChange(setting.key, e.target.value)}
                        className="w-32 px-3 py-2 text-sm bg-gray-100 dark:bg-gray-700 border border-transparent rounded-lg text-gray-900 dark:text-white focus:ring-2 focus:ring-indigo-500 outline-none"
                      />
                    )}
                    <button
                      onClick={() => handleSave(setting.key)}
                      disabled={saving || localValues[setting.key] === (settingsRaw?.settings?.find(s => s.key === setting.key)?.value || '')}
                      className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      <Save className="w-4 h-4" />
                      Save
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
