import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './contexts/AuthContext';
import { useI18n } from './i18n';
import Layout from './components/Layout';
import LoadingSpinner from './components/LoadingSpinner';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import DevicesPage from './pages/DevicesPage';
import DeviceDetailPage from './pages/DeviceDetailPage';
import MapPage from './pages/MapPage';
import UsersPage from './pages/UsersPage';
import RolesPage from './pages/RolesPage';
import SecurityPage from './pages/SecurityPage';
import AlertsPage from './pages/AlertsPage';
import AuditLogsPage from './pages/AuditLogsPage';
import NetworkPage from './pages/NetworkPage';
import AgentsPage from './pages/AgentsPage';
import SettingsPage from './pages/SettingsPage';
import InstallPage from './pages/InstallPage';
import GroupsPage from './pages/GroupsPage';
import PoliciesPage from './pages/PoliciesPage';
import SoftwarePage from './pages/SoftwarePage';
import MfaPage from './pages/MfaPage';
import ReportsPage from './pages/ReportsPage';
import NotificationsPage from './pages/NotificationsPage';
import HermesPage from './pages/HermesPage';
import ForgotPasswordPage from './pages/ForgotPasswordPage';
import ResetPasswordPage from './pages/ResetPasswordPage';
import { ShieldAlert, ArrowLeft } from 'lucide-react';
import { Link } from 'react-router-dom';

function AuthGate({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, loading } = useAuth();
  if (loading)
    return (
      <div className="flex items-center justify-center h-screen">
        <LoadingSpinner size="lg" />
      </div>
    );
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function PermissionGate({
  permission,
  children,
}: {
  permission: string;
  children: React.ReactNode;
}) {
  const { hasPermission, loading } = useAuth();
  const { t } = useI18n();
  if (loading)
    return (
      <div className="flex items-center justify-center h-64">
        <LoadingSpinner size="lg" />
      </div>
    );
  if (!hasPermission(permission)) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center max-w-sm px-4">
          <div className="mx-auto w-12 h-12 rounded-full bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center mb-4">
            <ShieldAlert className="w-6 h-6 text-amber-600 dark:text-amber-400" />
          </div>
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
            {t('common.permissionDenied')}
          </h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {t('common.permissionDeniedBody')}
          </p>
          <Link
            to="/dashboard"
            className="mt-4 inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-500 rounded-lg transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            {t('nav.dashboard')}
          </Link>
        </div>
      </div>
    );
  }
  return <>{children}</>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route
        path="/"
        element={
          <AuthGate>
            <Layout />
          </AuthGate>
        }
      >
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="dashboard" element={<DashboardPage />} />
        <Route
          path="devices"
          element={
            <PermissionGate permission="devices.view">
              <DevicesPage />
            </PermissionGate>
          }
        />
        <Route
          path="devices/:id"
          element={
            <PermissionGate permission="devices.view">
              <DeviceDetailPage />
            </PermissionGate>
          }
        />
        <Route
          path="map"
          element={
            <PermissionGate permission="devices.view">
              <MapPage />
            </PermissionGate>
          }
        />
        <Route
          path="users"
          element={
            <PermissionGate permission="users.view">
              <UsersPage />
            </PermissionGate>
          }
        />
        <Route
          path="roles"
          element={
            <PermissionGate permission="roles.view">
              <RolesPage />
            </PermissionGate>
          }
        />
        <Route
          path="security"
          element={
            <PermissionGate permission="security.view">
              <SecurityPage />
            </PermissionGate>
          }
        />
        <Route
          path="alerts"
          element={
            <PermissionGate permission="alerts.view">
              <AlertsPage />
            </PermissionGate>
          }
        />
        <Route
          path="audit-logs"
          element={
            <PermissionGate permission="logs.view">
              <AuditLogsPage />
            </PermissionGate>
          }
        />
        <Route
          path="network"
          element={
            <PermissionGate permission="network.view">
              <NetworkPage />
            </PermissionGate>
          }
        />
        <Route
          path="agents"
          element={
            <PermissionGate permission="devices.view">
              <AgentsPage />
            </PermissionGate>
          }
        />
        <Route
          path="install"
          element={
            <PermissionGate permission="devices.view">
              <InstallPage />
            </PermissionGate>
          }
        />
        <Route
          path="groups"
          element={
            <PermissionGate permission="groups.view">
              <GroupsPage />
            </PermissionGate>
          }
        />
        <Route
          path="policies"
          element={
            <PermissionGate permission="policies.view">
              <PoliciesPage />
            </PermissionGate>
          }
        />
        <Route
          path="software"
          element={
            <PermissionGate permission="software.view">
              <SoftwarePage />
            </PermissionGate>
          }
        />
        <Route path="security/mfa" element={<MfaPage />} />
        <Route
          path="reports"
          element={
            <PermissionGate permission="logs.view">
              <ReportsPage />
            </PermissionGate>
          }
        />
        <Route
          path="notifications"
          element={
            <PermissionGate permission="logs.view">
              <NotificationsPage />
            </PermissionGate>
          }
        />
        <Route
          path="hermes"
          element={
            <PermissionGate permission="hermes.view">
              <HermesPage />
            </PermissionGate>
          }
        />
        <Route
          path="settings"
          element={
            <PermissionGate permission="settings.view">
              <SettingsPage />
            </PermissionGate>
          }
        />
      </Route>
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}
