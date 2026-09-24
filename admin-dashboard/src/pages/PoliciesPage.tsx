import React, { useState, useCallback } from 'react';
import {
  ShieldCheck,
  Plus,
  Trash2,
  Edit2,
  X,
  Check,
  Play,
  AlertTriangle,
  CheckCircle,
} from 'lucide-react';
import { useApi, useApiMutation } from '../hooks/useApi';
import { useAuth } from '../contexts/AuthContext';
import api from '../services/api';
import SearchInput from '../components/SearchInput';
import AlertBanner from '../components/AlertBanner';
import LoadingSpinner from '../components/LoadingSpinner';

interface CompliancePolicy {
  id: string;
  name: string;
  description: string;
  rules: Record<string, any>;
  is_active: boolean;
  created_at: string;
}

interface ComplianceResult {
  id: string;
  device_id: string;
  device_name?: string;
  policy_id: string;
  is_compliant: boolean;
  violations: string[];
  checked_at: string;
}

interface PolicyStats {
  total: number;
  active: number;
  compliance_rate: number;
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

const ruleFields = [
  { key: 'min_os_version', label: 'Min OS Version', type: 'text', placeholder: 'e.g., 10.0.19041' },
  { key: 'require_firewall', label: 'Require Firewall', type: 'toggle' },
  { key: 'require_antivirus', label: 'Require Antivirus', type: 'toggle' },
  { key: 'max_cpu_usage', label: 'Max CPU Usage (%)', type: 'number', placeholder: 'e.g., 90' },
  { key: 'max_disk_usage', label: 'Max Disk Usage (%)', type: 'number', placeholder: 'e.g., 90' },
  { key: 'required_agent_version', label: 'Required Agent Version', type: 'text', placeholder: 'e.g., 1.1.0' },
];

export default function PoliciesPage() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('policies.manage');
  const [search, setSearch] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editingPolicy, setEditingPolicy] = useState<CompliancePolicy | null>(null);
  const [formName, setFormName] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [formRules, setFormRules] = useState<Record<string, any>>({});
  const [selectedPolicy, setSelectedPolicy] = useState<CompliancePolicy | null>(null);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [checkResults, setCheckResults] = useState<ComplianceResult[] | null>(null);
  const [checking, setChecking] = useState(false);

  const { data, loading, error, refetch } = useApi<{ policies: CompliancePolicy[] }>('/policies', {
    params: search ? { search } : undefined,
  });
  const { data: statsData } = useApi<PolicyStats>('/policies/stats');
  const { loading: saving, mutate: createPolicy } = useApiMutation('/policies', 'POST');
  const { loading: updating, mutate: updatePolicy } = useApiMutation('', 'PUT');
  const { loading: deleting, mutate: deletePolicy } = useApiMutation('', 'DELETE');

  const policies = Array.isArray(data?.policies) ? data.policies : [];
  const stats = statsData;

  const openCreateModal = () => {
    setEditingPolicy(null);
    setFormName('');
    setFormDescription('');
    setFormRules({});
    setShowModal(true);
  };

  const openEditModal = (policy: CompliancePolicy) => {
    setEditingPolicy(policy);
    setFormName(policy.name);
    setFormDescription(policy.description);
    setFormRules(policy.rules || {});
    setShowModal(true);
  };

  const handleRuleChange = (key: string, value: any) => {
    setFormRules((prev) => ({ ...prev, [key]: value }));
  };

  const handleSave = useCallback(async () => {
    if (!formName.trim()) {
      setToast({ type: 'error', message: 'Policy name is required' });
      return;
    }
    const payload = { name: formName.trim(), description: formDescription.trim(), rules: formRules };
    let result;
    if (editingPolicy) {
      result = await updatePolicy(`/policies/${editingPolicy.id}`, payload);
    } else {
      result = await createPolicy(payload);
    }
    if (result) {
      refetch();
      setShowModal(false);
      setToast({ type: 'success', message: editingPolicy ? 'Policy updated' : 'Policy created' });
    } else {
      setToast({ type: 'error', message: 'Operation failed' });
    }
  }, [formName, formDescription, formRules, editingPolicy, createPolicy, updatePolicy, refetch]);

  const handleDelete = useCallback(
    async (id: string) => {
      const result = await deletePolicy(`/policies/${id}`, undefined as any);
      if (result !== null) {
        refetch();
        setDeleteConfirm(null);
        setToast({ type: 'success', message: 'Policy deleted' });
      }
    },
    [deletePolicy, refetch]
  );

  const handleRunCheck = useCallback(async (policyId: string) => {
    setChecking(true);
    try {
      const result = await api.checkCompliance(policyId);
      const payload = result as any;
      setCheckResults(payload?.data?.results || payload?.results || []);
      setToast({ type: 'success', message: 'Compliance check completed' });
    } catch {
      setToast({ type: 'error', message: 'Compliance check failed' });
    } finally {
      setChecking(false);
    }
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Compliance Policies</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            {policies.length} polic{policies.length !== 1 ? 'ies' : 'y'} total
          </p>
        </div>
        {canManage && (
          <button
            onClick={openCreateModal}
            className="inline-flex items-center gap-2 px-4 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
          >
            <Plus className="w-4 h-4" />
            Create Policy
          </button>
        )}
      </div>

      {toast && (
        <AlertBanner type={toast.type} message={toast.message} onClose={() => setToast(null)} />
      )}

      {error && (
        <AlertBanner type="error" message={error} onClose={() => {}} />
      )}

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
        {[
          { label: 'Total Policies', value: stats?.total || 0, color: 'text-gray-900 dark:text-white' },
          { label: 'Active', value: stats?.active || 0, color: 'text-emerald-600 dark:text-emerald-400' },
          { label: 'Compliance Rate', value: `${stats?.compliance_rate || 0}%`, color: 'text-blue-600 dark:text-blue-400' },
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
          onChange={(val) => setSearch(val)}
          placeholder="Search policies..."
          className="w-full sm:w-72"
        />
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-64">
          <LoadingSpinner size="lg" />
        </div>
      ) : policies.length === 0 ? (
        <div className="text-center py-12">
          <ShieldCheck className="w-12 h-12 text-gray-300 dark:text-gray-600 mx-auto mb-3" />
          <p className="text-gray-500 dark:text-gray-400">No policies found</p>
        </div>
      ) : (
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-200 dark:border-gray-700">
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Name</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Status</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Rules</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Last Check</th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700/50">
                {policies.map((policy) => (
                  <tr key={policy.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/30 transition-colors">
                    <td className="px-6 py-4">
                      <p className="text-sm font-medium text-gray-900 dark:text-white">{policy.name}</p>
                      <p className="text-xs text-gray-500 dark:text-gray-400 truncate max-w-xs">{policy.description || 'No description'}</p>
                    </td>
                    <td className="px-6 py-4">
                      <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${
                        policy.is_active
                          ? 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400'
                          : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400'
                      }`}>
                        {policy.is_active ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <span className="text-sm text-gray-700 dark:text-gray-300">
                        {Object.keys(policy.rules || {}).length} rule{Object.keys(policy.rules || {}).length !== 1 ? 's' : ''}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <span className="text-sm text-gray-500 dark:text-gray-400">{formatTimeAgo(policy.created_at)}</span>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => handleRunCheck(policy.id)}
                          disabled={checking}
                          className="p-1.5 rounded-md text-gray-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors disabled:opacity-50"
                          title="Run Compliance Check"
                        >
                          <Play className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => openEditModal(policy)}
                          className="p-1.5 rounded-md text-gray-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors"
                          title="Edit"
                        >
                          <Edit2 className="w-4 h-4" />
                        </button>
                        {deleteConfirm === policy.id ? (
                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => handleDelete(policy.id)}
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
                            onClick={() => setDeleteConfirm(policy.id)}
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

      {checkResults && checkResults.length > 0 && (
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Compliance Results</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-200 dark:border-gray-700">
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Device</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Status</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Violations</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Checked At</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700/50">
                {checkResults.map((result) => (
                  <tr key={result.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/30 transition-colors">
                    <td className="px-6 py-4 text-sm font-medium text-gray-900 dark:text-white">
                      {result.device_name || result.device_id}
                    </td>
                    <td className="px-6 py-4">
                      {result.is_compliant ? (
                        <span className="inline-flex items-center gap-1 text-sm text-emerald-600 dark:text-emerald-400">
                          <CheckCircle className="w-4 h-4" /> Compliant
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-sm text-red-600 dark:text-red-400">
                          <AlertTriangle className="w-4 h-4" /> Non-compliant
                        </span>
                      )}
                    </td>
                    <td className="px-6 py-4">
                      <span className="text-sm text-gray-700 dark:text-gray-300">
                        {result.violations?.length || 0} violation{(result.violations?.length || 0) !== 1 ? 's' : ''}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-500 dark:text-gray-400">
                      {formatTimeAgo(result.checked_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl w-full max-w-lg mx-4 border border-gray-200 dark:border-gray-700 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-700">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
                {editingPolicy ? 'Edit Policy' : 'Create Policy'}
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
                  className="w-full px-3 py-2.5 text-sm bg-gray-100 dark:bg-gray-700 border border-transparent rounded-lg text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
                  placeholder="e.g., Security Baseline"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Description</label>
                <textarea
                  value={formDescription}
                  onChange={(e) => setFormDescription(e.target.value)}
                  rows={2}
                  className="w-full px-3 py-2.5 text-sm bg-gray-100 dark:bg-gray-700 border border-transparent rounded-lg text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none resize-none"
                  placeholder="Optional description"
                />
              </div>
              <div className="space-y-3">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Rules</label>
                {ruleFields.map((field) => (
                  <div key={field.key} className="flex items-center justify-between gap-4">
                    <label className="text-sm text-gray-600 dark:text-gray-400">{field.label}</label>
                    {field.type === 'toggle' ? (
                      <button
                        type="button"
                        onClick={() => handleRuleChange(field.key, !formRules[field.key])}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                          formRules[field.key] ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'
                        }`}
                      >
                        <span
                          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                            formRules[field.key] ? 'translate-x-6' : 'translate-x-1'
                          }`}
                        />
                      </button>
                    ) : (
                      <input
                        type={field.type}
                        value={formRules[field.key] || ''}
                        onChange={(e) => handleRuleChange(field.key, field.type === 'number' ? Number(e.target.value) : e.target.value)}
                        className="w-40 px-3 py-2 text-sm bg-gray-100 dark:bg-gray-700 border border-transparent rounded-lg text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
                        placeholder={field.placeholder}
                      />
                    )}
                  </div>
                ))}
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
                className="inline-flex items-center gap-2 px-4 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
              >
                {saving || updating ? 'Saving...' : editingPolicy ? 'Update' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
