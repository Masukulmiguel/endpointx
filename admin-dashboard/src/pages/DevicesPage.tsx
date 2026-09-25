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
  Smartphone,
  Tablet,
  Laptop,
  Server,
  MapPin,
  BatteryMedium,
  CheckCircle2,
  XCircle,
  User,
  Wifi,
} from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { useAuth } from '../contexts/AuthContext';
import api from '../services/api';
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

function getDeviceIcon(device: Device): React.ElementType {
  const type = (device.device_type || '').toUpperCase();
  if (type === 'MOBILE') return Smartphone;
  if (type === 'TABLET') return Tablet;
  if (type === 'SERVER') return Server;
  const os = (device.os_type || '').toLowerCase();
  if (os.includes('android') || os.includes('ios') || os.includes('ipad')) return Smartphone;
  if (type === 'LAPTOP' || os.includes('mac') || os.includes('darwin')) return Laptop;
  return Monitor;
}

function isMobileDevice(device: Device): boolean {
  if (device.agent_id?.startsWith('mobile-')) return true;
  const os = (device.os_type || '').toLowerCase();
  if (os === 'android' || os === 'ios' || os === 'ipados') return true;
  const type = (device.device_type || '').toUpperCase();
  return type === 'MOBILE' || type === 'TABLET';
}

function UsageBar({ label, value, icon: Icon }: { label: string; value: number | null; icon: React.ElementType }) {
  const hasValue = typeof value === 'number' && Number.isFinite(value);
  const pct = hasValue ? Math.min(100, Math.max(0, value)) : 0;
  let barColor = 'bg-emerald-500';
  if (!hasValue) barColor = 'bg-gray-300 dark:bg-gray-600';
  else if (pct > 80) barColor = 'bg-red-500';
  else if (pct > 60) barColor = 'bg-amber-500';

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="flex items-center gap-1 text-gray-500 dark:text-gray-400">
          <Icon className="w-3 h-3" />
          {label}
        </span>
        <span className="text-gray-700 dark:text-gray-300 font-medium">{hasValue ? `${pct}%` : '—'}</span>
      </div>
      <div className="w-full h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: hasValue ? `${pct}%` : '0%' }} />
      </div>
    </div>
  );
}

function DeviceCard({ device, onClick, onModerate }: { device: Device; onClick: () => void; onModerate: (device: Device, action: 'approve' | 'reject') => void }) {
  const { user } = useAuth();
  const hasTelemetry = device.cpu_usage != null || device.ram_usage != null || device.disk_usage != null;
  const mobile = isMobileDevice(device);
  const model = [device.manufacturer, device.model].filter(Boolean).join(' · ');
  const owner = device.owner_email || device.notes?.match(/owner=([^;]+)/)?.[1] || null;
  const pending = device.approval_status === 'pending';
  const canModerate = pending && (!device.created_by || device.created_by === user?.id);
  const Icon = getDeviceIcon(device);

  return (
    <button
      onClick={onClick}
      className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-5 text-left hover:border-blue-300 dark:hover:border-blue-600 hover:shadow-md transition-all w-full"
    >
      <div className="flex items-start justify-between gap-3 mb-4">
        <div className="flex items-start gap-3 min-w-0">
          <span
            className={`flex-shrink-0 w-10 h-10 rounded-lg flex items-center justify-center ${
              mobile
                ? 'bg-violet-50 dark:bg-violet-900/25 text-violet-600 dark:text-violet-400'
                : 'bg-blue-50 dark:bg-blue-900/25 text-blue-600 dark:text-blue-400'
            }`}
          >
            <Icon className="w-5 h-5" />
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white truncate">
              {device.display_name || device.hostname}
            </h3>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 truncate">
              {[device.os_type, device.os_version].filter(Boolean).join(' ')}
              {model ? ` · ${model}` : ''}
            </p>
          </div>
        </div>
        <StatusBadge status={device.status} />
      </div>

      {hasTelemetry ? (
        <div className="space-y-2.5 mb-4">
          <UsageBar label="CPU" value={device.cpu_usage} icon={Cpu} />
          <UsageBar label="RAM" value={device.ram_usage} icon={MemoryStick} />
          <UsageBar label="Disk" value={device.disk_usage} icon={HardDrive} />
        </div>
      ) : (
        <div className="mb-4 rounded-lg bg-gray-50 dark:bg-gray-900/60 border border-gray-100 dark:border-gray-700 p-3.5 space-y-2">
          <div className="flex items-center gap-1.5 text-xs font-medium text-gray-600 dark:text-gray-300">
            <Wifi className="w-3.5 h-3.5" />
            <span>{mobile ? 'Dispositivo móvel' : 'Sem telemetria'}</span>
            <span className="ml-auto font-normal text-gray-400 dark:text-gray-500">
              {mobile ? 'registo móvel' : 'sem dados'}
            </span>
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed">
            {mobile
              ? 'A presença é atualizada enquanto a página de registo estiver aberta.'
              : 'O agente ainda não enviou dados de heartbeat.'}
          </p>
          {model && <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{model}</p>}
          {(owner || device.battery_level != null) && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
              {owner && (
                <span className="inline-flex items-center gap-1 min-w-0">
                  <User className="w-3 h-3 flex-shrink-0" />
                  <span className="truncate">{owner}</span>
                </span>
              )}
              {device.battery_level != null && (
                <span className="inline-flex items-center gap-1">
                  <BatteryMedium className="w-3 h-3" />
                  {device.battery_level}%
                </span>
              )}
            </div>
          )}
        </div>
      )}

      {pending && (
        <div className="flex items-center gap-2 mb-3 px-3 py-2 rounded-lg bg-amber-50 dark:bg-amber-900/15 border border-amber-200 dark:border-amber-800/40">
          <ShieldCheck className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 flex-shrink-0" />
          <span className="text-xs font-medium text-amber-700 dark:text-amber-300">Aguarda aprovação</span>
          {canModerate && (
            <span className="ml-auto flex items-center gap-1.5">
              <span
                role="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onModerate(device, 'reject');
                }}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium text-red-600 dark:text-red-400 border border-red-200 dark:border-red-800 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors cursor-pointer"
              >
                <XCircle className="w-3.5 h-3.5" /> Rejeitar
              </span>
              <span
                role="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onModerate(device, 'approve');
                }}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium text-white bg-emerald-600 hover:bg-emerald-700 transition-colors cursor-pointer"
              >
                <CheckCircle2 className="w-3.5 h-3.5" /> Aprovar
              </span>
            </span>
          )}
        </div>
      )}

      <div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400 border-t border-gray-200 dark:border-gray-700 pt-3">
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
      {device.latitude != null && device.longitude != null && (
        <a
          href={`https://www.openstreetmap.org/?mlat=${device.latitude}&mlon=${device.longitude}#map=16/${device.latitude}/${device.longitude}`}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 hover:underline mt-2"
        >
          <MapPin className="w-3 h-3" />
          {device.latitude.toFixed(4)}, {device.longitude.toFixed(4)}
        </a>
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

  const { data, loading, error, refetch } = useApi<{ devices: Device[]; pagination: { page: number; limit: number; total: number; totalPages: number } }>('/devices', { params, refreshInterval: 30000 });
  const [actionError, setActionError] = useState<string | null>(null);

  const handleModerate = async (device: Device, action: 'approve' | 'reject') => {
    try {
      await api.request(`/netsentinel/devices/${device.id}/${action}`, { method: 'POST' });
      setActionError(null);
      refetch();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Action failed');
    }
  };

  const devices = Array.isArray(data?.devices) ? data.devices : [];
  const totalPages = data?.pagination?.totalPages || 1;
  const totalCount = data?.pagination?.total || 0;

  const tableColumns = [
    {
      key: 'hostname',
      label: 'Device',
      sortable: true,
      render: (row: Device) => {
        const Icon = getDeviceIcon(row);
        return (
          <div className="flex items-center gap-2">
            <Icon className="w-4 h-4 text-gray-400 dark:text-gray-500 flex-shrink-0" />
            <div>
              <p className="font-medium text-gray-900 dark:text-white">
                {row.display_name || row.hostname}
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400">{row.hostname}</p>
            </div>
          </div>
        );
      },
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
      key: 'owner_email',
      label: 'Account',
      render: (row: Device) => (
        <span className="text-gray-500 dark:text-gray-400 truncate max-w-[150px] block">
          {row.owner_email || '—'}
        </span>
      ),
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
            className="p-1.5 rounded-md text-gray-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors"
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
          className="px-3 py-2.5 text-sm bg-gray-100 dark:bg-gray-700 border border-transparent rounded-lg text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
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
          className="px-3 py-2.5 text-sm bg-gray-100 dark:bg-gray-700 border border-transparent rounded-lg text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
        >
          <option value="">All OS</option>
          <option value="windows">Windows</option>
          <option value="macos">macOS</option>
          <option value="linux">Linux</option>
          <option value="android">Android</option>
          <option value="ios">iOS</option>
        </select>
        <div className="flex items-center bg-gray-100 dark:bg-gray-700 rounded-lg p-0.5 ml-auto">
          <button
            onClick={() => setViewMode('grid')}
            className={`p-2 rounded-md transition-colors ${
              viewMode === 'grid'
                ? 'bg-white dark:bg-gray-600 text-blue-600 shadow-sm'
                : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
            }`}
          >
            <LayoutGrid className="w-4 h-4" />
          </button>
          <button
            onClick={() => setViewMode('list')}
            className={`p-2 rounded-md transition-colors ${
              viewMode === 'list'
                ? 'bg-white dark:bg-gray-600 text-blue-600 shadow-sm'
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
      {actionError && (
        <div className="px-4 py-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
          <p className="text-sm text-red-600 dark:text-red-400">{actionError}</p>
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
                    onModerate={handleModerate}
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
