import React from 'react';
import {
  Monitor,
  Wifi,
  WifiOff,
  AlertTriangle,
  ShieldOff,
  Users,
  Clock,
  RefreshCw,
} from 'lucide-react';
import {
  PieChart,
  Pie,
  Cell,
  AreaChart,
  Area,
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
import ErrorState from '../components/ErrorState';
import type { DashboardOverview } from '../types';
import { useI18n } from '../i18n';

const PIE_COLORS = ['#10b981', '#6b7280', '#f59e0b', '#ef4444', '#8b5cf6'];
const SEVERITY_COLORS: Record<string, string> = {
  info: '#6b7280',
  low: '#3b82f6',
  medium: '#f59e0b',
  high: '#ef4444',
  critical: '#dc2626',
};

// Chart chrome for white cards: light grid, muted axes, white tooltip.
const GRID_STROKE = '#e2e8f0';
const AXIS_STROKE = '#94a3b8';
const TOOLTIP_STYLE = {
  backgroundColor: '#ffffff',
  border: '1px solid #e2e8f0',
  borderRadius: '8px',
  color: '#0f172a',
  boxShadow: '0 4px 12px rgba(15, 23, 42, 0.08)',
};
const AREA_GRADIENT_ID = 'heartbeat-fill';

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
    <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm shadow-slate-200/60 animate-pulse">
      <div className="flex items-start justify-between gap-3">
        <div className="w-20 h-3 rounded bg-slate-200" />
        <div className="w-10 h-10 rounded-lg bg-slate-200" />
      </div>
      <div className="mt-3 w-16 h-8 rounded bg-slate-200" />
      <div className="mt-2 w-14 h-3 rounded bg-slate-200" />
    </div>
  );
}

function SkeletonChart() {
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-6 shadow-sm shadow-slate-200/60 animate-pulse">
      <div className="w-40 h-5 rounded bg-slate-200 mb-4" />
      <div className="w-full h-64 rounded bg-slate-100" />
    </div>
  );
}

export default function DashboardPage() {
  const { data, loading, error, refetch } = useApi<DashboardOverview>('/dashboard/overview', {
    refreshInterval: 30000,
  });
  const navigate = useNavigate();
  const { t } = useI18n();

  const overview = data;
  const statusTotal = (overview?.device_status_distribution || []).reduce(
    (sum, s) => sum + (Number(s.count) || 0),
    0
  );

  const statCards = overview
    ? [
        { title: t('dashboard.totalDevices'), value: overview.total_devices, change: 0, icon: Monitor, color: 'primary' as const },
        { title: t('dashboard.online'), value: overview.online_devices, change: 0, icon: Wifi, color: 'success' as const },
        { title: t('dashboard.offline'), value: overview.offline_devices, change: 0, icon: WifiOff, color: 'warning' as const },
        { title: t('dashboard.alerts'), value: overview.total_alerts || overview.alert_devices, change: 0, icon: AlertTriangle, color: 'danger' as const },
        { title: t('dashboard.blocked'), value: overview.blocked_devices, change: 0, icon: ShieldOff, color: 'danger' as const },
        { title: t('dashboard.activeUsers'), value: overview.active_users, change: 0, icon: Users, color: 'info' as const },
      ]
    : [];

  if (error) {
    return <ErrorState error={error} onRetry={refetch} title={t('dashboard.failedLoad')} />;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-gray-900">{t('dashboard.title')}</h1>
          <p className="mt-1 flex items-center gap-1.5 text-sm text-gray-500">
            <Clock className="w-4 h-4" />
            {t('dashboard.autoRefresh')}
          </p>
        </div>
        <button
          type="button"
          onClick={() => refetch()}
          disabled={loading}
          className="btn-secondary text-sm disabled:opacity-60"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          {t('common.refresh')}
        </button>
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

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {loading && !overview ? (
          <>
            <div className="lg:col-span-2">
              <SkeletonChart />
            </div>
            <SkeletonChart />
          </>
        ) : (
          <>
            <div className="lg:col-span-2 bg-white rounded-xl border border-slate-200 p-6 shadow-sm shadow-slate-200/60">
              <h3 className="text-sm font-semibold text-slate-900 mb-4">
                {t('dashboard.heartbeat')}
              </h3>
              <ResponsiveContainer width="100%" height={300}>
                <AreaChart data={overview?.heartbeat_trend || []}>
                  <defs>
                    <linearGradient id={AREA_GRADIENT_ID} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#06b6d4" stopOpacity={0.35} />
                      <stop offset="95%" stopColor="#06b6d4" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
                  <XAxis dataKey="time" stroke={AXIS_STROKE} fontSize={12} tickLine={false} />
                  <YAxis stroke={AXIS_STROKE} fontSize={12} tickLine={false} width={36} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} />
                  <Area
                    type="monotone"
                    dataKey="count"
                    stroke="#0891b2"
                    strokeWidth={2.5}
                    fill={`url(#${AREA_GRADIENT_ID})`}
                    activeDot={{ r: 4 }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>

            <div className="bg-white rounded-xl border border-slate-200 p-6 shadow-sm shadow-slate-200/60">
              <h3 className="text-sm font-semibold text-slate-900 mb-4">
                {t('dashboard.deviceStatus')}
              </h3>
              <div className="relative">
                <ResponsiveContainer width="100%" height={240}>
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
                    <Tooltip contentStyle={TOOLTIP_STYLE} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                  <Monitor className="w-9 h-9 text-slate-400" strokeWidth={1.5} />
                  <span className="mt-1 text-lg font-semibold text-slate-900">{statusTotal}</span>
                </div>
              </div>
              <div className="mt-4 flex flex-wrap justify-center gap-x-4 gap-y-2">
                {(overview?.device_status_distribution || []).map((s, index) => (
                  <span
                    key={s.status}
                    className="inline-flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-300"
                  >
                    <span
                      className="w-2.5 h-2.5 rounded-full"
                      style={{ backgroundColor: PIE_COLORS[index % PIE_COLORS.length] }}
                    />
                    {s.status.replace(/_/g, ' ')} · {Number(s.count) || 0}
                  </span>
                ))}
              </div>
            </div>

          </>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {loading && !overview ? (
          <>
            <SkeletonChart />
            <SkeletonChart />
          </>
        ) : (
          <>
            <div className="bg-white rounded-xl border border-slate-200 p-6 shadow-sm shadow-slate-200/60">
              <h3 className="text-sm font-semibold text-slate-900 mb-4">
                {t('dashboard.alertsByType')}
              </h3>
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={overview?.alerts_by_type || []}>
                  <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
                  <XAxis dataKey="type" stroke={AXIS_STROKE} fontSize={12} tickLine={false} />
                  <YAxis stroke={AXIS_STROKE} fontSize={12} tickLine={false} width={36} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} />
                  <Bar dataKey="count" fill="#f59e0b" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>

            <div className="bg-white rounded-xl border border-slate-200 p-6 shadow-sm shadow-slate-200/60">
              <h3 className="text-sm font-semibold text-slate-900 mb-4">
                {t('dashboard.eventsBySeverity')}
              </h3>
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={overview?.events_by_severity || []}>
                  <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
                  <XAxis dataKey="severity" stroke={AXIS_STROKE} fontSize={12} tickLine={false} />
                  <YAxis stroke={AXIS_STROKE} fontSize={12} tickLine={false} width={36} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} />
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
              {t('dashboard.recentEvents')}
            </h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 dark:border-gray-700">
                  <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">
                    {t('dashboard.event')}
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">
                    {t('nav.devices')}
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">
                    {t('hermes.severity')}
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">
                    {t('dashboard.time')}
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
                      {t('dashboard.noRecentEvents')}
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
