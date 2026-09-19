import React, { useState, useMemo, useCallback } from 'react';
import {
  Shield,
  Plus,
  Pencil,
  Trash2,
  Lock,
  CheckCircle,
} from 'lucide-react';
import { useApi, useApiMutation } from '../hooks/useApi';
import Modal from '../components/Modal';
import AlertBanner from '../components/AlertBanner';
import LoadingSpinner from '../components/LoadingSpinner';
import type { Role, Permission } from '../types';

interface RoleFormData {
  name: string;
  display_name: string;
  description: string;
  permission_ids: string[];
}

const emptyRoleForm: RoleFormData = {
  name: '',
  display_name: '',
  description: '',
  permission_ids: [],
};

export default function RolesPage() {
  const [showRoleModal, setShowRoleModal] = useState(false);
  const [editRole, setEditRole] = useState<Role | null>(null);
  const [roleForm, setRoleForm] = useState<RoleFormData>(emptyRoleForm);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const { data: rolesData, loading: rolesLoading, refetch: refetchRoles } = useApi<{ roles: Role[] }>('/roles');
  const { data: permissionsData } = useApi<{ permissions: Permission[] }>('/roles/permissions');

  const { loading: creating, mutate: createRole } = useApiMutation('/roles', 'POST');
  const { loading: updating, mutate: updateRole } = useApiMutation('', 'PUT');
  const { loading: deleting, mutate: deleteRole } = useApiMutation('', 'DELETE');

  const roles = Array.isArray(rolesData?.roles) ? rolesData.roles : [];
  const permissions = Array.isArray(permissionsData?.permissions) ? permissionsData.permissions : [];

  const permissionsByCategory = useMemo(() => {
    const grouped: Record<string, Permission[]> = {};
    permissions.forEach((p) => {
      const cat = p.category || 'General';
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(p);
    });
    return grouped;
  }, [permissions]);

  const handleSaveRole = useCallback(async () => {
    const payload = {
      ...roleForm,
      permissions: roleForm.permission_ids,
    };
    if (editRole) {
      const result = await updateRole(`/roles/${editRole.id}`, payload);
      if (result) {
        setShowRoleModal(false);
        setEditRole(null);
        setRoleForm(emptyRoleForm);
        refetchRoles();
        setToast({ type: 'success', message: 'Role updated successfully' });
      }
    } else {
      const result = await createRole(payload);
      if (result) {
        setShowRoleModal(false);
        setRoleForm(emptyRoleForm);
        refetchRoles();
        setToast({ type: 'success', message: 'Role created successfully' });
      }
    }
  }, [roleForm, editRole, createRole, updateRole, refetchRoles]);

  const handleDeleteRole = useCallback(
    async (role: Role) => {
      if (!confirm(`Are you sure you want to delete "${role.display_name}"?`)) return;
      await deleteRole(`/roles/${role.id}`);
      refetchRoles();
      setToast({ type: 'success', message: 'Role deleted successfully' });
    },
    [deleteRole, refetchRoles]
  );

  const openEditModal = (role: Role) => {
    setEditRole(role);
    setRoleForm({
      name: role.name,
      display_name: role.display_name,
      description: role.description || '',
      permission_ids: (role.permissions || []).map((p) => p.id),
    });
    setShowRoleModal(true);
  };

  const openCreateModal = () => {
    setEditRole(null);
    setRoleForm(emptyRoleForm);
    setShowRoleModal(true);
  };

  const togglePermission = (permId: string) => {
    setRoleForm((f) => ({
      ...f,
      permission_ids: f.permission_ids.includes(permId)
        ? f.permission_ids.filter((id) => id !== permId)
        : [...f.permission_ids, permId],
    }));
  };

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Roles & Permissions</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          Manage roles and their associated permissions
        </p>
      </div>

      {toast && (
        <AlertBanner type={toast.type} message={toast.message} onClose={() => setToast(null)} />
      )}

      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Roles</h2>
        <button
          onClick={openCreateModal}
          className="inline-flex items-center gap-2 px-4 py-2.5 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors"
        >
          <Plus className="w-4 h-4" />
          Create Role
        </button>
      </div>

      {rolesLoading ? (
        <LoadingSpinner size="md" />
      ) : roles.length === 0 ? (
        <div className="text-center py-12 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700">
          <Shield className="w-12 h-12 text-gray-300 dark:text-gray-600 mx-auto mb-3" />
          <p className="text-gray-500 dark:text-gray-400">No roles found</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {roles.map((role) => (
            <div
              key={role.id}
              className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-5 hover:border-gray-300 dark:hover:border-gray-600 transition-colors"
            >
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-3">
                  <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-indigo-100 dark:bg-indigo-900/30">
                    <Shield className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-gray-900 dark:text-white">{role.display_name}</h3>
                    <p className="text-xs text-gray-500 dark:text-gray-400">{role.name}</p>
                  </div>
                </div>
                {role.is_system && (
                  <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400">
                    <Lock className="w-3 h-3" />
                    System
                  </span>
                )}
              </div>
              {role.description && (
                <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">{role.description}</p>
              )}
              <div className="flex items-center justify-between pt-3 border-t border-gray-100 dark:border-gray-700">
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  {role.permission_count ?? (role.permissions || []).length} permission
                  {(role.permission_count ?? (role.permissions || []).length) !== 1 ? 's' : ''}
                </span>
                {!role.is_system && (
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => openEditModal(role)}
                      className="p-1.5 rounded-md text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 transition-colors"
                      title="Edit"
                    >
                      <Pencil className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => handleDeleteRole(role)}
                      disabled={deleting}
                      className="p-1.5 rounded-md text-gray-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors disabled:opacity-50"
                      title="Delete"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <div>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Permissions</h2>
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 divide-y divide-gray-200 dark:divide-gray-700">
          {Object.entries(permissionsByCategory).map(([category, perms]) => (
            <div key={category}>
              <div className="px-5 py-3 bg-gray-50 dark:bg-gray-750">
                <h3 className="text-sm font-semibold text-gray-900 dark:text-white">{category}</h3>
              </div>
              <div className="divide-y divide-gray-100 dark:divide-gray-700/50">
                {perms.map((perm) => (
                  <div key={perm.id} className="px-5 py-3 flex items-start gap-3">
                    <CheckCircle className="w-4 h-4 text-emerald-500 mt-0.5 flex-shrink-0" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-900 dark:text-white">{perm.name}</p>
                      <p className="text-xs font-mono text-gray-500 dark:text-gray-400">{perm.code}</p>
                      {perm.description && (
                        <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">{perm.description}</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
          {Object.keys(permissionsByCategory).length === 0 && (
            <div className="px-5 py-8 text-center text-gray-500 dark:text-gray-400 text-sm">
              No permissions found
            </div>
          )}
        </div>
      </div>

      <Modal
        isOpen={showRoleModal}
        onClose={() => setShowRoleModal(false)}
        title={editRole ? 'Edit Role' : 'Create Role'}
        size="lg"
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Name</label>
            <input
              type="text"
              value={roleForm.name}
              onChange={(e) => setRoleForm((f) => ({ ...f, name: e.target.value }))}
              className="w-full px-3 py-2.5 text-sm bg-gray-100 dark:bg-gray-700 border border-transparent rounded-lg text-gray-900 dark:text-white placeholder-gray-500 focus:ring-2 focus:ring-indigo-500 outline-none"
              placeholder="editor"
              disabled={!!editRole?.is_system}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Display Name</label>
            <input
              type="text"
              value={roleForm.display_name}
              onChange={(e) => setRoleForm((f) => ({ ...f, display_name: e.target.value }))}
              className="w-full px-3 py-2.5 text-sm bg-gray-100 dark:bg-gray-700 border border-transparent rounded-lg text-gray-900 dark:text-white placeholder-gray-500 focus:ring-2 focus:ring-indigo-500 outline-none"
              placeholder="Editor"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Description</label>
            <textarea
              value={roleForm.description}
              onChange={(e) => setRoleForm((f) => ({ ...f, description: e.target.value }))}
              rows={2}
              className="w-full px-3 py-2.5 text-sm bg-gray-100 dark:bg-gray-700 border border-transparent rounded-lg text-gray-900 dark:text-white placeholder-gray-500 focus:ring-2 focus:ring-indigo-500 outline-none resize-none"
              placeholder="Role description..."
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Permissions</label>
            <div className="max-h-64 overflow-y-auto border border-gray-200 dark:border-gray-600 rounded-lg divide-y divide-gray-200 dark:divide-gray-700">
              {Object.entries(permissionsByCategory).map(([category, perms]) => (
                <div key={category}>
                  <div className="px-3 py-2 bg-gray-50 dark:bg-gray-750 sticky top-0">
                    <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">
                      {category}
                    </span>
                  </div>
                  {perms.map((perm) => (
                    <label
                      key={perm.id}
                      className="flex items-center gap-3 px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-700/50 cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={roleForm.permission_ids.includes(perm.id)}
                        onChange={() => togglePermission(perm.id)}
                        className="w-4 h-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                      />
                      <div className="min-w-0">
                        <p className="text-sm text-gray-900 dark:text-white">{perm.name}</p>
                        <p className="text-xs text-gray-400 dark:text-gray-500">{perm.code}</p>
                      </div>
                    </label>
                  ))}
                </div>
              ))}
              {Object.keys(permissionsByCategory).length === 0 && (
                <div className="px-4 py-6 text-center text-sm text-gray-500 dark:text-gray-400">
                  No permissions available
                </div>
              )}
            </div>
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <button
              onClick={() => setShowRoleModal(false)}
              className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSaveRole}
              disabled={creating || updating || !roleForm.name || !roleForm.display_name}
              className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {creating || updating ? 'Saving...' : editRole ? 'Save Changes' : 'Create Role'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
