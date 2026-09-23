import React, { useState, useMemo, useCallback } from 'react';
import {
  Cpu,
  Download,
  Eye,
  RefreshCw,
  Clock,
  AlertTriangle,
  Monitor,
} from 'lucide-react';
import { useApi, useApiMutation } from '../hooks/useApi';
import StatusBadge from '../components/StatusBadge';
import DataTable from '../components/DataTable';
import Pagination from '../components/Pagination';
import Modal from '../components/Modal';
import AlertBanner from '../components/AlertBanner';
import type { Device, PaginatedResponse } from '../types';

function formatTimeAgo(dateStr: string | null): string {
  if (!dateStr) return 'Never';
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

interface AgentStats {
  total: number;
  online: number;
  outdated: number;
}

export default function AgentsPage() {
  const [page, setPage] = useState(1);
  const [selectedDevice, setSelectedDevice] = useState<Device | null>(null);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const params = useMemo(() => {
    return { page: String(page), limit: '15' };
  }, [page]);

  const { data, loading, error, refetch } = useApi<{ devices: Device[]; pagination: { page: number; limit: number; total: number; totalPages: number } }>('/devices', { params });
  const { data: statsData } = useApi<AgentStats>('/agents/stats');
  const { loading: updating, mutate: updateAgent } = useApiMutation('', 'POST');

  const devices = Array.isArray(data?.devices) ? data.devices : [];
  const totalPages = data?.pagination?.totalPages || 1;
  const stats = statsData;

  const handleUpdateAgent = useCallback(
    async (deviceId: string) => {
      const result = await updateAgent(`/devices/${deviceId}/update-agent`);
      if (result) {
        refetch();
        setToast({ type: 'success', message: 'Agent update initiated' });
        setSelectedDevice(null);
      }
    },
    [updateAgent, refetch]
  );

  const columns = [
    {
      key: 'hostname',
      label: 'Device',
      sortable: true,
      render: (row: Device) => (
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-gray-100 dark:bg-gray-700">
            <Monitor className="w-5 h-5 text-gray-400" />
          </div>
          <div>
            <p className="font-medium text-gray-900 dark:text-white">{row.display_name || row.hostname}</p>
            <p className="text-xs text-gray-500 dark:text-gray-400">{row.hostname}</p>
          </div>
        </div>
      ),
    },
    {
      key: 'agent_version',
      label: 'Agent Version',
      sortable: true,
      render: (row: Device) => (
        <span className="px-2.5 py-1 rounded-full text-xs font-mono font-medium bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300">
          {row.agent_version || 'N/A'}
        </span>
      ),
    },
    {
      key: 'status',
      label: 'Status',
      sortable: true,
      render: (row: Device) => <StatusBadge status={row.status} />,
    },
    {
      key: 'last_heartbeat',
      label: 'Last Heartbeat',
      sortable: true,
      render: (row: Device) => (
        <span className="flex items-center gap-1 text-gray-500 dark:text-gray-400">
          <Clock className="w-3 h-3" />
          {formatTimeAgo(row.last_heartbeat)}
        </span>
      ),
    },
    {
      key: 'actions',
      label: 'Actions',
      render: (row: Device) => (
        <div className="flex items-center gap-1">
          <button
            onClick={(e) => {
              e.stopPropagation();
              setSelectedDevice(row);
            }}
            className="p-1.5 rounded-md text-gray-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors"
            title="View Details"
          >
            <Eye className="w-4 h-4" />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleUpdateAgent(row.id);
            }}
            disabled={updating}
            className="p-1.5 rounded-md text-gray-400 hover:text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-900/20 transition-colors disabled:opacity-50"
            title="Update Agent"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Agents</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          Manage endpoint agents
        </p>
      </div>

      {toast && (
        <AlertBanner type={toast.type} message={toast.message} onClose={() => setToast(null)} />
      )}

      {error && (
        <AlertBanner type="error" message={error} onClose={() => {}} />
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {[
          { label: 'Total Agents', value: stats?.total || 0, icon: Cpu, color: 'text-blue-600 dark:text-blue-400' },
          { label: 'Online', value: stats?.online || 0, icon: RefreshCw, color: 'text-emerald-600 dark:text-emerald-400' },
          { label: 'Outdated', value: stats?.outdated || 0, icon: AlertTriangle, color: 'text-amber-600 dark:text-amber-400' },
        ].map((stat) => (
          <div
            key={stat.label}
            className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-5"
          >
            <div className="flex items-center gap-3">
              <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-gray-100 dark:bg-gray-700">
                <stat.icon className={`w-5 h-5 ${stat.color}`} />
              </div>
              <div>
                <p className="text-xs font-medium text-gray-500 dark:text-gray-400">{stat.label}</p>
                <p className="text-xl font-bold text-gray-900 dark:text-white">{stat.value}</p>
              </div>
            </div>
          </div>
        ))}
      </div>

      <DataTable
        columns={columns}
        data={devices}
        loading={loading}
        emptyMessage="No agents found"
      />

      <Pagination currentPage={page} totalPages={totalPages} onPageChange={setPage} />

      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-blue-100 dark:bg-blue-900/30">
            <Download className="w-5 h-5 text-blue-600 dark:text-blue-400" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Agent Installation</h2>
            <p className="text-xs text-gray-500 dark:text-gray-400">Install the EndpointX agent on new devices</p>
          </div>
        </div>
        <div className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-4 font-mono text-sm text-gray-700 dark:text-gray-300 space-y-2">
          <p className="text-xs text-gray-500 dark:text-gray-400"># Windows</p>
          <p>powershell -ExecutionPolicy Bypass -File install-agent.ps1 -Token YOUR_TOKEN</p>
          <p className="text-xs text-gray-500 dark:text-gray-400 pt-2"># macOS / Linux</p>
          <p>curl -sSL https://agent.endpointx.com/install.sh | bash -s -- --token YOUR_TOKEN</p>
        </div>
      </div>

      <Modal
        isOpen={!!selectedDevice}
        onClose={() => setSelectedDevice(null)}
        title="Agent Details"
        size="md"
      >
        {selectedDevice && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Device</p>
                <p className="text-sm font-medium text-gray-900 dark:text-white">
                  {selectedDevice.display_name || selectedDevice.hostname}
                </p>
              </div>
              <div>
                <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Status</p>
                <StatusBadge status={selectedDevice.status} />
              </div>
              <div>
                <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Agent Version</p>
                <p className="text-sm font-mono text-gray-900 dark:text-white">{selectedDevice.agent_version || 'N/A'}</p>
              </div>
              <div>
                <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Last Heartbeat</p>
                <p className="text-sm text-gray-900 dark:text-white">{formatTimeAgo(selectedDevice.last_heartbeat)}</p>
              </div>
              <div>
                <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">OS</p>
                <p className="text-sm text-gray-900 dark:text-white">{selectedDevice.os_type} {selectedDevice.os_version || ''}</p>
              </div>
              <div>
                <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">IP Address</p>
                <p className="text-sm font-mono text-gray-900 dark:text-white">{selectedDevice.ip_address || 'N/A'}</p>
              </div>
            </div>
            <div className="flex justify-end pt-2">
              <button
                onClick={() => handleUpdateAgent(selectedDevice.id)}
                disabled={updating}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
              >
                <RefreshCw className={`w-4 h-4 ${updating ? 'animate-spin' : ''}`} />
                {updating ? 'Updating...' : 'Update Agent'}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
