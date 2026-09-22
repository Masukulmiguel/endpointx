import React, { useState, useCallback } from 'react';
import {
  ArrowDownToLine,
  Plus,
  Trash2,
  Edit2,
  X,
  Check,
  Upload,
  Package,
  ExternalLink,
} from 'lucide-react';
import { useApi, useApiMutation } from '../hooks/useApi';
import SearchInput from '../components/SearchInput';
import StatusBadge from '../components/StatusBadge';
import AlertBanner from '../components/AlertBanner';
import LoadingSpinner from '../components/LoadingSpinner';

interface SoftwarePackage {
  id: string;
  name: string;
  version: string;
  installer_url: string;
  installer_type: string;
  silent_args: string;
  file_size: number;
  is_active: boolean;
  created_at: string;
}

interface Deployment {
  id: string;
  package_id: string;
  package_name?: string;
  device_id: string;
  device_name?: string;
  status: 'pending' | 'installing' | 'completed' | 'failed';
  installed_at: string | null;
  error_message: string | null;
  created_at: string;
}

function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatTimeAgo(dateStr: string | null): string {
  if (!dateStr) return 'N/A';
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

const installerTypes = ['msi', 'exe', 'deb', 'rpm', 'dmg', 'pkg', 'app', 'zip', 'tar'];

export default function SoftwarePage() {
  const [search, setSearch] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editingPkg, setEditingPkg] = useState<SoftwarePackage | null>(null);
  const [formName, setFormName] = useState('');
  const [formVersion, setFormVersion] = useState('');
  const [formUrl, setFormUrl] = useState('');
  const [formType, setFormType] = useState('msi');
  const [formSilentArgs, setFormSilentArgs] = useState('');
  const [activeTab, setActiveTab] = useState<'packages' | 'deployments'>('packages');
  const [deployTarget, setDeployTarget] = useState('');
  const [deployType, setDeployType] = useState<'device' | 'group'>('device');
  const [selectedPkg, setSelectedPkg] = useState<SoftwarePackage | null>(null);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  const { data: packagesData, loading, error, refetch } = useApi<{ packages: SoftwarePackage[] }>('/software/packages', {
    params: search ? { search } : undefined,
  });
  const { data: deploymentsData, loading: deploymentsLoading } = useApi<{ deployments: Deployment[] }>('/software/deployments');
  const { loading: saving, mutate: createPackage } = useApiMutation('/software/packages', 'POST');
  const { loading: updating, mutate: updatePackage } = useApiMutation('', 'PUT');
  const { loading: deleting, mutate: deletePackage } = useApiMutation('', 'DELETE');
  const { loading: deploying, mutate: deploySoftware } = useApiMutation('/software/deploy', 'POST');

  const packages = Array.isArray(packagesData?.packages) ? packagesData.packages : [];
  const deployments = Array.isArray(deploymentsData?.deployments) ? deploymentsData.deployments : [];

  const openCreateModal = () => {
    setEditingPkg(null);
    setFormName('');
    setFormVersion('');
    setFormUrl('');
    setFormType('msi');
    setFormSilentArgs('');
    setShowModal(true);
  };

  const openEditModal = (pkg: SoftwarePackage) => {
    setEditingPkg(pkg);
    setFormName(pkg.name);
    setFormVersion(pkg.version);
    setFormUrl(pkg.installer_url);
    setFormType(pkg.installer_type);
    setFormSilentArgs(pkg.silent_args);
    setShowModal(true);
  };

  const handleSave = useCallback(async () => {
    if (!formName.trim() || !formVersion.trim()) {
      setToast({ type: 'error', message: 'Name and version are required' });
      return;
    }
    const payload = {
      name: formName.trim(),
      version: formVersion.trim(),
      installer_url: formUrl.trim(),
      installer_type: formType,
      silent_args: formSilentArgs.trim(),
    };
    let result;
    if (editingPkg) {
      result = await updatePackage(`/software/packages/${editingPkg.id}`, payload);
    } else {
      result = await createPackage(payload);
    }
    if (result) {
      refetch();
      setShowModal(false);
      setToast({ type: 'success', message: editingPkg ? 'Package updated' : 'Package created' });
    } else {
      setToast({ type: 'error', message: 'Operation failed' });
    }
  }, [formName, formVersion, formUrl, formType, formSilentArgs, editingPkg, createPackage, updatePackage, refetch]);

  const handleDelete = useCallback(
    async (id: string) => {
      const result = await deletePackage(`/software/packages/${id}`, undefined as any);
      if (result !== null) {
        refetch();
        setDeleteConfirm(null);
        setToast({ type: 'success', message: 'Package deleted' });
      }
    },
    [deletePackage, refetch]
  );

  const handleDeploy = useCallback(async () => {
    if (!selectedPkg || !deployTarget.trim()) {
      setToast({ type: 'error', message: 'Select a target' });
      return;
    }
    const result = await deploySoftware({
      package_id: selectedPkg.id,
      target_id: deployTarget.trim(),
      target_type: deployType,
    });
    if (result) {
      setToast({ type: 'success', message: 'Deployment initiated' });
      setSelectedPkg(null);
      setDeployTarget('');
    }
  }, [selectedPkg, deployTarget, deployType, deploySoftware]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Software Deployment</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            {packages.length} package{packages.length !== 1 ? 's' : ''} total
          </p>
        </div>
        <button
          onClick={openCreateModal}
          className="inline-flex items-center gap-2 px-4 py-2.5 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors"
        >
          <Plus className="w-4 h-4" />
          Add Package
        </button>
      </div>

      {toast && (
        <AlertBanner type={toast.type} message={toast.message} onClose={() => setToast(null)} />
      )}

      {error && (
        <AlertBanner type="error" message={error} onClose={() => {}} />
      )}

      <div className="flex items-center gap-1 bg-gray-100 dark:bg-gray-700 rounded-lg p-0.5">
        {(['packages', 'deployments'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
              activeTab === tab
                ? 'bg-white dark:bg-gray-600 text-indigo-600 shadow-sm'
                : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
            }`}
          >
            {tab === 'packages' ? 'Packages' : 'Deployment History'}
          </button>
        ))}
      </div>

      {activeTab === 'packages' ? (
        <>
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
            <SearchInput
              value={search}
              onChange={(val) => setSearch(val)}
              placeholder="Search packages..."
              className="w-full sm:w-72"
            />
          </div>

          {loading ? (
            <div className="flex items-center justify-center h-64">
              <LoadingSpinner size="lg" />
            </div>
          ) : packages.length === 0 ? (
            <div className="text-center py-12">
              <Package className="w-12 h-12 text-gray-300 dark:text-gray-600 mx-auto mb-3" />
              <p className="text-gray-500 dark:text-gray-400">No packages found</p>
            </div>
          ) : (
            <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-gray-200 dark:border-gray-700">
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Package</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Version</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Type</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Size</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Status</th>
                      <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-gray-700/50">
                    {packages.map((pkg) => (
                      <tr key={pkg.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/30 transition-colors">
                        <td className="px-6 py-4">
                          <div className="flex items-center gap-3">
                            <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-indigo-100 dark:bg-indigo-900/30">
                              <Package className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
                            </div>
                            <div>
                              <p className="text-sm font-medium text-gray-900 dark:text-white">{pkg.name}</p>
                              <p className="text-xs text-gray-500 dark:text-gray-400 truncate max-w-xs">{pkg.installer_url}</p>
                            </div>
                          </div>
                        </td>
                        <td className="px-6 py-4 text-sm text-gray-700 dark:text-gray-300">{pkg.version}</td>
                        <td className="px-6 py-4">
                          <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 uppercase">
                            {pkg.installer_type}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-sm text-gray-500 dark:text-gray-400">{formatFileSize(pkg.file_size)}</td>
                        <td className="px-6 py-4">
                          <StatusBadge status={pkg.is_active ? 'online' : 'offline'} />
                        </td>
                        <td className="px-6 py-4">
                          <div className="flex items-center justify-end gap-1">
                            <button
                              onClick={() => setSelectedPkg(pkg)}
                              className="p-1.5 rounded-md text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 transition-colors"
                              title="Deploy"
                            >
                              <ArrowDownToLine className="w-4 h-4" />
                            </button>
                            <button
                              onClick={() => openEditModal(pkg)}
                              className="p-1.5 rounded-md text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 transition-colors"
                              title="Edit"
                            >
                              <Edit2 className="w-4 h-4" />
                            </button>
                            {deleteConfirm === pkg.id ? (
                              <div className="flex items-center gap-1">
                                <button
                                  onClick={() => handleDelete(pkg.id)}
                                  disabled={deleting}
                                  className="p-1.5 rounded-md text-white bg-red-600 hover:bg-red-700 transition-colors"
                                >
                                  <Check className="w-4 h-4" />
                                </button>
                                <button
                                  onClick={() => setDeleteConfirm(null)}
                                  className="p-1.5 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                                >
                                  <X className="w-4 h-4" />
                                </button>
                              </div>
                            ) : (
                              <button
                                onClick={() => setDeleteConfirm(pkg.id)}
                                className="p-1.5 rounded-md text-gray-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                                title="Delete"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      ) : (
        <>
          {deploymentsLoading ? (
            <div className="flex items-center justify-center h-64">
              <LoadingSpinner size="lg" />
            </div>
          ) : deployments.length === 0 ? (
            <div className="text-center py-12">
              <ArrowDownToLine className="w-12 h-12 text-gray-300 dark:text-gray-600 mx-auto mb-3" />
              <p className="text-gray-500 dark:text-gray-400">No deployments found</p>
            </div>
          ) : (
            <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-gray-200 dark:border-gray-700">
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Device</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Package</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Status</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Date</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-gray-700/50">
                    {deployments.map((dep) => (
                      <tr key={dep.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/30 transition-colors">
                        <td className="px-6 py-4 text-sm font-medium text-gray-900 dark:text-white">
                          {dep.device_name || dep.device_id}
                        </td>
                        <td className="px-6 py-4 text-sm text-gray-700 dark:text-gray-300">
                          {dep.package_name || dep.package_id}
                        </td>
                        <td className="px-6 py-4">
                          <StatusBadge status={dep.status === 'completed' ? 'online' : dep.status === 'failed' ? 'blocked' : 'alert'} />
                        </td>
                        <td className="px-6 py-4 text-sm text-gray-500 dark:text-gray-400">
                          {formatTimeAgo(dep.created_at)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {selectedPkg && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl w-full max-w-md mx-4 border border-gray-200 dark:border-gray-700">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-700">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Deploy Package</h2>
              <button
                onClick={() => setSelectedPkg(null)}
                className="p-1.5 rounded-md text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="px-6 py-4 space-y-4">
              <div className="p-3 bg-gray-50 dark:bg-gray-700/50 rounded-lg">
                <p className="text-sm font-medium text-gray-900 dark:text-white">{selectedPkg.name}</p>
                <p className="text-xs text-gray-500 dark:text-gray-400">v{selectedPkg.version} &middot; {selectedPkg.installer_type.toUpperCase()}</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Deploy to</label>
                <div className="flex items-center gap-2">
                  <select
                    value={deployType}
                    onChange={(e) => setDeployType(e.target.value as 'device' | 'group')}
                    className="px-3 py-2.5 text-sm bg-gray-100 dark:bg-gray-700 border border-transparent rounded-lg text-gray-900 dark:text-white focus:ring-2 focus:ring-indigo-500 outline-none"
                  >
                    <option value="device">Device</option>
                    <option value="group">Group</option>
                  </select>
                  <input
                    type="text"
                    value={deployTarget}
                    onChange={(e) => setDeployTarget(e.target.value)}
                    className="flex-1 px-3 py-2.5 text-sm bg-gray-100 dark:bg-gray-700 border border-transparent rounded-lg text-gray-900 dark:text-white focus:ring-2 focus:ring-indigo-500 outline-none"
                    placeholder={deployType === 'device' ? 'Device ID' : 'Group ID'}
                  />
                </div>
              </div>
            </div>
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200 dark:border-gray-700">
              <button
                onClick={() => setSelectedPkg(null)}
                className="px-4 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleDeploy}
                disabled={deploying}
                className="inline-flex items-center gap-2 px-4 py-2.5 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors"
              >
                <ArrowDownToLine className="w-4 h-4" />
                {deploying ? 'Deploying...' : 'Deploy'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl w-full max-w-lg mx-4 border border-gray-200 dark:border-gray-700">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-700">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
                {editingPkg ? 'Edit Package' : 'Add Package'}
              </h2>
              <button
                onClick={() => setShowModal(false)}
                className="p-1.5 rounded-md text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="px-6 py-4 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Name *</label>
                <input
                  type="text"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  className="w-full px-3 py-2.5 text-sm bg-gray-100 dark:bg-gray-700 border border-transparent rounded-lg text-gray-900 dark:text-white focus:ring-2 focus:ring-indigo-500 outline-none"
                  placeholder="e.g., Chrome Browser"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Version *</label>
                <input
                  type="text"
                  value={formVersion}
                  onChange={(e) => setFormVersion(e.target.value)}
                  className="w-full px-3 py-2.5 text-sm bg-gray-100 dark:bg-gray-700 border border-transparent rounded-lg text-gray-900 dark:text-white focus:ring-2 focus:ring-indigo-500 outline-none"
                  placeholder="e.g., 1.0.0"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Installer URL</label>
                <input
                  type="url"
                  value={formUrl}
                  onChange={(e) => setFormUrl(e.target.value)}
                  className="w-full px-3 py-2.5 text-sm bg-gray-100 dark:bg-gray-700 border border-transparent rounded-lg text-gray-900 dark:text-white focus:ring-2 focus:ring-indigo-500 outline-none"
                  placeholder="https://example.com/installer.msi"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Installer Type</label>
                <select
                  value={formType}
                  onChange={(e) => setFormType(e.target.value)}
                  className="w-full px-3 py-2.5 text-sm bg-gray-100 dark:bg-gray-700 border border-transparent rounded-lg text-gray-900 dark:text-white focus:ring-2 focus:ring-indigo-500 outline-none"
                >
                  {installerTypes.map((t) => (
                    <option key={t} value={t}>{t.toUpperCase()}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Silent Arguments</label>
                <input
                  type="text"
                  value={formSilentArgs}
                  onChange={(e) => setFormSilentArgs(e.target.value)}
                  className="w-full px-3 py-2.5 text-sm bg-gray-100 dark:bg-gray-700 border border-transparent rounded-lg text-gray-900 dark:text-white focus:ring-2 focus:ring-indigo-500 outline-none"
                  placeholder="e.g., /quiet /norestart"
                />
              </div>
            </div>
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200 dark:border-gray-700">
              <button
                onClick={() => setShowModal(false)}
                className="px-4 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={saving || updating}
                className="inline-flex items-center gap-2 px-4 py-2.5 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors"
              >
                {saving || updating ? 'Saving...' : editingPkg ? 'Update' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
