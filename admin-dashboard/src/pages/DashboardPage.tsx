import React, { useEffect, useCallback } from 'react';
import {
  Monitor,
  Wifi,
  WifiOff,
  AlertTriangle,
  ShieldOff,
  Users,
  Clock,
} from 'lucide-react';
import {
  PieChart,
  Pie,
  Cell,
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import { useNavigate } from 'react-router-dom';
import { useApi } from '../hooks/useApi';
import StatCard from '../components/StatCard';
import StatusBadge from '../components/StatusBadge';
import LoadingSpinner from '../components/LoadingSpinner';
import type { DashboardOverview } from '../types';

const PIE_COLORS = ['#10b981', '#6b7280', '#f59e0b', '#ef4444', '#8b5cf6'];
const SEVERITY_COLORS: Record<string, string> = {
  info: '#6b7280',
  low: '#3b82f6',
  medium: '#f59e0b',
  high: '#ef4444',
  critical: '#dc2626',
};

function formatTimeAgo(dateStr: string): string {
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

function SkeletonStatCard() {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-5 animate-pulse">
      <div className="flex items-start justify-between">
        <div className="w-11 h-11 rounded-lg bg-gray-200 dark:bg-gray-700" />
        <div className="w-12 h-4 rounded bg-gray-200 dark:bg-gray-700" />
      </div>
      <div className="mt-4">
        <div className="w-16 h-8 rounded bg-gray-200 dark:bg-gray-700" />
        <div className="w-24 h-4 rounded bg-gray-200 dark:bg-gray-700 mt-2" />
      </div>
    </div>
  );
}

function SkeletonChart() {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6 animate-pulse">
      <div className="w-40 h-5 rounded bg-gray-200 dark:bg-gray-700 mb-4" />
      <div className="w-full h-64 rounded bg-gray-100 dark:bg-gray-700/50" />
    </div>
  );
}

export default function DashboardPage() {
  const { data, loading, error, refetch } = useApi<DashboardOverview>('/dashboard/overview');
  const navigate = useNavigate();

  const startAutoRefresh = useCallback(() => {
    const interval = setInterval(() => {
      refetch();
    }, 30000);
    return interval;
  }, [refetch]);

  useEffect(() => {
    const interval = startAutoRefresh();
    return () => clearInterval(interval);
  }, [startAutoRefresh]);

  const overview = data;

  const statCards = overview
    ? [
        { title: 'Total Devices', value: overview.total_devices, change: 0, icon: Monitor, color: 'primary' as const },
        { title: 'Online', value: overview.online_devices, change: 0, icon: Wifi, color: 'success' as const },
        { title: 'Offline', value: overview.offline_devices, change: 0, icon: WifiOff, color: 'warning' as const },
        { title: 'Alerts', value: overview.alert_devices, change: 0, icon: AlertTriangle, color: 'danger' as const },
        { title: 'Blocked', value: overview.blocked_devices, change: 0, icon: ShieldOff, color: 'danger' as const },
        { title: 'Active Users', value: overview.active_users, change: 0, icon: Users, color: 'info' as const },
      ]
    : [];

  if (error) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <p className="text-red-500 dark:text-red-400 text-sm">{error}</p>
          <button onClick={refetch} className="mt-3 text-sm text-indigo-600 hover:text-indigo-500">
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Dashboard</h1>
        <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
          <Clock className="w-4 h-4" />
          Auto-refreshes every 30s
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
        {loading && !overview
          ? Array.from({ length: 6 }).map((_, i) => <SkeletonStatCard key={i} />)
          : statCards.map((stat) => (
              <StatCard
                key={stat.title}
                title={stat.title}
                value={stat.value}
                change={stat.change}
                icon={stat.icon}
                color={stat.color}
              />
            ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {loading && !overview ? (
          <>
            <SkeletonChart />
            <SkeletonChart />
            <SkeletonChart />
            <SkeletonChart />
          </>
        ) : (
          <>
            <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-4">
                Device Status Distribution
              </h3>
              <ResponsiveContainer width="100%" height={280}>
                <PieChart>
                  <Pie
                    data={overview?.device_status_distribution || []}
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={100}
                    paddingAngle={4}
                    dataKey="count"
                    nameKey="status"
                  >
                    {(overview?.device_status_distribution || []).map((_, index) => (
                      <Cell key={`cell-${index}`} fill={PIE_COLORS[index % PIE_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#1f2937',
                      border: '1px solid #374151',
                      borderRadius: '8px',
                      color: '#f3f4f6',
                    }}
                  />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
            </div>

            <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-4">
                Heartbeat Trend (Last 24h)
              </h3>
              <ResponsiveContainer width="100%" height={280}>
                <LineChart data={overview?.heartbeat_trend || []}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                  <XAxis dataKey="time" stroke="#9ca3af" fontSize={12} />
                  <YAxis stroke="#9ca3af" fontSize={12} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#1f2937',
                      border: '1px solid #374151',
                      borderRadius: '8px',
                      color: '#f3f4f6',
                    }}
                  />
                  <Line
                    type="monotone"
                    dataKey="count"
                    stroke="#6366f1"
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 4 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>

            <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-4">
                Alerts by Type
              </h3>
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={overview?.alerts_by_type || []}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                  <XAxis dataKey="type" stroke="#9ca3af" fontSize={12} />
                  <YAxis stroke="#9ca3af" fontSize={12} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#1f2937',
                      border: '1px solid #374151',
                      borderRadius: '8px',
                      color: '#f3f4f6',
                    }}
                  />
                  <Bar dataKey="count" fill="#f59e0b" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>

            <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-4">
                Security Events by Severity
              </h3>
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={overview?.events_by_severity || []}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                  <XAxis dataKey="severity" stroke="#9ca3af" fontSize={12} />
                  <YAxis stroke="#9ca3af" fontSize={12} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#1f2937',
                      border: '1px solid #374151',
                      borderRadius: '8px',
                      color: '#f3f4f6',
                    }}
                  />
                  <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                    {(overview?.events_by_severity || []).map((entry, index) => (
                      <Cell
                        key={`sev-${index}`}
                        fill={SEVERITY_COLORS[entry.severity] || '#6b7280'}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700">
          <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
              Recent Security Events
            </h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 dark:border-gray-700">
                  <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">
                    Event
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">
                    Device
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">
                    Severity
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">
                    Time
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                {loading && !overview ? (
                  Array.from({ length: 5 }).map((_, i) => (
                    <tr key={i} className="animate-pulse">
                      <td className="px-6 py-3"><div className="h-4 bg-gray-200 dark:bg-gray-700 rounded w-32" /></td>
                      <td className="px-6 py-3"><div className="h-4 bg-gray-200 dark:bg-gray-700 rounded w-24" /></td>
                      <td className="px-6 py-3"><div className="h-5 bg-gray-200 dark:bg-gray-700 rounded-full w-16" /></td>
                      <td className="px-6 py-3"><div className="h-4 bg-gray-200 dark:bg-gray-700 rounded w-16" /></td>
                    </tr>
                  ))
                ) : (overview?.recent_events || []).length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-6 py-8 text-center text-gray-500 dark:text-gray-400">
                      No recent security events
                    </td>
                  </tr>
                ) : (
                  (overview?.recent_events || []).map((event) => (
                    <tr
                      key={event.id}
                      className="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors"
                    >
                      <td className="px-6 py-3 text-gray-900 dark:text-gray-100">
                        {event.title}
                      </td>
                      <td className="px-6 py-3 text-gray-500 dark:text-gray-400">
                        {event.device_name || 'System'}
                      </td>
                      <td className="px-6 py-3">
                        <StatusBadge status={event.severity} />
                      </td>
                      <td className="px-6 py-3 text-gray-500 dark:text-gray-400">
                        {formatTimeAgo(event.created_at)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700">
          <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
              Critical Alerts
            </h3>
          </div>
          <div className="divide-y divide-gray-200 dark:divide-gray-700 max-h-96 overflow-y-auto">
            {loading && !overview ? (
              Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="px-6 py-4 animate-pulse">
                  <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded w-3/4 mb-2" />
                  <div className="h-3 bg-gray-200 dark:bg-gray-700 rounded w-1/2" />
                </div>
              ))
            ) : (overview?.critical_alerts || []).length === 0 ? (
              <div className="px-6 py-8 text-center text-gray-500 dark:text-gray-400 text-sm">
                No critical alerts
              </div>
            ) : (
              (overview?.critical_alerts || []).map((alert) => (
                <button
                  key={alert.id}
                  onClick={() => navigate(`/alerts`)}
                  className="w-full px-6 py-4 text-left hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-900 dark:text-white truncate">
                        {alert.title}
                      </p>
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                        {alert.device_name || 'System'} &middot; {formatTimeAgo(alert.created_at)}
                      </p>
                    </div>
                    <StatusBadge status={alert.severity} />
                  </div>
                </button>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
