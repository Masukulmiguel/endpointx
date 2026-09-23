import React, { useState, useMemo, useCallback } from 'react';
import {
  UserPlus,
  Pencil,
  UserX,
  Users as UsersIcon,
  Shield,
  Clock,
} from 'lucide-react';
import { useApi, useApiMutation } from '../hooks/useApi';
import SearchInput from '../components/SearchInput';
import DataTable from '../components/DataTable';
import Pagination from '../components/Pagination';
import Modal from '../components/Modal';
import StatusBadge from '../components/StatusBadge';
import AlertBanner from '../components/AlertBanner';
import type { User, Role, PaginatedResponse } from '../types';

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

function getInitials(name: string): string {
  return name
    .split(' ')
    .map((w) => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

function Avatar({ name, className = '' }: { name: string; className?: string }) {
  return (
    <div
      className={`flex items-center justify-center w-9 h-9 rounded-full bg-blue-100 dark:bg-blue-900/50 text-blue-600 dark:text-blue-400 font-semibold text-xs flex-shrink-0 ${className}`}
    >
      {getInitials(name)}
    </div>
  );
}

interface UserFormData {
  email: string;
  username: string;
  full_name: string;
  password: string;
  role_id: string;
}

const emptyUserForm: UserFormData = {
  email: '',
  username: '',
  full_name: '',
  password: '',
  role_id: '',
};

interface EditFormData {
  email: string;
  full_name: string;
  role_id: string;
  is_active: boolean;
}

export default function UsersPage() {
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [page, setPage] = useState(1);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [editUser, setEditUser] = useState<User | null>(null);
  const [addForm, setAddForm] = useState<UserFormData>(emptyUserForm);
  const [editForm, setEditForm] = useState<EditFormData>({
    email: '',
    full_name: '',
    role_id: '',
    is_active: true,
  });
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const params = useMemo(() => {
    const p: Record<string, string> = { page: String(page), limit: '10' };
    if (search) p.search = search;
    if (roleFilter) p.role = roleFilter;
    return p;
  }, [page, search, roleFilter]);

  const { data, loading, error, refetch } = useApi<{ users: User[]; pagination: { page: number; limit: number; total: number; totalPages: number } }>('/users', { params });
  const { data: rolesData } = useApi<{ roles: Role[] }>('/roles');

  const { loading: creating, mutate: createUser } = useApiMutation('/users', 'POST');
  const { loading: updating, mutate: updateUser } = useApiMutation('', 'PUT');

  const users = Array.isArray(data?.users) ? data.users : [];
  const totalPages = data?.pagination?.totalPages || 1;
  const roles = Array.isArray(rolesData?.roles) ? rolesData.roles : [];

  const handleAddUser = useCallback(async () => {
    const result = await createUser(addForm);
    if (result) {
      setShowAddModal(false);
      setAddForm(emptyUserForm);
      refetch();
      setToast({ type: 'success', message: 'User created successfully' });
    }
  }, [addForm, createUser, refetch]);

  const handleEditUser = useCallback(async () => {
    if (!editUser) return;
    const result = await updateUser(`/users/${editUser.id}`, editForm);
    if (result) {
      setShowEditModal(false);
      setEditUser(null);
      refetch();
      setToast({ type: 'success', message: 'User updated successfully' });
    }
  }, [editUser, editForm, updateUser, refetch]);

  const handleDeactivate = useCallback(
    async (user: User) => {
      await updateUser(`/users/${user.id}`, { is_active: !user.is_active });
      refetch();
      setToast({
        type: 'success',
        message: user.is_active ? 'User deactivated' : 'User activated',
      });
    },
    [updateUser, refetch]
  );

  const openEditModal = (user: User) => {
    setEditUser(user);
    setEditForm({
      email: user.email,
      full_name: user.full_name,
      role_id: user.role_id,
      is_active: user.is_active,
    });
    setShowEditModal(true);
  };

  const columns = [
    {
      key: 'full_name',
      label: 'Name',
      sortable: true,
      render: (row: User) => (
        <div className="flex items-center gap-3">
          <Avatar name={row.full_name || row.username} />
          <div>
            <p className="font-medium text-gray-900 dark:text-white">{row.full_name || row.username}</p>
            <p className="text-xs text-gray-500 dark:text-gray-400">@{row.username}</p>
          </div>
        </div>
      ),
    },
    {
      key: 'email',
      label: 'Email',
      sortable: true,
      render: (row: User) => (
        <span className="text-gray-700 dark:text-gray-300">{row.email}</span>
      ),
    },
    {
      key: 'role_name',
      label: 'Role',
      sortable: true,
      render: (row: User) => (
        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400">
          <Shield className="w-3 h-3" />
          {row.role_name || 'Unknown'}
        </span>
      ),
    },
    {
      key: 'is_active',
      label: 'Status',
      sortable: true,
      render: (row: User) => (
        <StatusBadge status={row.is_active ? 'online' : 'offline'} />
      ),
    },
    {
      key: 'last_login',
      label: 'Last Login',
      sortable: true,
      render: (row: User) => (
        <span className="flex items-center gap-1 text-gray-500 dark:text-gray-400">
          <Clock className="w-3 h-3" />
          {formatTimeAgo(row.last_login)}
        </span>
      ),
    },
    {
      key: 'actions',
      label: 'Actions',
      render: (row: User) => (
        <div className="flex items-center gap-1">
          <button
            onClick={(e) => {
              e.stopPropagation();
              openEditModal(row);
            }}
            className="p-1.5 rounded-md text-gray-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors"
            title="Edit"
          >
            <Pencil className="w-4 h-4" />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleDeactivate(row);
            }}
            className={`p-1.5 rounded-md text-gray-400 transition-colors ${
              row.is_active
                ? 'hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20'
                : 'hover:text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-900/20'
            }`}
            title={row.is_active ? 'Deactivate' : 'Activate'}
          >
            <UserX className="w-4 h-4" />
          </button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Users</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            {data?.pagination?.total || 0} user{(data?.pagination?.total || 0) !== 1 ? 's' : ''} total
          </p>
        </div>
        <button
          onClick={() => setShowAddModal(true)}
          className="inline-flex items-center gap-2 px-4 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
        >
          <UserPlus className="w-4 h-4" />
          Add User
        </button>
      </div>

      {toast && (
        <AlertBanner
          type={toast.type}
          message={toast.message}
          onClose={() => setToast(null)}
        />
      )}

      {error && (
        <AlertBanner type="error" message={error} onClose={() => {}} />
      )}

      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
        <SearchInput
          value={search}
          onChange={(val) => {
            setSearch(val);
            setPage(1);
          }}
          placeholder="Search users..."
          className="w-full sm:w-72"
        />
        <select
          value={roleFilter}
          onChange={(e) => {
            setRoleFilter(e.target.value);
            setPage(1);
          }}
          className="px-3 py-2.5 text-sm bg-gray-100 dark:bg-gray-700 border border-transparent rounded-lg text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
        >
          <option value="">All Roles</option>
          {roles.map((role) => (
            <option key={role.id} value={role.id}>
              {role.display_name}
            </option>
          ))}
        </select>
      </div>

      <DataTable
        columns={columns}
        data={users}
        loading={loading}
        emptyMessage="No users found"
      />

      <Pagination currentPage={page} totalPages={totalPages} onPageChange={setPage} />

      <Modal isOpen={showAddModal} onClose={() => setShowAddModal(false)} title="Add User" size="md">
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Email</label>
            <input
              type="email"
              value={addForm.email}
              onChange={(e) => setAddForm((f) => ({ ...f, email: e.target.value }))}
              className="w-full px-3 py-2.5 text-sm bg-gray-100 dark:bg-gray-700 border border-transparent rounded-lg text-gray-900 dark:text-white placeholder-gray-500 focus:ring-2 focus:ring-blue-500 outline-none"
              placeholder="user@example.com"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Username</label>
            <input
              type="text"
              value={addForm.username}
              onChange={(e) => setAddForm((f) => ({ ...f, username: e.target.value }))}
              className="w-full px-3 py-2.5 text-sm bg-gray-100 dark:bg-gray-700 border border-transparent rounded-lg text-gray-900 dark:text-white placeholder-gray-500 focus:ring-2 focus:ring-blue-500 outline-none"
              placeholder="username"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Full Name</label>
            <input
              type="text"
              value={addForm.full_name}
              onChange={(e) => setAddForm((f) => ({ ...f, full_name: e.target.value }))}
              className="w-full px-3 py-2.5 text-sm bg-gray-100 dark:bg-gray-700 border border-transparent rounded-lg text-gray-900 dark:text-white placeholder-gray-500 focus:ring-2 focus:ring-blue-500 outline-none"
              placeholder="John Doe"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Password</label>
            <input
              type="password"
              value={addForm.password}
              onChange={(e) => setAddForm((f) => ({ ...f, password: e.target.value }))}
              className="w-full px-3 py-2.5 text-sm bg-gray-100 dark:bg-gray-700 border border-transparent rounded-lg text-gray-900 dark:text-white placeholder-gray-500 focus:ring-2 focus:ring-blue-500 outline-none"
              placeholder="••••••••"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Role</label>
            <select
              value={addForm.role_id}
              onChange={(e) => setAddForm((f) => ({ ...f, role_id: e.target.value }))}
              className="w-full px-3 py-2.5 text-sm bg-gray-100 dark:bg-gray-700 border border-transparent rounded-lg text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
            >
              <option value="">Select role</option>
              {roles.map((role) => (
                <option key={role.id} value={role.id}>
                  {role.display_name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <button
              onClick={() => setShowAddModal(false)}
              className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleAddUser}
              disabled={creating || !addForm.email || !addForm.username || !addForm.password || !addForm.role_id}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {creating ? 'Creating...' : 'Create User'}
            </button>
          </div>
        </div>
      </Modal>

      <Modal isOpen={showEditModal} onClose={() => setShowEditModal(false)} title="Edit User" size="md">
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Email</label>
            <input
              type="email"
              value={editForm.email}
              onChange={(e) => setEditForm((f) => ({ ...f, email: e.target.value }))}
              className="w-full px-3 py-2.5 text-sm bg-gray-100 dark:bg-gray-700 border border-transparent rounded-lg text-gray-900 dark:text-white placeholder-gray-500 focus:ring-2 focus:ring-blue-500 outline-none"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Full Name</label>
            <input
              type="text"
              value={editForm.full_name}
              onChange={(e) => setEditForm((f) => ({ ...f, full_name: e.target.value }))}
              className="w-full px-3 py-2.5 text-sm bg-gray-100 dark:bg-gray-700 border border-transparent rounded-lg text-gray-900 dark:text-white placeholder-gray-500 focus:ring-2 focus:ring-blue-500 outline-none"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Role</label>
            <select
              value={editForm.role_id}
              onChange={(e) => setEditForm((f) => ({ ...f, role_id: e.target.value }))}
              className="w-full px-3 py-2.5 text-sm bg-gray-100 dark:bg-gray-700 border border-transparent rounded-lg text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
            >
              <option value="">Select role</option>
              {roles.map((role) => (
                <option key={role.id} value={role.id}>
                  {role.display_name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-700/50 rounded-lg">
            <div>
              <p className="text-sm font-medium text-gray-900 dark:text-white">Active</p>
              <p className="text-xs text-gray-500 dark:text-gray-400">Allow this user to log in</p>
            </div>
            <button
              type="button"
              onClick={() => setEditForm((f) => ({ ...f, is_active: !f.is_active }))}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                editForm.is_active ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  editForm.is_active ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <button
              onClick={() => setShowEditModal(false)}
              className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleEditUser}
              disabled={updating}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {updating ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
