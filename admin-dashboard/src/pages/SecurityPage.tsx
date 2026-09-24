import React, { useState, useMemo, useCallback } from 'react';
import {
  Lock,
  ShieldAlert,
  ShieldCheck,
  AlertTriangle,
  Info,
  CheckCircle,
  Eye,
} from 'lucide-react';
import { useApi, useApiMutation } from '../hooks/useApi';
import { useAuth } from '../contexts/AuthContext';
import SearchInput from '../components/SearchInput';
import StatusBadge from '../components/StatusBadge';
import DataTable from '../components/DataTable';
import Pagination from '../components/Pagination';
import Modal from '../components/Modal';
import AlertBanner from '../components/AlertBanner';
import type { SecurityEvent, PaginatedResponse } from '../types';

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleString();
}

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

function SeverityIcon({ severity }: { severity: string }) {
  switch (severity) {
    case 'critical':
      return <ShieldAlert className="w-4 h-4 text-red-500" />;
    case 'high':
      return <AlertTriangle className="w-4 h-4 text-red-500" />;
    case 'medium':
      return <AlertTriangle className="w-4 h-4 text-amber-500" />;
    case 'low':
      return <Info className="w-4 h-4 text-blue-500" />;
    default:
      return <Info className="w-4 h-4 text-gray-400" />;
  }
}

interface Stats {
  total: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
  resolved: number;
  by_type?: { event_type: string; count: number | string }[];
}

interface EventsResponse {
  events: SecurityEvent[];
  pagination?: { page: number; limit: number; total: number; totalPages: number };
}

export default function SecurityPage() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('security.manage');
  const [search, setSearch] = useState('');
  const [severityFilter, setSeverityFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [dateRange, setDateRange] = useState('');
  const [page, setPage] = useState(1);
  const [selectedEvent, setSelectedEvent] = useState<SecurityEvent | null>(null);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const params = useMemo(() => {
    const p: Record<string, string> = { page: String(page), limit: '15' };
    if (search) p.search = search;
    if (severityFilter) p.severity = severityFilter;
    if (typeFilter) p.event_type = typeFilter;
    if (dateRange) p.date_range = dateRange;
    return p;
  }, [page, search, severityFilter, typeFilter, dateRange]);

  const { data, loading, error, refetch } = useApi<EventsResponse>('/security/events', { params });
  const { data: statsData, refetch: refetchStats } = useApi<Stats>('/security/events/stats');
  const { loading: resolving, mutate: resolveEvent } = useApiMutation('', 'POST');

  const events = Array.isArray(data?.events) ? data.events : [];
  const totalPages = data?.pagination?.totalPages || 1;
  const stats = statsData;

  const typeOptions = useMemo(() => {
    const byType = statsData?.by_type;
    if (!Array.isArray(byType) || byType.length === 0) return [];
    return byType.map((t) => String(t.event_type));
  }, [statsData]);

  const handleResolve = useCallback(
    async (eventId: string) => {
      const result = await resolveEvent(`/security/events/${eventId}/resolve`);
      if (result) {
        refetch();
        refetchStats();
        setToast({ type: 'success', message: 'Event resolved successfully' });
        setSelectedEvent(null);
      }
    },
    [resolveEvent, refetch, refetchStats]
  );

  const columns = [
    {
      key: 'severity',
      label: 'Severity',
      sortable: true,
      width: '100px',
      render: (row: SecurityEvent) => (
        <div className="flex items-center gap-2">
          <SeverityIcon severity={row.severity} />
          <StatusBadge status={row.severity} />
        </div>
      ),
    },
    {
      key: 'title',
      label: 'Title',
      sortable: true,
      render: (row: SecurityEvent) => (
        <span className="font-medium text-gray-900 dark:text-white">{row.title}</span>
      ),
    },
    {
      key: 'device_name',
      label: 'Device',
      render: (row: SecurityEvent) => (
        <span className="text-gray-700 dark:text-gray-300">{row.device_name || 'System'}</span>
      ),
    },
    {
      key: 'event_type',
      label: 'Event Type',
      sortable: true,
      render: (row: SecurityEvent) => (
        <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300">
          {row.event_type}
        </span>
      ),
    },
    {
      key: 'created_at',
      label: 'Date',
      sortable: true,
      render: (row: SecurityEvent) => (
        <span className="text-gray-500 dark:text-gray-400">{formatTimeAgo(row.created_at)}</span>
      ),
    },
    {
      key: 'is_resolved',
      label: 'Status',
      sortable: true,
      render: (row: SecurityEvent) => (
        <span
          className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${
            row.is_resolved
              ? 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400'
              : 'bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400'
          }`}
        >
          {row.is_resolved ? (
            <CheckCircle className="w-3 h-3" />
          ) : (
            <AlertTriangle className="w-3 h-3" />
          )}
          {row.is_resolved ? 'Resolved' : 'Unresolved'}
        </span>
      ),
    },
    {
      key: 'actions',
      label: 'Actions',
      render: (row: SecurityEvent) => (
        <div className="flex items-center gap-1">
          <button
            onClick={(e) => {
              e.stopPropagation();
              setSelectedEvent(row);
            }}
            className="p-1.5 rounded-md text-gray-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors"
            title="View Details"
          >
            <Eye className="w-4 h-4" />
          </button>
          {canManage && !row.is_resolved && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleResolve(row.id);
              }}
              disabled={resolving}
              className="p-1.5 rounded-md text-gray-400 hover:text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 transition-colors disabled:opacity-50"
              title="Resolve"
            >
              <ShieldCheck className="w-4 h-4" />
            </button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Security</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          Monitor security events across all devices
        </p>
      </div>

      {toast && (
        <AlertBanner type={toast.type} message={toast.message} onClose={() => setToast(null)} />
      )}

      {error && (
        <AlertBanner type="error" message={error} onClose={() => {}} />
      )}

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
        {[
          { label: 'Total Events', value: stats?.total || 0, color: 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400' },
          { label: 'Critical', value: stats?.critical || 0, color: 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400' },
          { label: 'High', value: stats?.high || 0, color: 'bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400' },
          { label: 'Medium', value: stats?.medium || 0, color: 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400' },
          { label: 'Low', value: stats?.low || 0, color: 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400' },
          { label: 'Resolved', value: stats?.resolved || 0, color: 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400' },
        ].map((stat) => (
          <div
            key={stat.label}
            className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4"
          >
            <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">{stat.label}</p>
            <p className={`text-2xl font-bold ${stat.color.split(' ')[1]}`}>{stat.value}</p>
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
          placeholder="Search events..."
          className="w-full sm:w-72"
        />
        <select
          value={severityFilter}
          onChange={(e) => {
            setSeverityFilter(e.target.value);
            setPage(1);
          }}
          className="px-3 py-2.5 text-sm bg-gray-100 dark:bg-gray-700 border border-transparent rounded-lg text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
        >
          <option value="">All Severity</option>
          <option value="critical">Critical</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
          <option value="info">Info</option>
        </select>
        <select
          value={typeFilter}
          onChange={(e) => {
            setTypeFilter(e.target.value);
            setPage(1);
          }}
          className="px-3 py-2.5 text-sm bg-gray-100 dark:bg-gray-700 border border-transparent rounded-lg text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
        >
          <option value="">All Types</option>
          {typeOptions.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        <select
          value={dateRange}
          onChange={(e) => {
            setDateRange(e.target.value);
            setPage(1);
          }}
          className="px-3 py-2.5 text-sm bg-gray-100 dark:bg-gray-700 border border-transparent rounded-lg text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
        >
          <option value="">All Time</option>
          <option value="24h">Last 24 Hours</option>
          <option value="7d">Last 7 Days</option>
          <option value="30d">Last 30 Days</option>
        </select>
      </div>

      <DataTable
        columns={columns}
        data={events}
        loading={loading}
        emptyMessage="No security events found"
        onRowClick={(row) => setSelectedEvent(row)}
      />

      <Pagination currentPage={page} totalPages={totalPages} onPageChange={setPage} />

      <Modal
        isOpen={!!selectedEvent}
        onClose={() => setSelectedEvent(null)}
        title="Security Event Details"
        size="lg"
      >
        {selectedEvent && (
          <div className="space-y-4">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{selectedEvent.title}</h3>
                <div className="flex items-center gap-2 mt-2">
                  <StatusBadge status={selectedEvent.severity} />
                  <span
                    className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium ${
                      selectedEvent.is_resolved
                        ? 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400'
                        : 'bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400'
                    }`}
                  >
                    {selectedEvent.is_resolved ? 'Resolved' : 'Unresolved'}
                  </span>
                </div>
              </div>
              {!selectedEvent.is_resolved && (
                <button
                  onClick={() => handleResolve(selectedEvent.id)}
                  disabled={resolving}
                  className="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 disabled:opacity-50 transition-colors"
                >
                  <ShieldCheck className="w-4 h-4" />
                  {resolving ? 'Resolving...' : 'Resolve'}
                </button>
              )}
            </div>

            <div className="grid grid-cols-2 gap-4 p-4 bg-gray-50 dark:bg-gray-700/50 rounded-lg">
              <div>
                <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Event Type</p>
                <p className="text-sm text-gray-900 dark:text-white">{selectedEvent.event_type}</p>
              </div>
              <div>
                <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Device</p>
                <p className="text-sm text-gray-900 dark:text-white">{selectedEvent.device_name || 'System'}</p>
              </div>
              <div>
                <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Source</p>
                <p className="text-sm text-gray-900 dark:text-white">{selectedEvent.source || 'N/A'}</p>
              </div>
              <div>
                <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Created</p>
                <p className="text-sm text-gray-900 dark:text-white">{formatDate(selectedEvent.created_at)}</p>
              </div>
              {selectedEvent.resolved_at && (
                <>
                  <div>
                    <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Resolved By</p>
                    <p className="text-sm text-gray-900 dark:text-white">{selectedEvent.resolved_by || 'N/A'}</p>
                  </div>
                  <div>
                    <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Resolved At</p>
                    <p className="text-sm text-gray-900 dark:text-white">{formatDate(selectedEvent.resolved_at)}</p>
                  </div>
                </>
              )}
            </div>

            {selectedEvent.description && (
              <div>
                <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Description</p>
                <p className="text-sm text-gray-700 dark:text-gray-300 bg-gray-50 dark:bg-gray-700/50 p-3 rounded-lg">
                  {selectedEvent.description}
                </p>
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
