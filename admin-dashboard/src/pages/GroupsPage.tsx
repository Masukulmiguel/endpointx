import React, { useState, useCallback } from 'react';
import {
  Users,
  Plus,
  Trash2,
  Edit2,
  X,
  Check,
  Monitor,
} from 'lucide-react';
import { useApi, useApiMutation } from '../hooks/useApi';
import SearchInput from '../components/SearchInput';
import AlertBanner from '../components/AlertBanner';
import LoadingSpinner from '../components/LoadingSpinner';

interface DeviceGroup {
  id: string;
  name: string;
  description: string;
  color: string;
  device_count: number;
  created_at: string;
}

const colorOptions = [
  { value: '#6366f1', label: 'Indigo' },
  { value: '#10b981', label: 'Emerald' },
  { value: '#f59e0b', label: 'Amber' },
  { value: '#ef4444', label: 'Red' },
  { value: '#8b5cf6', label: 'Violet' },
  { value: '#ec4899', label: 'Pink' },
  { value: '#06b6d4', label: 'Cyan' },
  { value: '#84cc16', label: 'Lime' },
];

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

export default function GroupsPage() {
  const [search, setSearch] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editingGroup, setEditingGroup] = useState<DeviceGroup | null>(null);
  const [formName, setFormName] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [formColor, setFormColor] = useState('#6366f1');
  const [selectedGroup, setSelectedGroup] = useState<DeviceGroup | null>(null);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  const { data, loading, error, refetch } = useApi<{ groups: DeviceGroup[] }>('/groups', {
    params: search ? { search } : undefined,
  });
  const { loading: saving, mutate: createGroup } = useApiMutation('/groups', 'POST');
  const { loading: updating, mutate: updateGroup } = useApiMutation('', 'PUT');
  const { loading: deleting, mutate: deleteGroup } = useApiMutation('', 'DELETE');

  const groups = Array.isArray(data?.groups) ? data.groups : [];

  const openCreateModal = () => {
    setEditingGroup(null);
    setFormName('');
    setFormDescription('');
    setFormColor('#6366f1');
    setShowModal(true);
  };

  const openEditModal = (group: DeviceGroup) => {
    setEditingGroup(group);
    setFormName(group.name);
    setFormDescription(group.description);
    setFormColor(group.color);
    setShowModal(true);
  };

  const handleSave = useCallback(async () => {
    if (!formName.trim()) {
      setToast({ type: 'error', message: 'Group name is required' });
      return;
    }
    const payload = { name: formName.trim(), description: formDescription.trim(), color: formColor };
    let result;
    if (editingGroup) {
      result = await updateGroup(`/groups/${editingGroup.id}`, payload);
    } else {
      result = await createGroup(payload);
    }
    if (result) {
      refetch();
      setShowModal(false);
      setToast({ type: 'success', message: editingGroup ? 'Group updated' : 'Group created' });
    } else {
      setToast({ type: 'error', message: 'Operation failed' });
    }
  }, [formName, formDescription, formColor, editingGroup, createGroup, updateGroup, refetch]);

  const handleDelete = useCallback(
    async (id: string) => {
      const result = await deleteGroup(`/groups/${id}`, undefined as any);
      if (result !== null) {
        refetch();
        setDeleteConfirm(null);
        setToast({ type: 'success', message: 'Group deleted' });
      }
    },
    [deleteGroup, refetch]
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Device Groups</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            {groups.length} group{groups.length !== 1 ? 's' : ''} total
          </p>
        </div>
        <button
          onClick={openCreateModal}
          className="inline-flex items-center gap-2 px-4 py-2.5 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors"
        >
          <Plus className="w-4 h-4" />
          Create Group
        </button>
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
          onChange={(val) => setSearch(val)}
          placeholder="Search groups..."
          className="w-full sm:w-72"
        />
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-64">
          <LoadingSpinner size="lg" />
        </div>
      ) : groups.length === 0 ? (
        <div className="text-center py-12">
          <Users className="w-12 h-12 text-gray-300 dark:text-gray-600 mx-auto mb-3" />
          <p className="text-gray-500 dark:text-gray-400">No groups found</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {groups.map((group) => (
            <div
              key={group.id}
              className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-5 hover:border-indigo-300 dark:hover:border-indigo-600 hover:shadow-md transition-all"
            >
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-3 min-w-0">
                  <div
                    className="w-4 h-4 rounded-full flex-shrink-0"
                    style={{ backgroundColor: group.color }}
                  />
                  <div className="min-w-0">
                    <h3 className="text-sm font-semibold text-gray-900 dark:text-white truncate">
                      {group.name}
                    </h3>
                    <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
                      {group.description || 'No description'}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  <button
                    onClick={() => openEditModal(group)}
                    className="p-1.5 rounded-md text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 transition-colors"
                    title="Edit"
                  >
                    <Edit2 className="w-4 h-4" />
                  </button>
                  {deleteConfirm === group.id ? (
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => handleDelete(group.id)}
                        disabled={deleting}
                        className="p-1.5 rounded-md text-white bg-red-600 hover:bg-red-700 transition-colors"
                        title="Confirm Delete"
                      >
                        <Check className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => setDeleteConfirm(null)}
                        className="p-1.5 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                        title="Cancel"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setDeleteConfirm(group.id)}
                      className="p-1.5 rounded-md text-gray-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                      title="Delete"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>

              <div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400 border-t border-gray-100 dark:border-gray-700 pt-3 mt-3">
                <span className="flex items-center gap-1">
                  <Monitor className="w-3 h-3" />
                  {group.device_count} device{group.device_count !== 1 ? 's' : ''}
                </span>
                <span>{formatTimeAgo(group.created_at)}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl w-full max-w-md mx-4 border border-gray-200 dark:border-gray-700">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-700">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
                {editingGroup ? 'Edit Group' : 'Create Group'}
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
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Name *
                </label>
                <input
                  type="text"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  className="w-full px-3 py-2.5 text-sm bg-gray-100 dark:bg-gray-700 border border-transparent rounded-lg text-gray-900 dark:text-white focus:ring-2 focus:ring-indigo-500 outline-none"
                  placeholder="e.g., Finance Department"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Description
                </label>
                <textarea
                  value={formDescription}
                  onChange={(e) => setFormDescription(e.target.value)}
                  rows={3}
                  className="w-full px-3 py-2.5 text-sm bg-gray-100 dark:bg-gray-700 border border-transparent rounded-lg text-gray-900 dark:text-white focus:ring-2 focus:ring-indigo-500 outline-none resize-none"
                  placeholder="Optional description"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Color
                </label>
                <div className="flex items-center gap-2">
                  {colorOptions.map((c) => (
                    <button
                      key={c.value}
                      onClick={() => setFormColor(c.value)}
                      className={`w-7 h-7 rounded-full border-2 transition-all ${
                        formColor === c.value
                          ? 'border-gray-900 dark:border-white scale-110'
                          : 'border-transparent hover:scale-110'
                      }`}
                      style={{ backgroundColor: c.value }}
                      title={c.label}
                    />
                  ))}
                </div>
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
                {saving || updating ? 'Saving...' : editingGroup ? 'Update' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
