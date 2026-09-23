import React, { useState, useMemo } from 'react';
import {
  Wifi,
  WifiOff,
  Activity,
  Globe,
  Monitor,
  Clock,
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
import { useApi } from '../hooks/useApi';
import StatusBadge from '../components/StatusBadge';
import LoadingSpinner from '../components/LoadingSpinner';
import type { Device, NetworkInterface, Heartbeat } from '../types';

interface NetworkStats {
  total_devices: number;
  online_devices: number;
  average_latency: number;
}

function formatBandwidth(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatSpeed(mbps: number | null): string {
  if (mbps === null) return 'N/A';
  if (mbps >= 1000) return `${(mbps / 1000).toFixed(1)} Gbps`;
  return `${mbps} Mbps`;
}

export default function NetworkPage() {
  const [deviceFilter, setDeviceFilter] = useState('');

  const { data: devicesData, loading: devicesLoading } = useApi<{ devices: Device[] }>('/devices', {
    params: { limit: '200' },
  });

  const { data: statsData, loading: statsLoading } = useApi<NetworkStats>('/network/stats');
  const { data: heartbeatData, loading: heartbeatLoading } = useApi<{ heartbeats: Heartbeat[] }>('/network/bandwidth', {
    params: deviceFilter ? { device_id: deviceFilter } : {},
  });
  const { data: interfacesData, loading: interfacesLoading } = useApi<{ interfaces: (NetworkInterface & { device_name?: string; device_id?: string })[] }>('/network/interfaces', {
    params: deviceFilter ? { device_id: deviceFilter } : {},
  });

  const devices = Array.isArray(devicesData?.devices) ? devicesData.devices : [];
  const stats = statsData;
  const heartbeats = Array.isArray(heartbeatData?.heartbeats) ? heartbeatData.heartbeats : [];
  const interfaces = Array.isArray(interfacesData?.interfaces) ? interfacesData.interfaces : [];

  const chartData = useMemo(() => {
    return heartbeats.map((h) => ({
      time: new Date(h.recorded_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      inbound: h.network_in,
      outbound: h.network_out,
    }));
  }, [heartbeats]);

  const onlineDevices = devices.filter((d) => d.status === 'online');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Network</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          Network overview and device connectivity
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {[
          { label: 'Total Devices', value: stats?.total_devices ?? devices.length, icon: Monitor, color: 'text-blue-600 dark:text-blue-400' },
          { label: 'Online', value: stats?.online_devices ?? onlineDevices.length, icon: Wifi, color: 'text-emerald-600 dark:text-emerald-400' },
          { label: 'Average Latency', value: `${stats?.average_latency ?? 0}ms`, icon: Activity, color: 'text-amber-600 dark:text-amber-400' },
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

      <div>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Connected Devices</h2>
        {devicesLoading ? (
          <LoadingSpinner size="md" />
        ) : onlineDevices.length === 0 ? (
          <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-8 text-center">
            <WifiOff className="w-10 h-10 text-gray-300 dark:text-gray-600 mx-auto mb-3" />
            <p className="text-gray-500 dark:text-gray-400">No online devices</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
            {onlineDevices.map((device) => (
              <div
                key={device.id}
                className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4 hover:border-blue-300 dark:hover:border-blue-600 transition-colors"
              >
                <div className="flex items-center gap-3 mb-2">
                  <div className="relative">
                    <Monitor className="w-5 h-5 text-gray-400 dark:text-gray-500" />
                    <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 bg-emerald-500 rounded-full border-2 border-white dark:border-gray-800" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900 dark:text-white truncate">
                      {device.display_name || device.hostname}
                    </p>
                    <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{device.ip_address || 'N/A'}</p>
                  </div>
                </div>
                <div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
                  <StatusBadge status="online" />
                  <span>{device.os_type}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Bandwidth</h2>
          <select
            value={deviceFilter}
            onChange={(e) => setDeviceFilter(e.target.value)}
            className="px-3 py-2 text-sm bg-gray-100 dark:bg-gray-700 border border-transparent rounded-lg text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
          >
            <option value="">All Devices</option>
            {devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.display_name || d.hostname}
              </option>
            ))}
          </select>
        </div>
        {heartbeatLoading ? (
          <LoadingSpinner size="md" />
        ) : chartData.length === 0 ? (
          <div className="h-64 flex items-center justify-center text-gray-500 dark:text-gray-400 text-sm">
            No bandwidth data available
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
              <XAxis dataKey="time" stroke="#9ca3af" fontSize={12} />
              <YAxis stroke="#9ca3af" fontSize={12} tickFormatter={(v) => formatBandwidth(v)} />
              <Tooltip
                contentStyle={{
                  backgroundColor: '#1f2937',
                  border: '1px solid #374151',
                  borderRadius: '8px',
                  color: '#f3f4f6',
                }}
                formatter={(value: number) => formatBandwidth(value)}
              />
              <Line type="monotone" dataKey="inbound" stroke="#10b981" strokeWidth={2} dot={false} name="Inbound" />
              <Line type="monotone" dataKey="outbound" stroke="#0080ff" strokeWidth={2} dot={false} name="Outbound" />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700">
        <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Network Interfaces</h2>
        </div>
        {interfacesLoading ? (
          <div className="p-6">
            <LoadingSpinner size="md" />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 dark:border-gray-700">
                  <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">
                    Device
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">
                    Interface
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">
                    IPv4
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">
                    MAC
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">
                    Speed
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                {interfaces.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-6 py-8 text-center text-gray-500 dark:text-gray-400">
                      No network interfaces found
                    </td>
                  </tr>
                ) : (
                  interfaces.map((iface) => (
                    <tr key={iface.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
                      <td className="px-6 py-3 text-gray-900 dark:text-white font-medium">
                        {iface.device_name || 'Unknown'}
                      </td>
                      <td className="px-6 py-3 text-gray-700 dark:text-gray-300">{iface.name}</td>
                      <td className="px-6 py-3 font-mono text-xs text-gray-700 dark:text-gray-300">
                        {iface.ipv4_address || 'N/A'}
                      </td>
                      <td className="px-6 py-3 font-mono text-xs text-gray-500 dark:text-gray-400">
                        {iface.mac_address || 'N/A'}
                      </td>
                      <td className="px-6 py-3 text-gray-700 dark:text-gray-300">
                        {formatSpeed(iface.speed_mbps)}
                      </td>
                      <td className="px-6 py-3">
                        <StatusBadge status={iface.is_connected ? 'online' : 'offline'} />
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
