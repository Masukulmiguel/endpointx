import React, { useState, useMemo, useCallback } from 'react';
import {
  FileText,
  Download,
  Eye,
  User,
  Shield,
  Settings,
  Trash2,
  Plus,
  Pencil,
  LogIn,
  LogOut,
  AlertTriangle,
} from 'lucide-react';
import { useApi } from '../hooks/useApi';
import api from '../services/api';
import SearchInput from '../components/SearchInput';
import DataTable from '../components/DataTable';
import Pagination from '../components/Pagination';
import Modal from '../components/Modal';
import AlertBanner from '../components/AlertBanner';
import type { AuditLog, PaginatedResponse } from '../types';

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleString();
}

function getActionIcon(action: string) {
  const lower = action.toLowerCase();
  if (lower.includes('login') || lower.includes('auth')) return <LogIn className="w-4 h-4 text-emerald-500" />;
  if (lower.includes('logout') || lower.includes('signout')) return <LogOut className="w-4 h-4 text-gray-500" />;
  if (lower.includes('create') || lower.includes('add')) return <Plus className="w-4 h-4 text-blue-500" />;
  if (lower.includes('update') || lower.includes('edit') || lower.includes('modify')) return <Pencil className="w-4 h-4 text-amber-500" />;
  if (lower.includes('delete') || lower.includes('remove')) return <Trash2 className="w-4 h-4 text-red-500" />;
  if (lower.includes('settings') || lower.includes('config')) return <Settings className="w-4 h-4 text-purple-500" />;
  if (lower.includes('role') || lower.includes('permission')) return <Shield className="w-4 h-4 text-blue-500" />;
  if (lower.includes('user')) return <User className="w-4 h-4 text-cyan-500" />;
  return <FileText className="w-4 h-4 text-gray-400" />;
}

export default function AuditLogsPage() {
  const [search, setSearch] = useState('');
  const [actionFilter, setActionFilter] = useState('');
  const [userFilter, setUserFilter] = useState('');
  const [dateRange, setDateRange] = useState('');
  const [page, setPage] = useState(1);
  const [selectedLog, setSelectedLog] = useState<AuditLog | null>(null);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const params = useMemo(() => {
    const p: Record<string, string> = { page: String(page), limit: '20' };
    if (search) p.search = search;
    if (actionFilter) p.action = actionFilter;
    if (userFilter) p.user_id = userFilter;
    if (dateRange) p.date_range = dateRange;
    return p;
  }, [page, search, actionFilter, userFilter, dateRange]);

  const { data, loading, error } = useApi<{ logs: AuditLog[]; pagination: { page: number; limit: number; total: number; totalPages: number } }>('/audit', { params });

  const logs = Array.isArray(data?.logs) ? data.logs : [];
  const totalPages = data?.pagination?.totalPages || 1;

  const handleExport = useCallback(async () => {
    try {
      const blob = await api.exportAuditLogs(params);
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `audit-logs-${new Date().toISOString().split('T')[0]}.csv`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      setToast({ type: 'success', message: 'Audit logs exported successfully' });
    } catch {
      setToast({ type: 'error', message: 'Failed to export audit logs' });
    }
  }, [params]);

  const columns = [
    {
      key: 'created_at',
      label: 'Timestamp',
      sortable: true,
      render: (row: AuditLog) => (
        <span className="text-gray-700 dark:text-gray-300 font-mono text-xs">
          {formatDate(row.created_at)}
        </span>
      ),
    },
    {
      key: 'user_email',
      label: 'User',
      sortable: true,
      render: (row: AuditLog) => (
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-full bg-gray-100 dark:bg-gray-700 flex items-center justify-center text-xs font-medium text-gray-600 dark:text-gray-400">
            {row.user_email ? row.user_email[0].toUpperCase() : '?'}
          </div>
          <div>
            <p className="text-sm text-gray-900 dark:text-white">{row.user_name || row.user_email || 'System'}</p>
            {row.user_email && row.user_name && (
              <p className="text-xs text-gray-500 dark:text-gray-400">{row.user_email}</p>
            )}
          </div>
        </div>
      ),
    },
    {
      key: 'action',
      label: 'Action',
      sortable: true,
      render: (row: AuditLog) => (
        <div className="flex items-center gap-2">
          {getActionIcon(row.action)}
          <span className="text-sm text-gray-700 dark:text-gray-300 capitalize">{row.action.replace(/_/g, ' ')}</span>
        </div>
      ),
    },
    {
      key: 'target_type',
      label: 'Target',
      render: (row: AuditLog) => (
        <span className="text-gray-700 dark:text-gray-300">
          {row.target_type || 'N/A'}
          {row.target_id && (
            <span className="text-gray-400 dark:text-gray-500 ml-1">#{row.target_id.slice(0, 8)}</span>
          )}
        </span>
      ),
    },
    {
      key: 'description',
      label: 'Description',
      render: (row: AuditLog) => (
        <span className="text-gray-500 dark:text-gray-400 text-sm truncate max-w-xs block">
          {row.description || 'No description'}
        </span>
      ),
    },
    {
      key: 'ip_address',
      label: 'IP Address',
      render: (row: AuditLog) => (
        <span className="font-mono text-xs text-gray-500 dark:text-gray-400">{row.ip_address || 'N/A'}</span>
      ),
    },
    {
      key: 'actions',
      label: '',
      width: '40px',
      render: (row: AuditLog) => (
        <button
          onClick={(e) => {
            e.stopPropagation();
            setSelectedLog(row);
          }}
          className="p-1.5 rounded-md text-gray-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors"
          title="View Details"
        >
          <Eye className="w-4 h-4" />
        </button>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Audit Logs</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            {data?.pagination?.total || 0} log{(data?.pagination?.total || 0) !== 1 ? 's' : ''} total
          </p>
        </div>
        <button
          onClick={handleExport}
          className="inline-flex items-center gap-2 px-4 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
        >
          <Download className="w-4 h-4" />
          Export CSV
        </button>
      </div>

      <div className="flex items-start gap-3 px-4 py-3 rounded-lg border-l-4 border-l-amber-500 bg-amber-50 dark:bg-amber-900/20">
        <AlertTriangle className="w-5 h-5 flex-shrink-0 text-amber-500 mt-0.5" />
        <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
          Audit logs are immutable and cannot be modified or deleted
        </p>
      </div>

      {toast && (
        <AlertBanner type={toast.type} message={toast.message} onClose={() => setToast(null)} />
      )}

      {error && (
        <AlertBanner type="error" message={error} onClose={() => {}} />
      )}

      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
        <SearchInput
          value={search}
          onChange={(val) => {
            setSearch(val);
            setPage(1);
          }}
          placeholder="Search logs..."
          className="w-full sm:w-72"
        />
        <select
          value={actionFilter}
          onChange={(e) => {
            setActionFilter(e.target.value);
            setPage(1);
          }}
          className="px-3 py-2.5 text-sm bg-gray-100 dark:bg-gray-700 border border-transparent rounded-lg text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
        >
          <option value="">All Actions</option>
          <option value="login">Login</option>
          <option value="logout">Logout</option>
          <option value="create">Create</option>
          <option value="update">Update</option>
          <option value="delete">Delete</option>
          <option value="settings_change">Settings Change</option>
        </select>
        <select
          value={userFilter}
          onChange={(e) => {
            setUserFilter(e.target.value);
            setPage(1);
          }}
          className="px-3 py-2.5 text-sm bg-gray-100 dark:bg-gray-700 border border-transparent rounded-lg text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
        >
          <option value="">All Users</option>
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
        data={logs}
        loading={loading}
        emptyMessage="No audit logs found"
        onRowClick={(row) => setSelectedLog(row)}
      />

      <Pagination currentPage={page} totalPages={totalPages} onPageChange={setPage} />

      <Modal
        isOpen={!!selectedLog}
        onClose={() => setSelectedLog(null)}
        title="Audit Log Details"
        size="lg"
      >
        {selectedLog && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Timestamp</p>
                <p className="text-sm font-mono text-gray-900 dark:text-white">{formatDate(selectedLog.created_at)}</p>
              </div>
              <div>
                <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">User</p>
                <p className="text-sm text-gray-900 dark:text-white">{selectedLog.user_name || selectedLog.user_email || 'System'}</p>
              </div>
              <div>
                <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Action</p>
                <div className="flex items-center gap-2">
                  {getActionIcon(selectedLog.action)}
                  <span className="text-sm text-gray-900 dark:text-white capitalize">{selectedLog.action.replace(/_/g, ' ')}</span>
                </div>
              </div>
              <div>
                <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">IP Address</p>
                <p className="text-sm font-mono text-gray-900 dark:text-white">{selectedLog.ip_address || 'N/A'}</p>
              </div>
              <div>
                <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Target Type</p>
                <p className="text-sm text-gray-900 dark:text-white">{selectedLog.target_type || 'N/A'}</p>
              </div>
              <div>
                <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Target ID</p>
                <p className="text-sm font-mono text-gray-900 dark:text-white">{selectedLog.target_id || 'N/A'}</p>
              </div>
            </div>

            {selectedLog.description && (
              <div>
                <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Description</p>
                <p className="text-sm text-gray-700 dark:text-gray-300 bg-gray-50 dark:bg-gray-700/50 p-3 rounded-lg">
                  {selectedLog.description}
                </p>
              </div>
            )}

            {selectedLog.user_agent && (
              <div>
                <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">User Agent</p>
                <p className="text-xs font-mono text-gray-500 dark:text-gray-400 break-all">{selectedLog.user_agent}</p>
              </div>
            )}

            {selectedLog.metadata && Object.keys(selectedLog.metadata).length > 0 && (
              <div>
                <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Metadata</p>
                <pre className="text-xs font-mono text-gray-700 dark:text-gray-300 bg-gray-50 dark:bg-gray-700/50 p-3 rounded-lg overflow-x-auto">
                  {JSON.stringify(selectedLog.metadata, null, 2)}
                </pre>
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
