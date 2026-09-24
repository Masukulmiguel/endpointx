import React, { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Lock, Loader2, ArrowLeft, CheckCircle2 } from 'lucide-react';
import api from '../services/api';

export default function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') || '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const navigate = useNavigate();

  const validate = (): string | null => {
    if (password.length < 12) return 'Password must be at least 12 characters.';
    if (!/[A-Z]/.test(password)) return 'Password must contain an uppercase letter.';
    if (!/[a-z]/.test(password)) return 'Password must contain a lowercase letter.';
    if (!/[0-9]/.test(password)) return 'Password must contain a number.';
    if (!/[^A-Za-z0-9]/.test(password)) return 'Password must contain a special character.';
    if (password !== confirm) return 'Passwords do not match.';
    return null;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    const v = validate();
    if (v) {
      setError(v);
      return;
    }
    setLoading(true);
    try {
      await api.resetPassword(token, password);
      setDone(true);
      setTimeout(() => navigate('/login', { replace: true }), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Reset failed.');
    } finally {
      setLoading(false);
    }
  };

  if (!token) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center p-4">
        <div className="bg-gray-900 rounded-2xl border border-gray-800 p-8 max-w-md w-full text-center">
          <h1 className="text-xl font-bold text-white mb-2">Invalid reset link</h1>
          <p className="text-sm text-gray-400 mb-6">This link is missing or incomplete. Request a new one.</p>
          <Link
            to="/forgot-password"
            className="inline-flex items-center gap-2 py-2.5 px-4 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-colors"
          >
            Request new link
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="bg-gray-900 rounded-2xl shadow-2xl border border-gray-800 p-8">
          <div className="text-center mb-8">
            <img src="/logotipo-fundo-escuro.png" alt="EndpointX" className="w-14 h-14 rounded-2xl object-contain mx-auto mb-4" />
            <h1 className="text-2xl font-bold text-white">Choose a new password</h1>
            <p className="text-gray-400 text-sm mt-1">Minimum 12 characters with upper, lower, number and symbol.</p>
          </div>

          {error && (
            <div className="mb-6 px-4 py-3 rounded-lg bg-red-500/10 border border-red-500/20">
              <p className="text-sm text-red-400">{error}</p>
            </div>
          )}

          {done ? (
            <div className="flex flex-col items-center text-center gap-4 py-4">
              <CheckCircle2 className="w-10 h-10 text-emerald-400" />
              <p className="text-sm text-gray-300">Password updated. Redirecting to sign in…</p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-5">
              <div>
                <label htmlFor="password" className="block text-sm font-medium text-gray-300 mb-1.5">
                  New password
                </label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
                  <input
                    id="password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full pl-10 pr-4 py-2.5 text-sm bg-gray-800 border border-gray-700 rounded-lg text-white outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
                    autoComplete="new-password"
                    disabled={loading}
                    required
                  />
                </div>
              </div>
              <div>
                <label htmlFor="confirm" className="block text-sm font-medium text-gray-300 mb-1.5">
                  Confirm password
                </label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
                  <input
                    id="confirm"
                    type="password"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    className="w-full pl-10 pr-4 py-2.5 text-sm bg-gray-800 border border-gray-700 rounded-lg text-white outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
                    autoComplete="new-password"
                    disabled={loading}
                    required
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full flex items-center justify-center gap-2 py-2.5 px-4 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-600/50 text-white text-sm font-medium rounded-lg transition-colors"
              >
                {loading ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Saving…
                  </>
                ) : (
                  'Reset password'
                )}
              </button>

              <p className="text-center text-sm">
                <Link to="/login" className="text-blue-400 hover:text-blue-300 transition-colors inline-flex items-center gap-1">
                  <ArrowLeft className="w-3.5 h-3.5" />
                  Back to sign in
                </Link>
              </p>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
