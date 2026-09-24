import React, { useState, useEffect, useRef } from 'react';
import { Outlet, useLocation, useNavigate, Link } from 'react-router-dom';
import {
  LayoutDashboard,
  Monitor,
  Users,
  Shield,
  Lock,
  Bell,
  Wifi,
  FileText,
  Cpu,
  Settings,
  Menu,
  X,
  Search,
  LogOut,
  ChevronDown,
  User,
  Download,
  AlertTriangle,
  ShieldAlert,
  ShieldCheck,
  ArrowDownToLine,
  Key,
  ChartBar,
  UsersRound,
  Radar,
} from 'lucide-react';
import api from '../services/api';
import { useI18n, type Locale } from '../i18n';
import { useAuth } from '../contexts/AuthContext';

const navItems = [
  { key: 'nav.dashboard', path: '/dashboard', icon: LayoutDashboard },
  { key: 'nav.hermes', path: '/hermes', icon: Radar, permission: 'hermes.view' },
  { key: 'nav.devices', path: '/devices', icon: Monitor, permission: 'devices.view' },
  { key: 'nav.install', path: '/install', icon: Download, permission: 'devices.view' },
  { key: 'nav.users', path: '/users', icon: Users, permission: 'users.view' },
  { key: 'nav.roles', path: '/roles', icon: Shield, permission: 'roles.view' },
  { key: 'nav.security', path: '/security', icon: Lock, permission: 'security.view' },
  { key: 'nav.alerts', path: '/alerts', icon: Bell, permission: 'alerts.view' },
  { key: 'nav.groups', path: '/groups', icon: UsersRound, permission: 'groups.view' },
  { key: 'nav.policies', path: '/policies', icon: ShieldCheck, permission: 'policies.view' },
  { key: 'nav.software', path: '/software', icon: ArrowDownToLine, permission: 'software.view' },
  { key: 'nav.mfa', path: '/security/mfa', icon: Key },
  { key: 'nav.reports', path: '/reports', icon: ChartBar, permission: 'logs.view' },
  { key: 'nav.notifications', path: '/notifications', icon: Bell, permission: 'logs.view' },
  { key: 'nav.network', path: '/network', icon: Wifi, permission: 'network.view' },
  { key: 'nav.audit', path: '/audit-logs', icon: FileText, permission: 'logs.view' },
  { key: 'nav.agents', path: '/agents', icon: Cpu, permission: 'devices.view' },
  { key: 'nav.settings', path: '/settings', icon: Settings, permission: 'settings.view' },
];

const routeTitleKeys: Record<string, string> = {
  '/dashboard': 'nav.dashboard',
  '/hermes': 'page.hermes.title',
  '/devices': 'nav.devices',
  '/install': 'page.install.title',
  '/users': 'nav.users',
  '/roles': 'nav.roles',
  '/security': 'nav.security',
  '/alerts': 'nav.alerts',
  '/groups': 'nav.groups',
  '/policies': 'nav.policies',
  '/software': 'nav.software',
  '/security/mfa': 'nav.mfa',
  '/reports': 'nav.reports',
  '/notifications': 'nav.notifications',
  '/network': 'nav.network',
  '/audit-logs': 'nav.audit',
  '/agents': 'nav.agents',
  '/settings': 'nav.settings',
};

export default function Layout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [userDropdownOpen, setUserDropdownOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [alerts, setAlerts] = useState<any[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const location = useLocation();
  const navigate = useNavigate();
  const dropdownRef = useRef<HTMLDivElement>(null);
  const notifRef = useRef<HTMLDivElement>(null);
  const { locale, setLocale, t } = useI18n();
  const { user, hasPermission, logout } = useAuth();

  const visibleNavItems = navItems.filter((item) => !item.permission || hasPermission(item.permission));

  const pageTitle = t(routeTitleKeys[location.pathname] || 'page.title.default');

  useEffect(() => {
    setSidebarOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    fetchAlerts();
    const interval = setInterval(fetchAlerts, 30000);
    return () => clearInterval(interval);
  }, []);

  const fetchAlerts = async () => {
    try {
      const res = await api.request<any>('/alerts?limit=10');
      const data = res?.data || res;
      const alertList = data?.alerts || [];
      setAlerts(alertList);
      setUnreadCount(alertList.filter((a: any) => !a.is_dismissed).length);
    } catch (err) {
      // silent
    }
  };

  const handleDismissAlert = async (id: string) => {
    try {
      await api.request<any>(`/alerts/${id}/dismiss`, { method: 'POST' });
      fetchAlerts();
    } catch (err) {
      // silent
    }
  };

  const severityColor = (s: string) => {
    switch (s) {
      case 'critical': return 'text-red-500 bg-red-100 dark:bg-red-900/30';
      case 'high': return 'text-red-500 bg-red-50 dark:bg-red-900/20';
      case 'medium': return 'text-amber-500 bg-amber-100 dark:bg-amber-900/30';
      case 'low': return 'text-blue-500 bg-blue-100 dark:bg-blue-900/30';
      default: return 'text-gray-500 bg-gray-100 dark:bg-gray-700';
    }
  };

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setUserDropdownOpen(false);
      }
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) {
        setNotifOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setSidebarOpen(false);
        setUserDropdownOpen(false);
      }
    }
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, []);

  const isActive = (path: string) => {
    if (path === '/dashboard') return location.pathname === '/dashboard' || location.pathname === '/';
    return location.pathname.startsWith(path);
  };

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <aside
        className={`fixed top-0 left-0 z-50 h-full w-[260px] bg-white dark:bg-gray-800 border-r border-gray-200 dark:border-gray-700 transition-transform duration-300 ease-in-out lg:translate-x-0 ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex items-center gap-3 px-6 py-5 border-b border-gray-200 dark:border-gray-700">
          <img src="/logotipo-fundo-branco.png" alt="EndpointX" className="w-10 h-10 rounded-lg object-contain dark:hidden" />
          <img src="/logotipo-fundo-escuro.png" alt="EndpointX" className="w-10 h-10 rounded-lg object-contain hidden dark:block" />
          <span className="text-xl font-bold text-gray-900 dark:text-white">EndpointX</span>
          <button
            onClick={() => setSidebarOpen(false)}
            className="ml-auto p-1 rounded-md text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 lg:hidden"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto py-4 px-3">
          <ul className="space-y-1">
            {visibleNavItems.map((item) => {
              const Icon = item.icon;
              const active = isActive(item.path);
              return (
                <li key={item.path}>
                  <Link
                    to={item.path}
                    className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                      active
                        ? 'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
                        : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-white'
                    }`}
                  >
                    <Icon className={`w-5 h-5 flex-shrink-0 ${active ? 'text-blue-600 dark:text-blue-400' : 'text-gray-400 dark:text-gray-500'}`} />
                    {t(item.key)}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="border-t border-gray-200 dark:border-gray-700 p-4">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-full bg-blue-100 dark:bg-blue-900/50 flex items-center justify-center text-blue-600 dark:text-blue-400 font-semibold text-sm">
              {(() => {
                const name = user?.full_name || user?.email || '?';
                const parts = name.trim().split(/\s+/).filter(Boolean);
                return ((parts[0]?.[0] || '?') + (parts[1]?.[0] || '')).toUpperCase();
              })()}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-gray-900 dark:text-white truncate">
                {user?.full_name || user?.email || 'User'}
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
                {user?.role_name || '—'}
              </p>
            </div>
            <button
              onClick={handleLogout}
              className="p-1.5 rounded-md text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
              title={t('nav.logout')}
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </aside>

      <div className="lg:ml-[260px]">
        <header className="sticky top-0 z-30 h-16 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 flex items-center px-4 lg:px-6 gap-4">
          <button
            onClick={() => setSidebarOpen(true)}
            className="p-2 rounded-md text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700 lg:hidden"
          >
            <Menu className="w-5 h-5" />
          </button>

          <h1 className="text-lg font-semibold text-gray-900 dark:text-white">{pageTitle}</h1>

          <div className="flex-1 max-w-md mx-auto hidden md:block">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="text"
                placeholder={t('nav.search')}
                className="w-full pl-9 pr-4 py-2 text-sm bg-gray-100 dark:bg-gray-700 border-0 rounded-lg text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-400 focus:ring-2 focus:ring-blue-500 outline-none"
              />
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="hidden sm:flex items-center rounded-lg bg-gray-100 dark:bg-gray-700 p-0.5 text-xs font-medium">
              {(['pt', 'en'] as Locale[]).map((code) => (
                <button
                  key={code}
                  onClick={() => setLocale(code)}
                  className={`px-2.5 py-1 rounded-md transition-colors ${
                    locale === code
                      ? 'bg-white dark:bg-gray-800 text-blue-600 dark:text-blue-400 shadow-sm'
                      : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
                  }`}
                  title={code === 'pt' ? t('common.portuguese') : t('common.english')}
                >
                  {code.toUpperCase()}
                </button>
              ))}
            </div>

            <div ref={notifRef} className="relative">
              <button
                onClick={() => setNotifOpen(!notifOpen)}
                className="relative p-2 rounded-md text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700 transition-colors"
              >
                <Bell className="w-5 h-5" />
                {unreadCount > 0 && (
                  <>
                    <span className="absolute top-1 right-1 w-2 h-2 bg-red-500 rounded-full" />
                    <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] flex items-center justify-center px-1 text-[10px] font-bold text-white bg-red-500 rounded-full">
                      {unreadCount}
                    </span>
                  </>
                )}
              </button>

              {notifOpen && (
                <div className="absolute right-0 mt-2 w-80 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 z-50">
                  <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-gray-900 dark:text-white">{t('nav.notifications.title')}</h3>
                    <button onClick={() => { setNotifOpen(false); navigate('/alerts'); }} className="text-xs text-blue-600 dark:text-blue-400 hover:underline">
                      {t('nav.notifications.viewAll')}
                    </button>
                  </div>
                  <div className="max-h-80 overflow-y-auto divide-y divide-gray-100 dark:divide-gray-700">
                    {alerts.length === 0 ? (
                      <div className="px-4 py-8 text-center text-sm text-gray-500 dark:text-gray-400">
                        {t('nav.notifications.empty')}
                      </div>
                    ) : (
                      alerts.map((alert) => (
                        <div key={alert.id} className={`px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors ${alert.is_dismissed ? 'opacity-50' : ''}`}>
                          <div className="flex items-start gap-3">
                            <div className={`flex-shrink-0 mt-0.5 p-1.5 rounded-lg ${severityColor(alert.severity)}`}>
                              {alert.severity === 'critical' ? <ShieldAlert className="w-3.5 h-3.5" /> : <AlertTriangle className="w-3.5 h-3.5" />}
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium text-gray-900 dark:text-white truncate">{alert.title}</p>
                              <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 truncate">{alert.description}</p>
                              <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
                                {alert.metadata?.device_hostname || 'Unknown device'} · {new Date(alert.created_at).toLocaleString()}
                              </p>
                            </div>
                            {!alert.is_dismissed && (
                              <button
                                onClick={(e) => { e.stopPropagation(); handleDismissAlert(alert.id); }}
                                className="flex-shrink-0 text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                                title={t('nav.dismiss')}
                              >
                                <X className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>

            <div ref={dropdownRef} className="relative">
              <button
                onClick={() => setUserDropdownOpen(!userDropdownOpen)}
                className="flex items-center gap-2 p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
              >
                <div className="w-8 h-8 rounded-full bg-blue-100 dark:bg-blue-900/50 flex items-center justify-center text-blue-600 dark:text-blue-400 font-semibold text-sm">
                  {(() => {
                    const name = user?.full_name || user?.email || '?';
                    const parts = name.trim().split(/\s+/).filter(Boolean);
                    return ((parts[0]?.[0] || '?') + (parts[1]?.[0] || '')).toUpperCase();
                  })()}
                </div>
                <ChevronDown className={`w-4 h-4 text-gray-400 transition-transform ${userDropdownOpen ? 'rotate-180' : ''}`} />
              </button>

              {userDropdownOpen && (
                <div className="absolute right-0 mt-2 w-56 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 py-1 z-50">
                  <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
                    <p className="text-sm font-medium text-gray-900 dark:text-white">
                      {user?.full_name || user?.email || '—'}
                    </p>
                    <p className="text-xs text-gray-500 dark:text-gray-400">{user?.email || '—'}</p>
                    <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">{user?.role_name || '—'}</p>
                  </div>
                  <Link
                    to="/profile"
                    className="flex items-center gap-2 px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
                    onClick={() => setUserDropdownOpen(false)}
                  >
                    <User className="w-4 h-4" />
                    {t('nav.profile')}
                  </Link>
                  <Link
                    to="/settings"
                    className="flex items-center gap-2 px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
                    onClick={() => setUserDropdownOpen(false)}
                  >
                    <Settings className="w-4 h-4" />
                    {t('nav.settings')}
                  </Link>
                  <hr className="my-1 border-gray-200 dark:border-gray-700" />
                  <button
                    onClick={() => {
                      setUserDropdownOpen(false);
                      handleLogout();
                    }}
                    className="flex items-center gap-2 w-full px-4 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20"
                  >
                    <LogOut className="w-4 h-4" />
                    {t('nav.logout')}
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>

        <main className="p-4 lg:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
