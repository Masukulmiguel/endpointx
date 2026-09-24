import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { Mail, Loader2, ArrowLeft, CheckCircle2 } from 'lucide-react';
import api from '../services/api';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!email.trim()) {
      setError('Email is required.');
      return;
    }
    setLoading(true);
    try {
      await api.forgotPassword(email.trim());
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="bg-gray-900 rounded-2xl shadow-2xl border border-gray-800 p-8">
          <div className="text-center mb-8">
            <img src="/logotipo-fundo-escuro.png" alt="EndpointX" className="w-14 h-14 rounded-2xl object-contain mx-auto mb-4" />
            <h1 className="text-2xl font-bold text-white">Forgot password</h1>
            <p className="text-gray-400 text-sm mt-1">
              Enter your email and we&apos;ll send a reset link if an account exists.
            </p>
          </div>

          {error && (
            <div className="mb-6 px-4 py-3 rounded-lg bg-red-500/10 border border-red-500/20">
              <p className="text-sm text-red-400">{error}</p>
            </div>
          )}

          {sent ? (
            <div className="space-y-6">
              <div className="flex flex-col items-center text-center gap-3 py-4">
                <CheckCircle2 className="w-10 h-10 text-emerald-400" />
                <p className="text-sm text-gray-300">
                  If an account exists for <span className="text-white font-medium">{email}</span>, a reset link has been sent.
                </p>
                <p className="text-xs text-gray-500">
                  The link expires in 1 hour. Check your spam folder if you don&apos;t see it.
                </p>
              </div>
              <Link
                to="/login"
                className="w-full flex items-center justify-center gap-2 py-2.5 px-4 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-colors"
              >
                <ArrowLeft className="w-4 h-4" />
                Back to sign in
              </Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-5">
              <div>
                <label htmlFor="email" className="block text-sm font-medium text-gray-300 mb-1.5">
                  Email
                </label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
                  <input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@company.com"
                    className="w-full pl-10 pr-4 py-2.5 text-sm bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
                    autoComplete="email"
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
                    Sending…
                  </>
                ) : (
                  'Send reset link'
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
