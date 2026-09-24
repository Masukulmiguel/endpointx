import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Shield, Mail, Lock, Eye, EyeOff, Loader2 } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useI18n } from '../i18n';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});
  const [serverError, setServerError] = useState('');
  const [loading, setLoading] = useState(false);
  const [mounted, setMounted] = useState(false);
  const { login, isAuthenticated, loading: authLoading, logout } = useAuth();
  const navigate = useNavigate();
  const { locale, setLocale, t } = useI18n();
  const clearedExistingSession = useRef(false);

  useEffect(() => {
    const timer = setTimeout(() => setMounted(true), 100);
    return () => clearTimeout(timer);
  }, []);

  // Visiting /login should allow signing in as another account.
  // Clear a leftover session once (only after auth settles), not after a fresh login.
  useEffect(() => {
    if (authLoading || clearedExistingSession.current) return;
    clearedExistingSession.current = true;
    if (isAuthenticated) {
      logout();
    }
  }, [authLoading, isAuthenticated, logout]);

  const validate = (): boolean => {
    const newErrors: typeof errors = {};
    if (!email.trim()) {
      newErrors.email = t('login.emailRequired');
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      newErrors.email = t('login.emailInvalid');
    }
    if (!password) {
      newErrors.password = t('login.passwordRequired');
    } else if (password.length < 6) {
      newErrors.password = t('login.passwordMin');
    }
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setServerError('');
    if (!validate()) return;

    setLoading(true);
    try {
      await login(email, password);
      navigate('/dashboard', { replace: true });
    } catch (err) {
      setServerError(err instanceof Error ? err.message : t('login.failed'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center p-4">
      <div
        className={`w-full max-w-md transition-all duration-700 ease-out ${
          mounted ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-8'
        }`}
      >
        <div className="bg-gray-900 rounded-2xl shadow-2xl border border-gray-800 p-8">
          <div className="text-center mb-8">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl mb-4">
              <img src="/logotipo-fundo-escuro.png" alt="EndpointX" className="w-16 h-16 rounded-2xl object-contain" />
            </div>
            <h1 className="text-2xl font-bold text-white">{t('login.title')}</h1>
            <p className="text-gray-400 text-sm mt-1">{t('login.subtitle')}</p>
            <div className="mt-3 flex justify-center gap-1 rounded-lg bg-gray-800 p-0.5 text-xs w-fit mx-auto">
              {(['pt', 'en'] as const).map((code) => (
                <button
                  key={code}
                  type="button"
                  onClick={() => setLocale(code)}
                  className={`px-3 py-1 rounded-md transition-colors ${
                    locale === code
                      ? 'bg-gray-900 text-blue-400'
                      : 'text-gray-400 hover:text-gray-200'
                  }`}
                >
                  {code.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          {serverError && (
            <div className="mb-6 px-4 py-3 rounded-lg bg-red-500/10 border border-red-500/20">
              <p className="text-sm text-red-400">{serverError}</p>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-gray-300 mb-1.5">
                {t('login.email')}
              </label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
                <input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    if (errors.email) setErrors((prev) => ({ ...prev, email: undefined }));
                  }}
                  placeholder="you@example.com"
                  className={`w-full pl-10 pr-4 py-2.5 text-sm bg-gray-800 border rounded-lg text-white placeholder-gray-500 outline-none transition-all ${
                    errors.email
                      ? 'border-red-500/50 focus:ring-2 focus:ring-red-500/20'
                      : 'border-gray-700 focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500'
                  }`}
                  autoComplete="email"
                  disabled={loading}
                />
              </div>
              {errors.email && <p className="mt-1.5 text-xs text-red-400">{errors.email}</p>}
            </div>

            <div>
              <label htmlFor="password" className="block text-sm font-medium text-gray-300 mb-1.5">
                {t('login.password')}
              </label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
                <input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    if (errors.password) setErrors((prev) => ({ ...prev, password: undefined }));
                  }}
                  placeholder="Enter your password"
                  className={`w-full pl-10 pr-10 py-2.5 text-sm bg-gray-800 border rounded-lg text-white placeholder-gray-500 outline-none transition-all ${
                    errors.password
                      ? 'border-red-500/50 focus:ring-2 focus:ring-red-500/20'
                      : 'border-gray-700 focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500'
                  }`}
                  autoComplete="current-password"
                  disabled={loading}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 transition-colors"
                  tabIndex={-1}
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              {errors.password && <p className="mt-1.5 text-xs text-red-400">{errors.password}</p>}
            </div>

            <div className="flex items-center justify-end">
              <a href="https://endpointx.onrender.com/forgot-password.html" className="text-sm text-blue-400 hover:text-blue-300 transition-colors">
                {t('login.forgotPassword') || 'Forgot password?'}
              </a>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full flex items-center justify-center gap-2 py-2.5 px-4 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-600/50 text-white text-sm font-medium rounded-lg transition-colors focus:ring-2 focus:ring-blue-500/20 focus:outline-none"
            >
              {loading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  {t('login.signingIn')}
                </>
              ) : (
                t('login.submit')
              )}
            </button>
          </form>

          <p className="mt-6 text-center text-xs text-gray-500">
            EndpointX v1.1.0 - Endpoint Management System
          </p>
          <p className="mt-1 text-center text-xs text-gray-400">
            by Masukulu Miguel
          </p>
          <p className="mt-3 text-center text-xs">
            <a href="https://endpointx.onrender.com/register" className="text-blue-400 hover:text-blue-300 transition-colors">
              {t('login.createAccount')}
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}
