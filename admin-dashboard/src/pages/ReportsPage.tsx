import React, { useState } from 'react';
import {
  ChartBar,
  Monitor,
  Bell,
  ShieldCheck,
  Download,
  FileText,
  FileSpreadsheet,
} from 'lucide-react';
import { useApi } from '../hooks/useApi';
import AlertBanner from '../components/AlertBanner';
import LoadingSpinner from '../components/LoadingSpinner';

interface ReportSummary {
  total_devices: number;
  online_devices: number;
  offline_devices: number;
  total_alerts: number;
  compliance_rate: number;
  devices_by_os: { os: string; count: number }[];
  devices_by_status: { status: string; count: number }[];
  alerts_by_severity: { severity: string; count: number }[];
}

export default function ReportsPage() {
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const { data: summary, loading, error } = useApi<ReportSummary>('/reports/summary');

  const handleDownload = async (type: string, format: string) => {
    try {
      const response = await fetch(`/api/reports/${type}?format=${format}`, {
        headers: { Authorization: `Bearer ${localStorage.getItem('access_token')}` },
      });
      if (!response.ok) throw new Error('Download failed');
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${type}.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      setToast({ type: 'success', message: `${type} downloaded` });
    } catch {
      setToast({ type: 'error', message: `Failed to download ${type}` });
    }
  };

  const maxBarValue = Math.max(
    ...(summary?.devices_by_os?.map((d) => d.count) || [1]),
    ...(summary?.devices_by_status?.map((d) => d.count) || [1]),
    ...(summary?.alerts_by_severity?.map((d) => d.count) || [1]),
    1
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Reports & Export</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          System overview and data export
        </p>
      </div>

      {toast && (
        <AlertBanner type={toast.type} message={toast.message} onClose={() => setToast(null)} />
      )}

      {error && (
        <AlertBanner type="error" message={error} onClose={() => {}} />
      )}

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
        {[
          { label: 'Total Devices', value: summary?.total_devices || 0, color: 'text-gray-900 dark:text-white', icon: Monitor },
          { label: 'Online', value: summary?.online_devices || 0, color: 'text-emerald-600 dark:text-emerald-400', icon: Monitor },
          { label: 'Offline', value: summary?.offline_devices || 0, color: 'text-gray-600 dark:text-gray-400', icon: Monitor },
          { label: 'Total Alerts', value: summary?.total_alerts || 0, color: 'text-red-600 dark:text-red-400', icon: Bell },
          { label: 'Compliance Rate', value: `${summary?.compliance_rate || 0}%`, color: 'text-indigo-600 dark:text-indigo-400', icon: ShieldCheck },
        ].map((stat) => {
          const Icon = stat.icon;
          return (
            <div
              key={stat.label}
              className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4"
            >
              <div className="flex items-center gap-2 mb-2">
                <Icon className="w-4 h-4 text-gray-400 dark:text-gray-500" />
                <p className="text-xs font-medium text-gray-500 dark:text-gray-400">{stat.label}</p>
              </div>
              <p className={`text-2xl font-bold ${stat.color}`}>{stat.value}</p>
            </div>
          );
        })}
      </div>

      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-white mb-4">Export Data</h2>
        <div className="flex flex-wrap gap-3">
          <button
            onClick={() => handleDownload('devices', 'csv')}
            className="inline-flex items-center gap-2 px-4 py-2.5 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors"
          >
            <FileSpreadsheet className="w-4 h-4" />
            Devices CSV
          </button>
          <button
            onClick={() => handleDownload('devices', 'pdf')}
            className="inline-flex items-center gap-2 px-4 py-2.5 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors"
          >
            <FileText className="w-4 h-4" />
            Devices PDF
          </button>
          <button
            onClick={() => handleDownload('alerts', 'csv')}
            className="inline-flex items-center gap-2 px-4 py-2.5 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors"
          >
            <FileSpreadsheet className="w-4 h-4" />
            Alerts CSV
          </button>
          <button
            onClick={() => handleDownload('compliance', 'csv')}
            className="inline-flex items-center gap-2 px-4 py-2.5 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors"
          >
            <FileSpreadsheet className="w-4 h-4" />
            Compliance CSV
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-white mb-4">Devices by OS</h2>
          <div className="space-y-3">
            {(summary?.devices_by_os || []).map((item) => (
              <div key={item.os}>
                <div className="flex items-center justify-between text-xs mb-1">
                  <span className="text-gray-600 dark:text-gray-400">{item.os}</span>
                  <span className="text-gray-700 dark:text-gray-300 font-medium">{item.count}</span>
                </div>
                <div className="w-full h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-indigo-500 rounded-full transition-all"
                    style={{ width: `${(item.count / maxBarValue) * 100}%` }}
                  />
                </div>
              </div>
            ))}
            {(!summary?.devices_by_os || summary.devices_by_os.length === 0) && (
              <p className="text-xs text-gray-500 dark:text-gray-400">No data available</p>
            )}
          </div>
        </div>

        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-white mb-4">Devices by Status</h2>
          <div className="space-y-3">
            {(summary?.devices_by_status || []).map((item) => (
              <div key={item.status}>
                <div className="flex items-center justify-between text-xs mb-1">
                  <span className="text-gray-600 dark:text-gray-400 capitalize">{item.status}</span>
                  <span className="text-gray-700 dark:text-gray-300 font-medium">{item.count}</span>
                </div>
                <div className="w-full h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${
                      item.status === 'online' ? 'bg-emerald-500' :
                      item.status === 'offline' ? 'bg-gray-400' :
                      item.status === 'alert' ? 'bg-amber-500' :
                      'bg-red-500'
                    }`}
                    style={{ width: `${(item.count / maxBarValue) * 100}%` }}
                  />
                </div>
              </div>
            ))}
            {(!summary?.devices_by_status || summary.devices_by_status.length === 0) && (
              <p className="text-xs text-gray-500 dark:text-gray-400">No data available</p>
            )}
          </div>
        </div>

        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-white mb-4">Alert Severity Distribution</h2>
          <div className="space-y-3">
            {(summary?.alerts_by_severity || []).map((item) => (
              <div key={item.severity}>
                <div className="flex items-center justify-between text-xs mb-1">
                  <span className="text-gray-600 dark:text-gray-400 capitalize">{item.severity}</span>
                  <span className="text-gray-700 dark:text-gray-300 font-medium">{item.count}</span>
                </div>
                <div className="w-full h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${
                      item.severity === 'critical' ? 'bg-red-600' :
                      item.severity === 'high' ? 'bg-red-400' :
                      item.severity === 'medium' ? 'bg-amber-500' :
                      'bg-blue-400'
                    }`}
                    style={{ width: `${(item.count / maxBarValue) * 100}%` }}
                  />
                </div>
              </div>
            ))}
            {(!summary?.alerts_by_severity || summary.alerts_by_severity.length === 0) && (
              <p className="text-xs text-gray-500 dark:text-gray-400">No data available</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
