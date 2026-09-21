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
} from 'lucide-react';
import api from '../services/api';

const navItems = [
  { label: 'Dashboard', path: '/dashboard', icon: LayoutDashboard },
  { label: 'Devices', path: '/devices', icon: Monitor },
  { label: 'Install Agent', path: '/install', icon: Download },
  { label: 'Users', path: '/users', icon: Users },
  { label: 'Roles & Permissions', path: '/roles', icon: Shield },
  { label: 'Security', path: '/security', icon: Lock },
  { label: 'Alerts', path: '/alerts', icon: Bell },
  { label: 'Network', path: '/network', icon: Wifi },
  { label: 'Audit Logs', path: '/audit-logs', icon: FileText },
  { label: 'Agents', path: '/agents', icon: Cpu },
  { label: 'Settings', path: '/settings', icon: Settings },
];

const routeTitles: Record<string, string> = {
  '/dashboard': 'Dashboard',
  '/devices': 'Devices',
  '/install': 'Install Agent',
  '/users': 'Users',
  '/roles': 'Roles & Permissions',
  '/security': 'Security',
  '/alerts': 'Alerts',
  '/network': 'Network',
  '/audit-logs': 'Audit Logs',
  '/agents': 'Agents',
  '/settings': 'Settings',
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

  const pageTitle = routeTitles[location.pathname] || 'EndpointX';

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
          <img src="/logotipo.png" alt="EndpointX" className="w-10 h-10 rounded-lg object-contain" />
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
            {navItems.map((item) => {
              const Icon = item.icon;
              const active = isActive(item.path);
              return (
                <li key={item.path}>
                  <Link
                    to={item.path}
                    className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                      active
                        ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400'
                        : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-white'
                    }`}
                  >
                    <Icon className={`w-5 h-5 flex-shrink-0 ${active ? 'text-indigo-600 dark:text-indigo-400' : 'text-gray-400 dark:text-gray-500'}`} />
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="border-t border-gray-200 dark:border-gray-700 p-4">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-full bg-indigo-100 dark:bg-indigo-900/50 flex items-center justify-center text-indigo-600 dark:text-indigo-400 font-semibold text-sm">
              A
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-gray-900 dark:text-white truncate">Admin User</p>
              <p className="text-xs text-gray-500 dark:text-gray-400 truncate">Super Admin</p>
            </div>
            <button
              onClick={handleLogout}
              className="p-1.5 rounded-md text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
              title="Logout"
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
                placeholder="Search..."
                className="w-full pl-9 pr-4 py-2 text-sm bg-gray-100 dark:bg-gray-700 border-0 rounded-lg text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-400 focus:ring-2 focus:ring-indigo-500 outline-none"
              />
            </div>
          </div>

          <div className="flex items-center gap-3">
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
                    <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Notifications</h3>
                    <button onClick={() => { setNotifOpen(false); navigate('/alerts'); }} className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline">
                      View all
                    </button>
                  </div>
                  <div className="max-h-80 overflow-y-auto divide-y divide-gray-100 dark:divide-gray-700">
                    {alerts.length === 0 ? (
                      <div className="px-4 py-8 text-center text-sm text-gray-500 dark:text-gray-400">
                        No notifications
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
                                title="Dismiss"
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
                <div className="w-8 h-8 rounded-full bg-indigo-100 dark:bg-indigo-900/50 flex items-center justify-center text-indigo-600 dark:text-indigo-400 font-semibold text-sm">
                  A
                </div>
                <ChevronDown className={`w-4 h-4 text-gray-400 transition-transform ${userDropdownOpen ? 'rotate-180' : ''}`} />
              </button>

              {userDropdownOpen && (
                <div className="absolute right-0 mt-2 w-56 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 py-1 z-50">
                  <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
                    <p className="text-sm font-medium text-gray-900 dark:text-white">Admin User</p>
                    <p className="text-xs text-gray-500 dark:text-gray-400">admin@endpointx.com</p>
                  </div>
                  <Link
                    to="/profile"
                    className="flex items-center gap-2 px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
                    onClick={() => setUserDropdownOpen(false)}
                  >
                    <User className="w-4 h-4" />
                    My Profile
                  </Link>
                  <Link
                    to="/settings"
                    className="flex items-center gap-2 px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
                    onClick={() => setUserDropdownOpen(false)}
                  >
                    <Settings className="w-4 h-4" />
                    Settings
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
                    Logout
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
