import React, { useState, useMemo, useCallback } from 'react';
import {
  Bell,
  AlertTriangle,
  ShieldAlert,
  CheckCircle,
  XCircle,
} from 'lucide-react';
import { useApi, useApiMutation } from '../hooks/useApi';
import SearchInput from '../components/SearchInput';
import StatusBadge from '../components/StatusBadge';
import DataTable from '../components/DataTable';
import Pagination from '../components/Pagination';
import AlertBanner from '../components/AlertBanner';
import type { Alert, PaginatedResponse } from '../types';

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

interface AlertStats {
  total: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
  unresolved: number;
}

export default function AlertsPage() {
  const [search, setSearch] = useState('');
  const [severityFilter, setSeverityFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [page, setPage] = useState(1);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const params = useMemo(() => {
    const p: Record<string, string> = { page: String(page), limit: '15' };
    if (search) p.search = search;
    if (severityFilter) p.severity = severityFilter;
    if (typeFilter) p.alert_type = typeFilter;
    if (statusFilter) p.dismissed = statusFilter;
    return p;
  }, [page, search, severityFilter, typeFilter, statusFilter]);

  const { data, loading, error, refetch } = useApi<{ alerts: Alert[] }>('/alerts', { params });
  const { data: statsData } = useApi<AlertStats>('/alerts/stats');
  const { loading: dismissing, mutate: dismissAlert } = useApiMutation('', 'POST');
  const { loading: bulkDismissing, mutate: bulkDismiss } = useApiMutation('/alerts/dismiss', 'POST');

  const alerts = Array.isArray(data?.alerts) ? data.alerts : [];
  const totalPages = 1;
  const stats = statsData;

  const handleDismiss = useCallback(
    async (alertId: string) => {
      const result = await dismissAlert(`/alerts/${alertId}/dismiss`);
      if (result) {
        refetch();
        setToast({ type: 'success', message: 'Alert dismissed' });
        setSelectedIds((prev) => {
          const next = new Set(prev);
          next.delete(alertId);
          return next;
        });
      }
    },
    [dismissAlert, refetch]
  );

  const handleBulkDismiss = useCallback(async () => {
    if (selectedIds.size === 0) return;
    const result = await bulkDismiss({ ids: Array.from(selectedIds) });
    if (result) {
      refetch();
      setToast({ type: 'success', message: `${selectedIds.size} alert(s) dismissed` });
      setSelectedIds(new Set());
    }
  }, [selectedIds, bulkDismiss, refetch]);

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === alerts.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(alerts.map((a) => a.id)));
    }
  };

  const columns = [
    {
      key: 'select',
      label: '',
      width: '40px',
      render: (row: Alert) => (
        <input
          type="checkbox"
          checked={selectedIds.has(row.id)}
          onChange={() => toggleSelect(row.id)}
          onClick={(e) => e.stopPropagation()}
          className="w-4 h-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
        />
      ),
    },
    {
      key: 'severity',
      label: 'Severity',
      sortable: true,
      width: '110px',
      render: (row: Alert) => <StatusBadge status={row.severity} />,
    },
    {
      key: 'title',
      label: 'Title',
      sortable: true,
      render: (row: Alert) => (
        <span className="font-medium text-gray-900 dark:text-white">{row.title}</span>
      ),
    },
    {
      key: 'alert_type',
      label: 'Type',
      sortable: true,
      render: (row: Alert) => (
        <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300">
          {row.alert_type}
        </span>
      ),
    },
    {
      key: 'device_name',
      label: 'Device',
      render: (row: Alert) => (
        <span className="text-gray-700 dark:text-gray-300">{row.device_name || 'System'}</span>
      ),
    },
    {
      key: 'created_at',
      label: 'Created',
      sortable: true,
      render: (row: Alert) => (
        <span className="text-gray-500 dark:text-gray-400">{formatTimeAgo(row.created_at)}</span>
      ),
    },
    {
      key: 'actions',
      label: 'Actions',
      render: (row: Alert) => (
        <div className="flex items-center gap-1">
          {!row.is_dismissed && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleDismiss(row.id);
              }}
              disabled={dismissing}
              className="p-1.5 rounded-md text-gray-400 hover:text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 transition-colors disabled:opacity-50"
              title="Dismiss"
            >
              <CheckCircle className="w-4 h-4" />
            </button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Alerts</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            {alerts.length} alert{alerts.length !== 1 ? 's' : ''} total
          </p>
        </div>
        {selectedIds.size > 0 && (
          <button
            onClick={handleBulkDismiss}
            disabled={bulkDismissing}
            className="inline-flex items-center gap-2 px-4 py-2.5 bg-emerald-600 text-white text-sm font-medium rounded-lg hover:bg-emerald-700 disabled:opacity-50 transition-colors"
          >
            <XCircle className="w-4 h-4" />
            {bulkDismissing ? 'Dismissing...' : `Dismiss Selected (${selectedIds.size})`}
          </button>
        )}
      </div>

      {toast && (
        <AlertBanner type={toast.type} message={toast.message} onClose={() => setToast(null)} />
      )}

      {error && (
        <AlertBanner type="error" message={error} onClose={() => {}} />
      )}

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
        {[
          { label: 'Total', value: stats?.total || 0, color: 'text-gray-900 dark:text-white' },
          { label: 'Critical', value: stats?.critical || 0, color: 'text-red-600 dark:text-red-400' },
          { label: 'High', value: stats?.high || 0, color: 'text-red-500 dark:text-red-400' },
          { label: 'Medium', value: stats?.medium || 0, color: 'text-amber-600 dark:text-amber-400' },
          { label: 'Low', value: stats?.low || 0, color: 'text-blue-600 dark:text-blue-400' },
          { label: 'Unresolved', value: stats?.unresolved || 0, color: 'text-orange-600 dark:text-orange-400' },
        ].map((stat) => (
          <div
            key={stat.label}
            className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4"
          >
            <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">{stat.label}</p>
            <p className={`text-2xl font-bold ${stat.color}`}>{stat.value}</p>
          </div>
        ))}
      </div>

      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
        <SearchInput
          value={search}
          onChange={(val) => {
            setSearch(val);
            setPage(1);
          }}
          placeholder="Search alerts..."
          className="w-full sm:w-72"
        />
        <select
          value={severityFilter}
          onChange={(e) => {
            setSeverityFilter(e.target.value);
            setPage(1);
          }}
          className="px-3 py-2.5 text-sm bg-gray-100 dark:bg-gray-700 border border-transparent rounded-lg text-gray-900 dark:text-white focus:ring-2 focus:ring-indigo-500 outline-none"
        >
          <option value="">All Severity</option>
          <option value="critical">Critical</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>
        <select
          value={typeFilter}
          onChange={(e) => {
            setTypeFilter(e.target.value);
            setPage(1);
          }}
          className="px-3 py-2.5 text-sm bg-gray-100 dark:bg-gray-700 border border-transparent rounded-lg text-gray-900 dark:text-white focus:ring-2 focus:ring-indigo-500 outline-none"
        >
          <option value="">All Types</option>
          <option value="performance">Performance</option>
          <option value="security">Security</option>
          <option value="hardware">Hardware</option>
          <option value="software">Software</option>
          <option value="network">Network</option>
        </select>
        <select
          value={statusFilter}
          onChange={(e) => {
            setStatusFilter(e.target.value);
            setPage(1);
          }}
          className="px-3 py-2.5 text-sm bg-gray-100 dark:bg-gray-700 border border-transparent rounded-lg text-gray-900 dark:text-white focus:ring-2 focus:ring-indigo-500 outline-none"
        >
          <option value="">All Status</option>
          <option value="false">Active</option>
          <option value="true">Dismissed</option>
        </select>
      </div>

      <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
        <input
          type="checkbox"
          checked={selectedIds.size === alerts.length && alerts.length > 0}
          onChange={toggleSelectAll}
          className="w-4 h-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
        />
        Select all ({alerts.length})
      </div>

      <DataTable
        columns={columns}
        data={alerts}
        loading={loading}
        emptyMessage="No alerts found"
      />

      <Pagination currentPage={page} totalPages={totalPages} onPageChange={setPage} />
    </div>
  );
}
