import React, { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import api from '../services/api';
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Hash,
  KeyRound,
  Mail,
  ShieldCheck,
  User as UserIcon,
} from 'lucide-react';

export default function ProfilePage() {
  const { user, logout } = useAuth();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (newPassword !== confirmPassword) {
      setError('The new passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      await api.changePassword({ currentPassword, newPassword });
      setDone(true);
      setTimeout(() => logout(), 2500);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Password change failed.');
      setBusy(false);
    }
  };

  const initials = (() => {
    const name = user?.full_name || user?.email || '?';
    const parts = name.trim().split(/\s+/).filter(Boolean);
    return ((parts[0]?.[0] || '?') + (parts[1]?.[0] || '')).toUpperCase();
  })();

  const infoRows = [
    { icon: UserIcon, label: 'Full name', value: user?.full_name || '—' },
    { icon: Mail, label: 'Email', value: user?.email || '—' },
    { icon: Hash, label: 'Username', value: user?.username || '—' },
    { icon: ShieldCheck, label: 'Role', value: user?.role_name || '—' },
    {
      icon: KeyRound,
      label: 'MFA',
      value: user?.mfa_enabled ? 'Enabled' : 'Disabled',
    },
    {
      icon: Clock,
      label: 'Last login',
      value: user?.last_login ? new Date(user.last_login).toLocaleString() : '—',
    },
  ];

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-xl font-bold text-gray-900 dark:text-white">My Profile</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          Account information and password management
        </p>
      </div>

      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6">
        <div className="flex items-center gap-4 pb-5 mb-5 border-b border-gray-200 dark:border-gray-700">
          <div className="w-14 h-14 rounded-full bg-blue-100 dark:bg-blue-900/50 flex items-center justify-center text-blue-600 dark:text-blue-400 font-bold text-lg">
            {initials}
          </div>
          <div>
            <p className="text-base font-semibold text-gray-900 dark:text-white">
              {user?.full_name || user?.email || '—'}
            </p>
            <p className="text-sm text-gray-500 dark:text-gray-400">{user?.email || '—'}</p>
          </div>
        </div>
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4">
          {infoRows.map((row) => (
            <div key={row.label} className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-gray-100 dark:bg-gray-700 flex items-center justify-center flex-shrink-0">
                <row.icon className="w-4 h-4 text-gray-500 dark:text-gray-400" />
              </div>
              <div className="min-w-0">
                <dt className="text-xs text-gray-500 dark:text-gray-400">{row.label}</dt>
                <dd className="text-sm font-medium text-gray-900 dark:text-white truncate">
                  {row.value}
                </dd>
              </div>
            </div>
          ))}
        </dl>
      </div>

      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-white mb-4">
          Change Password
        </h2>

        {done ? (
          <div className="flex items-start gap-3 p-4 rounded-lg bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800">
            <CheckCircle2 className="w-5 h-5 text-emerald-600 dark:text-emerald-400 flex-shrink-0 mt-0.5" />
            <div className="text-sm">
              <p className="font-medium text-emerald-800 dark:text-emerald-300">
                Password changed successfully.
              </p>
              <p className="text-emerald-700 dark:text-emerald-400 mt-1">
                All sessions were closed — signing you out to sign in with the new password.
              </p>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div className="flex items-start gap-3 p-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
                <AlertCircle className="w-4 h-4 text-red-600 dark:text-red-400 flex-shrink-0 mt-0.5" />
                <p className="text-sm text-red-700 dark:text-red-300">{error}</p>
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                Current password
              </label>
              <input
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                required
                className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                  New password
                </label>
                <input
                  type="password"
                  autoComplete="new-password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  required
                  minLength={12}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                  Confirm new password
                </label>
                <input
                  type="password"
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                  minLength={12}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
                />
              </div>
            </div>

            <p className="text-xs text-gray-500 dark:text-gray-400">
              Minimum 12 characters with uppercase, lowercase, number and special character.
            </p>

            <button
              type="submit"
              disabled={busy}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <KeyRound className="w-4 h-4" />
              {busy ? 'Changing…' : 'Change password'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
