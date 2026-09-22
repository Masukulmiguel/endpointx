import React, { useState, useCallback } from 'react';
import {
  Bell,
  Mail,
  Save,
  Send,
  CheckCircle,
  XCircle,
  AlertTriangle,
} from 'lucide-react';
import { useApi, useApiMutation } from '../hooks/useApi';
import AlertBanner from '../components/AlertBanner';
import LoadingSpinner from '../components/LoadingSpinner';

interface NotificationEntry {
  id: string;
  recipient_email: string;
  subject: string;
  status: 'sent' | 'failed' | 'pending';
  sent_at: string | null;
  created_at: string;
}

interface EmailSettings {
  SMTP_HOST: string;
  SMTP_PORT: string;
  SMTP_USER: string;
  SMTP_PASS: string;
  SMTP_FROM: string;
}

function formatTimeAgo(dateStr: string | null): string {
  if (!dateStr) return 'N/A';
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export default function NotificationsPage() {
  const [settings, setSettings] = useState<EmailSettings>({
    SMTP_HOST: '',
    SMTP_PORT: '587',
    SMTP_USER: '',
    SMTP_PASS: '',
    SMTP_FROM: '',
  });
  const [testEmail, setTestEmail] = useState('');
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const { data: notificationsData, loading, error } = useApi<{ notifications: NotificationEntry[] }>('/notifications');
  const { data: settingsData, loading: settingsLoading } = useApi<{ settings: { key: string; value: string }[] }>('/notifications/settings');
  const { loading: savingSettings, mutate: updateSettings } = useApiMutation('/notifications/settings', 'PUT');
  const { loading: sendingTest, mutate: sendTest } = useApiMutation('/notifications/test', 'POST');

  const notifications = Array.isArray(notificationsData?.notifications) ? notificationsData.notifications : [];

  React.useEffect(() => {
    if (settingsData?.settings) {
      const obj: EmailSettings = { SMTP_HOST: '', SMTP_PORT: '587', SMTP_USER: '', SMTP_PASS: '', SMTP_FROM: '' };
      settingsData.settings.forEach((s) => {
        if (s.key in obj) (obj as any)[s.key] = s.value;
      });
      setSettings(obj);
    }
  }, [settingsData]);

  const handleSaveSettings = useCallback(async () => {
    const result = await updateSettings(settings);
    if (result !== null) {
      setToast({ type: 'success', message: 'Email settings saved' });
    } else {
      setToast({ type: 'error', message: 'Failed to save settings' });
    }
  }, [settings, updateSettings]);

  const handleSendTest = useCallback(async () => {
    if (!testEmail.trim()) {
      setToast({ type: 'error', message: 'Enter an email address' });
      return;
    }
    const result = await sendTest({ email: testEmail.trim() });
    if (result) {
      setToast({ type: 'success', message: 'Test email sent' });
      setTestEmail('');
    } else {
      setToast({ type: 'error', message: 'Failed to send test email' });
    }
  }, [testEmail, sendTest]);

  const statusIcon = (status: string) => {
    switch (status) {
      case 'sent':
        return <CheckCircle className="w-4 h-4 text-emerald-500" />;
      case 'failed':
        return <XCircle className="w-4 h-4 text-red-500" />;
      default:
        return <AlertTriangle className="w-4 h-4 text-amber-500" />;
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Notifications</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          Notification log and email configuration
        </p>
      </div>

      {toast && (
        <AlertBanner type={toast.type} message={toast.message} onClose={() => setToast(null)} />
      )}

      {error && (
        <AlertBanner type="error" message={error} onClose={() => {}} />
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
            <div className="flex items-center gap-3">
              <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-indigo-100 dark:bg-indigo-900/30">
                <Mail className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
              </div>
              <div>
                <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Email Settings</h2>
                <p className="text-xs text-gray-500 dark:text-gray-400">Configure SMTP for notifications</p>
              </div>
            </div>
          </div>
          <div className="px-6 py-4 space-y-4">
            {settingsLoading ? (
              <LoadingSpinner size="sm" />
            ) : (
              <>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">SMTP Host</label>
                  <input
                    type="text"
                    value={settings.SMTP_HOST}
                    onChange={(e) => setSettings({ ...settings, SMTP_HOST: e.target.value })}
                    className="w-full px-3 py-2.5 text-sm bg-gray-100 dark:bg-gray-700 border border-transparent rounded-lg text-gray-900 dark:text-white focus:ring-2 focus:ring-indigo-500 outline-none"
                    placeholder="smtp.gmail.com"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">SMTP Port</label>
                  <input
                    type="text"
                    value={settings.SMTP_PORT}
                    onChange={(e) => setSettings({ ...settings, SMTP_PORT: e.target.value })}
                    className="w-full px-3 py-2.5 text-sm bg-gray-100 dark:bg-gray-700 border border-transparent rounded-lg text-gray-900 dark:text-white focus:ring-2 focus:ring-indigo-500 outline-none"
                    placeholder="587"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">SMTP User</label>
                  <input
                    type="text"
                    value={settings.SMTP_USER}
                    onChange={(e) => setSettings({ ...settings, SMTP_USER: e.target.value })}
                    className="w-full px-3 py-2.5 text-sm bg-gray-100 dark:bg-gray-700 border border-transparent rounded-lg text-gray-900 dark:text-white focus:ring-2 focus:ring-indigo-500 outline-none"
                    placeholder="user@gmail.com"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">SMTP Password</label>
                  <input
                    type="password"
                    value={settings.SMTP_PASS}
                    onChange={(e) => setSettings({ ...settings, SMTP_PASS: e.target.value })}
                    className="w-full px-3 py-2.5 text-sm bg-gray-100 dark:bg-gray-700 border border-transparent rounded-lg text-gray-900 dark:text-white focus:ring-2 focus:ring-indigo-500 outline-none"
                    placeholder="Password"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">From Email</label>
                  <input
                    type="email"
                    value={settings.SMTP_FROM}
                    onChange={(e) => setSettings({ ...settings, SMTP_FROM: e.target.value })}
                    className="w-full px-3 py-2.5 text-sm bg-gray-100 dark:bg-gray-700 border border-transparent rounded-lg text-gray-900 dark:text-white focus:ring-2 focus:ring-indigo-500 outline-none"
                    placeholder="noreply@endpointx.com"
                  />
                </div>
                <button
                  onClick={handleSaveSettings}
                  disabled={savingSettings}
                  className="inline-flex items-center gap-2 px-4 py-2.5 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors"
                >
                  <Save className="w-4 h-4" />
                  {savingSettings ? 'Saving...' : 'Save Settings'}
                </button>
              </>
            )}
          </div>
        </div>

        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
            <div className="flex items-center gap-3">
              <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-indigo-100 dark:bg-indigo-900/30">
                <Send className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
              </div>
              <div>
                <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Test Email</h2>
                <p className="text-xs text-gray-500 dark:text-gray-400">Send a test email to verify configuration</p>
              </div>
            </div>
          </div>
          <div className="px-6 py-4 space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Recipient Email</label>
              <input
                type="email"
                value={testEmail}
                onChange={(e) => setTestEmail(e.target.value)}
                className="w-full px-3 py-2.5 text-sm bg-gray-100 dark:bg-gray-700 border border-transparent rounded-lg text-gray-900 dark:text-white focus:ring-2 focus:ring-indigo-500 outline-none"
                placeholder="user@example.com"
              />
            </div>
            <button
              onClick={handleSendTest}
              disabled={sendingTest}
              className="inline-flex items-center gap-2 px-4 py-2.5 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors"
            >
              <Send className="w-4 h-4" />
              {sendingTest ? 'Sending...' : 'Send Test Email'}
            </button>
          </div>
        </div>
      </div>

      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-indigo-100 dark:bg-indigo-900/30">
              <Bell className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Notification Log</h2>
              <p className="text-xs text-gray-500 dark:text-gray-400">{notifications.length} notification{notifications.length !== 1 ? 's' : ''}</p>
            </div>
          </div>
        </div>
        {loading ? (
          <div className="flex items-center justify-center h-32">
            <LoadingSpinner size="lg" />
          </div>
        ) : notifications.length === 0 ? (
          <div className="text-center py-12">
            <Bell className="w-12 h-12 text-gray-300 dark:text-gray-600 mx-auto mb-3" />
            <p className="text-gray-500 dark:text-gray-400">No notifications yet</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-200 dark:border-gray-700">
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Recipient</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Subject</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Status</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Sent At</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700/50">
                {notifications.map((notif) => (
                  <tr key={notif.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/30 transition-colors">
                    <td className="px-6 py-4 text-sm text-gray-900 dark:text-white">{notif.recipient_email}</td>
                    <td className="px-6 py-4 text-sm text-gray-700 dark:text-gray-300">{notif.subject}</td>
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-1.5">
                        {statusIcon(notif.status)}
                        <span className={`text-xs font-medium capitalize ${
                          notif.status === 'sent' ? 'text-emerald-600 dark:text-emerald-400' :
                          notif.status === 'failed' ? 'text-red-600 dark:text-red-400' :
                          'text-amber-600 dark:text-amber-400'
                        }`}>
                          {notif.status}
                        </span>
                      </div>
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-500 dark:text-gray-400">
                      {formatTimeAgo(notif.sent_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
