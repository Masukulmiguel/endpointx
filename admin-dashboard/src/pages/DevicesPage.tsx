import React, { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Monitor,
  LayoutGrid,
  List,
  Eye,
  ShieldOff,
  ShieldCheck,
  Cpu,
  HardDrive,
  MemoryStick,
  Globe,
  Clock,
} from 'lucide-react';
import { useApi } from '../hooks/useApi';
import SearchInput from '../components/SearchInput';
import StatusBadge from '../components/StatusBadge';
import Pagination from '../components/Pagination';
import DataTable from '../components/DataTable';
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

function getOsIcon(osType: string) {
  const lower = osType?.toLowerCase() || '';
  if (lower.includes('windows')) return '🪟';
  if (lower.includes('mac') || lower.includes('darwin')) return '🍎';
  if (lower.includes('linux')) return '🐧';
  return '💻';
}

function UsageBar({ label, value, icon: Icon }: { label: string; value: number | null; icon: React.ElementType }) {
  const pct = Math.min(100, Math.max(0, value || 0));
  let barColor = 'bg-emerald-500';
  if (pct > 80) barColor = 'bg-red-500';
  else if (pct > 60) barColor = 'bg-amber-500';

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="flex items-center gap-1 text-gray-500 dark:text-gray-400">
          <Icon className="w-3 h-3" />
          {label}
        </span>
        <span className="text-gray-700 dark:text-gray-300 font-medium">{pct}%</span>
      </div>
      <div className="w-full h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function DeviceCard({ device, onClick }: { device: Device; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-5 text-left hover:border-indigo-300 dark:hover:border-indigo-600 hover:shadow-md transition-all w-full"
    >
      <div className="flex items-start justify-between mb-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-lg">{getOsIcon(device.os_type)}</span>
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white truncate">
              {device.display_name || device.hostname}
            </h3>
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 truncate">
            {device.hostname}
          </p>
        </div>
        <StatusBadge status={device.status} />
      </div>

      <div className="space-y-2.5 mb-4">
        <UsageBar label="CPU" value={device.cpu_usage} icon={Cpu} />
        <UsageBar label="RAM" value={device.ram_usage} icon={MemoryStick} />
        <UsageBar label="Disk" value={device.disk_usage} icon={HardDrive} />
      </div>

      <div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400 border-t border-gray-100 dark:border-gray-700 pt-3">
        <span className="flex items-center gap-1">
          <Globe className="w-3 h-3" />
          {device.ip_address || 'N/A'}
        </span>
        <span className="flex items-center gap-1">
          <Clock className="w-3 h-3" />
          {formatTimeAgo(device.last_heartbeat)}
        </span>
      </div>

      {device.user_name && (
        <p className="text-xs text-gray-400 dark:text-gray-500 mt-2 truncate">
          User: {device.user_name}
        </p>
      )}
    </button>
  );
}

function SkeletonCard() {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-5 animate-pulse">
      <div className="flex items-start justify-between mb-3">
        <div>
          <div className="flex items-center gap-2">
            <div className="w-5 h-5 rounded bg-gray-200 dark:bg-gray-700" />
            <div className="w-28 h-4 rounded bg-gray-200 dark:bg-gray-700" />
          </div>
          <div className="w-20 h-3 rounded bg-gray-200 dark:bg-gray-700 mt-1" />
        </div>
        <div className="w-16 h-5 rounded-full bg-gray-200 dark:bg-gray-700" />
      </div>
      <div className="space-y-2.5 mb-4">
        <div className="w-full h-1.5 rounded-full bg-gray-200 dark:bg-gray-700" />
        <div className="w-full h-1.5 rounded-full bg-gray-200 dark:bg-gray-700" />
        <div className="w-full h-1.5 rounded-full bg-gray-200 dark:bg-gray-700" />
      </div>
      <div className="flex items-center justify-between pt-3 border-t border-gray-100 dark:border-gray-700">
        <div className="w-20 h-3 rounded bg-gray-200 dark:bg-gray-700" />
        <div className="w-16 h-3 rounded bg-gray-200 dark:bg-gray-700" />
      </div>
    </div>
  );
}

export default function DevicesPage() {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [osFilter, setOsFilter] = useState('');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [page, setPage] = useState(1);
  const navigate = useNavigate();

  const params = useMemo(() => {
    const p: Record<string, string> = { page: String(page), limit: '12' };
    if (search) p.search = search;
    if (statusFilter) p.status = statusFilter;
    if (osFilter) p.os_type = osFilter;
    return p;
  }, [page, search, statusFilter, osFilter]);

  const { data, loading, error } = useApi<{ devices: Device[]; pagination: { page: number; limit: number; total: number; totalPages: number } }>('/devices', { params });

  const devices = Array.isArray(data?.devices) ? data.devices : [];
  const totalPages = data?.pagination?.totalPages || 1;
  const totalCount = data?.pagination?.total || 0;

  const tableColumns = [
    {
      key: 'hostname',
      label: 'Device',
      sortable: true,
      render: (row: Device) => (
        <div className="flex items-center gap-2">
          <span className="text-base">{getOsIcon(row.os_type)}</span>
          <div>
            <p className="font-medium text-gray-900 dark:text-white">
              {row.display_name || row.hostname}
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400">{row.hostname}</p>
          </div>
        </div>
      ),
    },
    {
      key: 'os_type',
      label: 'OS',
      sortable: true,
      render: (row: Device) => (
        <span className="text-gray-700 dark:text-gray-300">
          {row.os_type} {row.os_version || ''}
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
      key: 'cpu_usage',
      label: 'CPU',
      sortable: true,
      render: (row: Device) => (
        <span className="text-gray-700 dark:text-gray-300">{row.cpu_usage ?? 'N/A'}%</span>
      ),
    },
    {
      key: 'ram_usage',
      label: 'RAM',
      sortable: true,
      render: (row: Device) => (
        <span className="text-gray-700 dark:text-gray-300">{row.ram_usage ?? 'N/A'}%</span>
      ),
    },
    {
      key: 'ip_address',
      label: 'IP Address',
      render: (row: Device) => (
        <span className="text-gray-700 dark:text-gray-300">{row.ip_address || 'N/A'}</span>
      ),
    },
    {
      key: 'last_heartbeat',
      label: 'Last Heartbeat',
      sortable: true,
      render: (row: Device) => (
        <span className="text-gray-500 dark:text-gray-400">{formatTimeAgo(row.last_heartbeat)}</span>
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
              navigate(`/devices/${row.id}`);
            }}
            className="p-1.5 rounded-md text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 transition-colors"
            title="View Details"
          >
            <Eye className="w-4 h-4" />
          </button>
          {row.status === 'blocked' ? (
            <button
              onClick={(e) => e.stopPropagation()}
              className="p-1.5 rounded-md text-gray-400 hover:text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 transition-colors"
              title="Unblock"
            >
              <ShieldCheck className="w-4 h-4" />
            </button>
          ) : (
            <button
              onClick={(e) => e.stopPropagation()}
              className="p-1.5 rounded-md text-gray-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
              title="Block"
            >
              <ShieldOff className="w-4 h-4" />
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
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Devices</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            {totalCount} device{totalCount !== 1 ? 's' : ''} total
          </p>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
        <SearchInput
          value={search}
          onChange={(val) => {
            setSearch(val);
            setPage(1);
          }}
          placeholder="Search devices..."
          className="w-full sm:w-72"
        />
        <select
          value={statusFilter}
          onChange={(e) => {
            setStatusFilter(e.target.value);
            setPage(1);
          }}
          className="px-3 py-2.5 text-sm bg-gray-100 dark:bg-gray-700 border border-transparent rounded-lg text-gray-900 dark:text-white focus:ring-2 focus:ring-indigo-500 outline-none"
        >
          <option value="">All Status</option>
          <option value="online">Online</option>
          <option value="offline">Offline</option>
          <option value="alert">Alert</option>
          <option value="blocked">Blocked</option>
          <option value="quarantine">Quarantine</option>
        </select>
        <select
          value={osFilter}
          onChange={(e) => {
            setOsFilter(e.target.value);
            setPage(1);
          }}
          className="px-3 py-2.5 text-sm bg-gray-100 dark:bg-gray-700 border border-transparent rounded-lg text-gray-900 dark:text-white focus:ring-2 focus:ring-indigo-500 outline-none"
        >
          <option value="">All OS</option>
          <option value="windows">Windows</option>
          <option value="macos">macOS</option>
          <option value="linux">Linux</option>
        </select>
        <div className="flex items-center bg-gray-100 dark:bg-gray-700 rounded-lg p-0.5 ml-auto">
          <button
            onClick={() => setViewMode('grid')}
            className={`p-2 rounded-md transition-colors ${
              viewMode === 'grid'
                ? 'bg-white dark:bg-gray-600 text-indigo-600 shadow-sm'
                : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
            }`}
          >
            <LayoutGrid className="w-4 h-4" />
          </button>
          <button
            onClick={() => setViewMode('list')}
            className={`p-2 rounded-md transition-colors ${
              viewMode === 'list'
                ? 'bg-white dark:bg-gray-600 text-indigo-600 shadow-sm'
                : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
            }`}
          >
            <List className="w-4 h-4" />
          </button>
        </div>
      </div>

      {error && (
        <div className="px-4 py-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        </div>
      )}

      {viewMode === 'grid' ? (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {loading && devices.length === 0
              ? Array.from({ length: 8 }).map((_, i) => <SkeletonCard key={i} />)
              : devices.map((device) => (
                  <DeviceCard
                    key={device.id}
                    device={device}
                    onClick={() => navigate(`/devices/${device.id}`)}
                  />
                ))}
          </div>
          {devices.length === 0 && !loading && (
            <div className="text-center py-12">
              <Monitor className="w-12 h-12 text-gray-300 dark:text-gray-600 mx-auto mb-3" />
              <p className="text-gray-500 dark:text-gray-400">No devices found</p>
            </div>
          )}
        </>
      ) : (
        <DataTable
          columns={tableColumns}
          data={devices}
          loading={loading}
          emptyMessage="No devices found"
          onRowClick={(row) => navigate(`/devices/${row.id}`)}
        />
      )}

      <Pagination currentPage={page} totalPages={totalPages} onPageChange={setPage} />
    </div>
  );
}
