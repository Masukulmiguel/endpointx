import React, { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Monitor,
  Globe,
  HardDrive,
  MemoryStick,
  Cpu,
  Clock,
  ShieldCheck,
  ShieldOff,
  Trash2,
  AlertTriangle,
  Send,
  RefreshCw,
  Power,
  Lock,
  Unlock,
  Package,
  RotateCcw,
  Bug,
  FileSearch,
  Server,
  Wifi,
  Activity,
  User,
  Hash,
  Info,
} from 'lucide-react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { useApi, useApiMutation } from '../hooks/useApi';
import StatusBadge from '../components/StatusBadge';
import LoadingSpinner from '../components/LoadingSpinner';
import DataTable from '../components/DataTable';
import Modal from '../components/Modal';
import type { DeviceDetail, Command } from '../types';

type Tab = 'overview' | 'software' | 'services' | 'processes' | 'network' | 'security' | 'commands';

const tabs: { key: Tab; label: string; icon: React.ElementType }[] = [
  { key: 'overview', label: 'Overview', icon: Info },
  { key: 'software', label: 'Software', icon: Package },
  { key: 'services', label: 'Services', icon: Server },
  { key: 'processes', label: 'Processes', icon: Activity },
  { key: 'network', label: 'Network', icon: Wifi },
  { key: 'security', label: 'Security', icon: ShieldCheck },
  { key: 'commands', label: 'Commands', icon: Terminal },
];

function Terminal(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" x2="20" y1="19" y2="19" />
    </svg>
  );
}

function CircularGauge({ label, value, icon: Icon }: { label: string; value: number | null; icon: React.ElementType }) {
  const pct = Math.min(100, Math.max(0, value || 0));
  const radius = 40;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (pct / 100) * circumference;

  let strokeColor = '#10b981';
  if (pct > 80) strokeColor = '#ef4444';
  else if (pct > 60) strokeColor = '#f59e0b';

  return (
    <div className="flex flex-col items-center">
      <div className="relative w-24 h-24">
        <svg className="w-24 h-24 -rotate-90" viewBox="0 0 100 100">
          <circle cx="50" cy="50" r={radius} fill="none" stroke="#e5e7eb" strokeWidth="8" className="dark:stroke-gray-700" />
          <circle
            cx="50"
            cy="50"
            r={radius}
            fill="none"
            stroke={strokeColor}
            strokeWidth="8"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            className="transition-all duration-700"
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <Icon className="w-4 h-4 text-gray-400 dark:text-gray-500 mb-0.5" />
          <span className="text-lg font-bold text-gray-900 dark:text-white">{pct}%</span>
        </div>
      </div>
      <span className="mt-2 text-xs font-medium text-gray-500 dark:text-gray-400">{label}</span>
    </div>
  );
}

const COMMAND_TYPES = [
  { value: 'reboot', label: 'Reboot', icon: RefreshCw, color: 'text-amber-600' },
  { value: 'shutdown', label: 'Shutdown', icon: Power, color: 'text-red-600' },
  { value: 'lock', label: 'Lock Screen', icon: Lock, color: 'text-blue-600' },
  { value: 'unlock', label: 'Unlock Screen', icon: Unlock, color: 'text-emerald-600' },
  { value: 'inventory', label: 'Run Inventory', icon: FileSearch, color: 'text-indigo-600' },
  { value: 'update_agent', label: 'Update Agent', icon: Package, color: 'text-purple-600' },
  { value: 'quarantine', label: 'Quarantine', icon: AlertTriangle, color: 'text-orange-600' },
  { value: 'scan', label: 'Security Scan', icon: Bug, color: 'text-teal-600' },
];

const COMMAND_STATUS_COLORS: Record<string, string> = {
  pending: 'text-gray-500 bg-gray-100 dark:bg-gray-700 dark:text-gray-400',
  sent: 'text-blue-600 bg-blue-100 dark:bg-blue-900/30 dark:text-blue-400',
  executing: 'text-amber-600 bg-amber-100 dark:bg-amber-900/30 dark:text-amber-400',
  completed: 'text-emerald-600 bg-emerald-100 dark:bg-emerald-900/30 dark:text-emerald-400',
  failed: 'text-red-600 bg-red-100 dark:bg-red-900/30 dark:text-red-400',
  timeout: 'text-orange-600 bg-orange-100 dark:bg-orange-900/30 dark:text-orange-400',
};

export default function DeviceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<Tab>('overview');
  const [commandModalOpen, setCommandModalOpen] = useState(false);
  const [selectedCommand, setSelectedCommand] = useState('');
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const showToast = (type: 'success' | 'error', message: string) => {
    setToast({ type, message });
    setTimeout(() => setToast(null), 3000);
  };

  const { data: deviceData, loading, error, refetch } = useApi<{ device: DeviceDetail }>(`/devices/${id}`);
  const blockMutation = useApiMutation(`/devices/${id}/block`, 'POST');
  const unblockMutation = useApiMutation(`/devices/${id}/unblock`, 'POST');
  const quarantineMutation = useApiMutation(`/devices/${id}/quarantine`, 'POST');
  const deleteMutation = useApiMutation(`/devices/${id}`, 'DELETE');
  const commandMutation = useApiMutation('/commands', 'POST');

  const device = deviceData?.device;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (error || !device) {
    return (
      <div className="text-center py-12">
        <p className="text-red-500 dark:text-red-400 text-sm">{error || 'Device not found'}</p>
        <button onClick={() => navigate('/devices')} className="mt-3 text-sm text-indigo-600 hover:text-indigo-500">
          Back to Devices
        </button>
      </div>
    );
  }

  const handleSendCommand = async (cmdType?: string) => {
    const type = cmdType || selectedCommand;
    if (!type || !id) return;
    const cmd = COMMAND_TYPES.find(c => c.value === type);
    const label = cmd?.label || type;
    if (!window.confirm(`Send "${label}" command to ${device.hostname}?`)) return;
    try {
      await commandMutation.mutate({ device_id: id, command_type: type });
      setCommandModalOpen(false);
      setSelectedCommand('');
      showToast('success', `Command "${label}" sent! Agent will execute on next heartbeat.`);
      setActiveTab('commands');
      refetch();
    } catch (err) {
      showToast('error', 'Failed to send command');
    }
  };

  const handleBlock = async () => {
    if (window.confirm('Block this device? The agent will be blocked.')) {
      const result = await blockMutation.mutate();
      if (result) {
        showToast('success', 'Device blocked successfully');
      } else {
        showToast('error', 'Failed to block device');
      }
      refetch();
    }
  };

  const handleUnblock = async () => {
    const result = await unblockMutation.mutate();
    if (result) {
      showToast('success', 'Device unblocked successfully');
    } else {
      showToast('error', 'Failed to unblock device');
    }
    refetch();
  };

  const handleQuarantine = async () => {
    if (window.confirm('Quarantine this device?')) {
      const result = await quarantineMutation.mutate();
      if (result) {
        showToast('success', 'Device quarantined successfully');
      } else {
        showToast('error', 'Failed to quarantine device');
      }
      refetch();
    }
  };

  const handleRemove = async () => {
    if (window.confirm('Are you sure you want to remove this device? This cannot be undone.')) {
      const result = await deleteMutation.mutate();
      if (result) {
        showToast('success', 'Device removed successfully');
        setTimeout(() => navigate('/devices'), 1000);
      } else {
        showToast('error', 'Failed to remove device');
      }
    }
  };

  const commandColumns = [
    {
      key: 'command_type',
      label: 'Command',
      render: (row: Command) => (
        <span className="font-medium text-gray-900 dark:text-white capitalize">
          {row.command_type.replace('_', ' ')}
        </span>
      ),
    },
    {
      key: 'status',
      label: 'Status',
      render: (row: Command) => (
        <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${COMMAND_STATUS_COLORS[row.status] || ''}`}>
          {row.status}
        </span>
      ),
    },
    { key: 'issued_by_name', label: 'Issued By', render: (row: Command) => <span className="text-gray-700 dark:text-gray-300">{row.issued_by_name || row.issued_by}</span> },
    { key: 'created_at', label: 'Time', render: (row: Command) => <span className="text-gray-500 dark:text-gray-400">{new Date(row.created_at).toLocaleString()}</span> },
    { key: 'result', label: 'Result', render: (row: Command) => <span className="text-gray-500 dark:text-gray-400 truncate max-w-[200px] block">{row.result || row.error_message || '-'}</span> },
  ];

  return (
    <div className="space-y-6">
      {toast && (
        <div className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-lg shadow-lg transition-all ${
          toast.type === 'success' 
            ? 'bg-emerald-500 text-white' 
            : 'bg-red-500 text-white'
        }`}>
          <p className="text-sm font-medium">{toast.message}</p>
        </div>
      )}

      <button
        onClick={() => navigate('/devices')}
        className="flex items-center gap-2 text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 transition-colors"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to Devices
      </button>

      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
          <div className="flex items-start gap-4">
            <div className="flex items-center justify-center w-12 h-12 bg-indigo-100 dark:bg-indigo-900/30 rounded-xl">
              <Monitor className="w-6 h-6 text-indigo-600 dark:text-indigo-400" />
            </div>
            <div>
              <div className="flex items-center gap-3">
                <h1 className="text-xl font-bold text-gray-900 dark:text-white">
                  {device.display_name || device.hostname}
                </h1>
                <StatusBadge status={device.status} />
              </div>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{device.hostname}</p>
              <div className="flex flex-wrap items-center gap-4 mt-2 text-sm text-gray-500 dark:text-gray-400">
                <span className="flex items-center gap-1">
                  <Globe className="w-3.5 h-3.5" />
                  {device.ip_address || 'N/A'}
                </span>
                <span className="flex items-center gap-1">
                  <Wifi className="w-3.5 h-3.5" />
                  {device.mac_address || 'N/A'}
                </span>
                <span className="flex items-center gap-1">
                  <Info className="w-3.5 h-3.5" />
                  {device.os_type} {device.os_version || ''}
                </span>
                {device.user_name && (
                  <span className="flex items-center gap-1">
                    <User className="w-3.5 h-3.5" />
                    {device.user_name}
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {device.status === 'blocked' ? (
              <button
                onClick={handleUnblock}
                disabled={unblockMutation.loading}
                className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-emerald-700 bg-emerald-50 dark:bg-emerald-900/20 dark:text-emerald-400 rounded-lg hover:bg-emerald-100 dark:hover:bg-emerald-900/30 transition-colors disabled:opacity-50"
              >
                <ShieldCheck className="w-4 h-4" />
                Unblock
              </button>
            ) : (
              <button
                onClick={handleBlock}
                disabled={blockMutation.loading}
                className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-red-700 bg-red-50 dark:bg-red-900/20 dark:text-red-400 rounded-lg hover:bg-red-100 dark:hover:bg-red-900/30 transition-colors disabled:opacity-50"
              >
                <ShieldOff className="w-4 h-4" />
                Block
              </button>
            )}
            <button
              onClick={handleQuarantine}
              disabled={quarantineMutation.loading}
              className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-orange-700 bg-orange-50 dark:bg-orange-900/20 dark:text-orange-400 rounded-lg hover:bg-orange-100 dark:hover:bg-orange-900/30 transition-colors disabled:opacity-50"
            >
              <AlertTriangle className="w-4 h-4" />
              Quarantine
            </button>
            <button
              onClick={handleRemove}
              disabled={deleteMutation.loading}
              className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-red-700 bg-red-50 dark:bg-red-900/20 dark:text-red-400 rounded-lg hover:bg-red-100 dark:hover:bg-red-900/30 transition-colors disabled:opacity-50"
            >
              <Trash2 className="w-4 h-4" />
              Remove
            </button>
          </div>
        </div>
      </div>

      <div className="border-b border-gray-200 dark:border-gray-700">
        <nav className="flex gap-1 overflow-x-auto -mb-px">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                  activeTab === tab.key
                    ? 'border-indigo-500 text-indigo-600 dark:text-indigo-400'
                    : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300 hover:border-gray-300'
                }`}
              >
                <Icon className="w-4 h-4" />
                {tab.label}
              </button>
            );
          })}
        </nav>
      </div>

      {activeTab === 'overview' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-4">Device Info</h3>
              <dl className="space-y-3">
                {[
                  ['Agent ID', device.agent_id],
                  ['Agent Version', device.agent_version || 'N/A'],
                  ['OS', `${device.os_type} ${device.os_version || ''} ${device.os_build || ''}`.trim()],
                  ['CPU', device.cpu_model || 'N/A', device.cpu_cores ? `${device.cpu_cores} cores` : undefined],
                  ['RAM', device.ram_total ? `${(device.ram_total / 1073741824).toFixed(1)} GB` : 'N/A'],
                  ['Disk', device.disk_total ? `${(device.disk_total / 1073741824).toFixed(1)} GB` : 'N/A'],
                  ['IP Address', device.ip_address || 'N/A'],
                  ['MAC Address', device.mac_address || 'N/A'],
                  ['Registered', new Date(device.registered_at).toLocaleDateString()],
                  ['Last Heartbeat', device.last_heartbeat ? new Date(device.last_heartbeat).toLocaleString() : 'Never'],
                ].map(([label, value, sub]) => (
                  <div key={label as string} className="flex items-start justify-between">
                    <dt className="text-sm text-gray-500 dark:text-gray-400">{label}</dt>
                    <dd className="text-sm text-gray-900 dark:text-white text-right">
                      {value as string}
                      {sub && <span className="text-gray-400 dark:text-gray-500 ml-1">({sub})</span>}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>

            <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-6">Resource Usage</h3>
              <div className="flex items-center justify-around">
                <CircularGauge label="CPU" value={device.cpu_usage} icon={Cpu} />
                <CircularGauge label="RAM" value={device.ram_usage} icon={MemoryStick} />
                <CircularGauge label="Disk" value={device.disk_usage} icon={HardDrive} />
              </div>
            </div>
          </div>

          <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-4">Heartbeat Trend (Last 24h)</h3>
            <ResponsiveContainer width="100%" height={280}>
              <LineChart data={device.recent_heartbeats || []}>
                <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                <XAxis
                  dataKey="recorded_at"
                  stroke="#9ca3af"
                  fontSize={12}
                  tickFormatter={(val) => new Date(val).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                />
                <YAxis stroke="#9ca3af" fontSize={12} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#1f2937',
                    border: '1px solid #374151',
                    borderRadius: '8px',
                    color: '#f3f4f6',
                  }}
                  labelFormatter={(val) => new Date(val).toLocaleString()}
                />
                <Line type="monotone" dataKey="cpu_usage" stroke="#6366f1" strokeWidth={2} dot={false} name="CPU %" />
                <Line type="monotone" dataKey="ram_usage" stroke="#10b981" strokeWidth={2} dot={false} name="RAM %" />
                <Line type="monotone" dataKey="disk_usage" stroke="#f59e0b" strokeWidth={2} dot={false} name="Disk %" />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {activeTab === 'software' && (
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700">
          <DataTable
            columns={[
              { key: 'name', label: 'Name', sortable: true },
              { key: 'version', label: 'Version', sortable: true, render: (row) => row.version || '-' },
              { key: 'publisher', label: 'Publisher', sortable: true, render: (row) => row.publisher || '-' },
              { key: 'install_date', label: 'Install Date', sortable: true, render: (row) => row.install_date ? new Date(row.install_date).toLocaleDateString() : '-' },
            ]}
            data={device.software || []}
            emptyMessage="No software data available"
          />
        </div>
      )}

      {activeTab === 'services' && (
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700">
          <DataTable
            columns={[
              { key: 'name', label: 'Name', sortable: true, render: (row) => row.display_name || row.name },
              {
                key: 'status',
                label: 'Status',
                sortable: true,
                render: (row) => (
                  <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${
                    row.status === 'running'
                      ? 'text-emerald-600 bg-emerald-100 dark:bg-emerald-900/30 dark:text-emerald-400'
                      : 'text-gray-600 bg-gray-100 dark:bg-gray-700 dark:text-gray-400'
                  }`}>
                    {row.status || 'Unknown'}
                  </span>
                ),
              },
              { key: 'startup_type', label: 'Startup Type', sortable: true, render: (row) => row.startup_type || '-' },
            ]}
            data={device.services || []}
            emptyMessage="No services data available"
          />
        </div>
      )}

      {activeTab === 'processes' && (
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700">
          <DataTable
            columns={[
              { key: 'pid', label: 'PID', sortable: true },
              { key: 'name', label: 'Name', sortable: true, render: (row) => row.name || '-' },
              { key: 'cpu_usage', label: 'CPU %', sortable: true, render: (row) => `${(row.cpu_usage || 0).toFixed(1)}%` },
              { key: 'memory_usage', label: 'Memory', sortable: true, render: (row) => row.memory_usage ? `${(row.memory_usage / 1048576).toFixed(1)} MB` : '-' },
              { key: 'user_name', label: 'User', sortable: true, render: (row) => row.user_name || '-' },
            ]}
            data={device.processes || []}
            emptyMessage="No process data available"
          />
        </div>
      )}

      {activeTab === 'network' && (
        <div className="space-y-4">
          {(device.network_interfaces || []).length === 0 ? (
            <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-8 text-center text-gray-500 dark:text-gray-400">
              No network interface data available
            </div>
          ) : (
            (device.network_interfaces || []).map((iface) => (
              <div key={iface.id} className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-5">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <Wifi className="w-5 h-5 text-gray-400" />
                    <h4 className="text-sm font-semibold text-gray-900 dark:text-white">{iface.name}</h4>
                  </div>
                  <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium ${
                    iface.is_connected
                      ? 'text-emerald-600 bg-emerald-100 dark:bg-emerald-900/30 dark:text-emerald-400'
                      : 'text-gray-600 bg-gray-100 dark:bg-gray-700 dark:text-gray-400'
                  }`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${iface.is_connected ? 'bg-emerald-500' : 'bg-gray-400'}`} />
                    {iface.is_connected ? 'Connected' : 'Disconnected'}
                  </span>
                </div>
                <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                  <div>
                    <dt className="text-gray-500 dark:text-gray-400">IPv4</dt>
                    <dd className="text-gray-900 dark:text-white font-medium">{iface.ipv4_address || 'N/A'}</dd>
                  </div>
                  <div>
                    <dt className="text-gray-500 dark:text-gray-400">IPv6</dt>
                    <dd className="text-gray-900 dark:text-white font-medium truncate">{iface.ipv6_address || 'N/A'}</dd>
                  </div>
                  <div>
                    <dt className="text-gray-500 dark:text-gray-400">MAC</dt>
                    <dd className="text-gray-900 dark:text-white font-medium">{iface.mac_address || 'N/A'}</dd>
                  </div>
                  <div>
                    <dt className="text-gray-500 dark:text-gray-400">Speed</dt>
                    <dd className="text-gray-900 dark:text-white font-medium">{iface.speed_mbps ? `${iface.speed_mbps} Mbps` : 'N/A'}</dd>
                  </div>
                </dl>
              </div>
            ))
          )}
        </div>
      )}

      {activeTab === 'security' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-5">
              <div className="flex items-center gap-3">
                <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-emerald-100 dark:bg-emerald-900/30">
                  <ShieldCheck className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
                </div>
                <div>
                  <p className="text-sm font-medium text-gray-900 dark:text-white">Firewall</p>
                  <p className="text-xs text-emerald-600 dark:text-emerald-400">Active</p>
                </div>
              </div>
            </div>
            <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-5">
              <div className="flex items-center gap-3">
                <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-emerald-100 dark:bg-emerald-900/30">
                  <ShieldCheck className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
                </div>
                <div>
                  <p className="text-sm font-medium text-gray-900 dark:text-white">Antivirus</p>
                  <p className="text-xs text-emerald-600 dark:text-emerald-400">Running</p>
                </div>
              </div>
            </div>
          </div>

          <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700">
            <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Security Events</h3>
            </div>
            <div className="divide-y divide-gray-200 dark:divide-gray-700 max-h-96 overflow-y-auto">
              {(device.recent_events || []).length === 0 ? (
                <div className="px-6 py-8 text-center text-sm text-gray-500 dark:text-gray-400">
                  No security events
                </div>
              ) : (
                (device.recent_events || []).map((event) => (
                  <div key={event.id} className="px-6 py-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-gray-900 dark:text-white">{event.title}</p>
                        {event.description && (
                          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{event.description}</p>
                        )}
                        <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
                          {event.source && `${event.source} · `}{new Date(event.created_at).toLocaleString()}
                        </p>
                      </div>
                      <StatusBadge status={event.severity} />
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {activeTab === 'commands' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Command History</h3>
            <button
              onClick={() => setCommandModalOpen(true)}
              className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors"
            >
              <Send className="w-4 h-4" />
              Send Command
            </button>
          </div>
          <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700">
            <DataTable
              columns={commandColumns}
              data={device.recent_commands || []}
              emptyMessage="No command history"
            />
          </div>
        </div>
      )}

      <Modal isOpen={commandModalOpen} onClose={() => setCommandModalOpen(false)} title="Send Command" size="lg">
        <div className="space-y-4">
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Select a command to send to <span className="font-medium text-gray-900 dark:text-white">{device.hostname}</span>
          </p>
          <div className="grid grid-cols-2 gap-3">
            {COMMAND_TYPES.map((cmd) => {
              const Icon = cmd.icon;
              return (
                <button
                  key={cmd.value}
                  onClick={() => handleSendCommand(cmd.value)}
                  disabled={commandMutation.loading}
                  className="flex items-center gap-3 p-3 rounded-lg border text-left transition-all border-gray-200 dark:border-gray-700 hover:border-indigo-300 dark:hover:border-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-900/10 disabled:opacity-50"
                >
                  <Icon className={`w-5 h-5 ${cmd.color}`} />
                  <span className="text-sm font-medium text-gray-900 dark:text-white">{cmd.label}</span>
                </button>
              );
            })}
          </div>
          <div className="flex justify-end pt-2">
            <button
              onClick={() => {
                setCommandModalOpen(false);
                setSelectedCommand('');
              }}
              className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
