import React, { useState, useEffect, useMemo } from 'react';
import {
  Radar,
  Eye,
  Tag,
  UserPlus,
  Ban,
  Play,
  Loader2,
  Copy,
  Check,
} from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { useAuth } from '../contexts/AuthContext';
import { useI18n } from '../i18n';
import api from '../services/api';
import SearchInput from '../components/SearchInput';
import Pagination from '../components/Pagination';
import DataTable from '../components/DataTable';
import Modal from '../components/Modal';

interface DiscoveryNode {
  id: string;
  node_type: string;
  name: string | null;
  hostname: string | null;
  ip_address: string | null;
  mac_address: string | null;
  vendor: string | null;
  vlan: string | null;
  site: string | null;
  metadata: Record<string, unknown> | null;
  source: string | null;
  device_id: string | null;
  first_seen: string | null;
  last_seen: string | null;
  created_by: string | null;
  review_status: string;
  enrollment_requested_at: string | null;
}

interface DiscoveryRun {
  id: string;
  source: string;
  status: string;
  stats: {
    hosts_alive?: number;
    new_nodes?: number;
    updated_nodes?: number;
    linked_devices?: number;
    truncated?: boolean;
  } | null;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
}

interface OnlineDevice {
  id: string;
  hostname: string | null;
  ip_address: string | null;
  status: string;
  agent_id: string | null;
}

type EnrollCommandSet = { windows: string; linux: string; macos: string };

interface EnrollResultRow {
  ip: string;
  ok: boolean;
  error?: string;
  commands?: EnrollCommandSet;
}

function reviewBadgeClasses(status: string): string {
  if (status === 'known') {
    return 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400';
  }
  if (status === 'ignored') {
    return 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400';
  }
  if (status === 'enrollment_requested') {
    return 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400';
  }
  return 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400';
}

export default function DiscoveredDevicesPage() {
  const { t } = useI18n();
  const { hasPermission } = useAuth();
  const canEnroll = hasPermission('devices.manage');

  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [reviewFilter, setReviewFilter] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [actionError, setActionError] = useState<string | null>(null);
  const [bulkSummary, setBulkSummary] = useState<string | null>(null);

  const nodesParams = useMemo(() => {
    const p: Record<string, unknown> = { page, limit: 20 };
    if (search) p.search = search;
    if (reviewFilter) p.review_status = reviewFilter;
    return p;
  }, [page, search, reviewFilter]);

  const {
    data: nodesData,
    loading,
    error,
    refetch: refetchNodes,
  } = useApi<{ nodes: DiscoveryNode[]; pagination: { page: number; limit: number; total: number; totalPages: number } }>(
    '/netsentinel/discovery/nodes',
    { params: nodesParams, refreshInterval: 15000 }
  );

  // Discover run flow
  const [running, setRunning] = useState(false);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [runStats, setRunStats] = useState<DiscoveryRun['stats'] | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  const { data: runsData, refetch: refetchRuns } = useApi<{ runs: DiscoveryRun[] }>('/netsentinel/discovery', {
    refreshInterval: running ? 3000 : 0,
  });

  useEffect(() => {
    if (!running || !activeRunId || !Array.isArray(runsData?.runs)) return;
    const run = runsData!.runs.find((r) => r.id === activeRunId);
    if (!run) return;
    if (run.status === 'completed') {
      setRunning(false);
      setActiveRunId(null);
      setRunStats(run.stats ?? null);
      setRunError(null);
      refetchNodes();
    } else if (run.status === 'failed') {
      setRunning(false);
      setActiveRunId(null);
      setRunStats(null);
      setRunError(run.error_message || t('discovery.runFailed'));
    }
  }, [running, activeRunId, runsData, refetchNodes, t]);

  // Agent picker for the discover modal
  const { data: agentsData } = useApi<{ devices: OnlineDevice[] }>('/devices', {
    params: { status: 'online', limit: 50 },
  });
  const onlineAgents = Array.isArray(agentsData?.devices) ? agentsData!.devices : [];

  const [discoverOpen, setDiscoverOpen] = useState(false);
  const [discoverAgentId, setDiscoverAgentId] = useState('');
  const [discoverCidr, setDiscoverCidr] = useState('');
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [startingRun, setStartingRun] = useState(false);

  const startRun = async () => {
    setStartingRun(true);
    setDiscoverError(null);
    try {
      const body: Record<string, unknown> = {};
      if (discoverAgentId) body.device_id = discoverAgentId;
      if (discoverCidr.trim()) body.cidr = discoverCidr.trim();
      const res = (await api.request('/netsentinel/discovery/run', {
        method: 'POST',
        body: JSON.stringify(body),
      })) as { data?: { run_id?: string } };
      const runId = res?.data?.run_id;
      if (!runId) throw new Error('No run_id returned');
      setDiscoverOpen(false);
      setDiscoverAgentId('');
      setDiscoverCidr('');
      setRunStats(null);
      setRunError(null);
      setRunning(true);
      setActiveRunId(runId);
      refetchRuns();
    } catch (err) {
      setDiscoverError(err instanceof Error ? err.message : t('common.error'));
    } finally {
      setStartingRun(false);
    }
  };

  const nodes = Array.isArray(nodesData?.nodes) ? nodesData!.nodes : [];
  const totalPages = nodesData?.pagination?.totalPages || 1;
  const totalCount = nodesData?.pagination?.total || 0;

  // Selection helpers
  const toggleSelected = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const allOnPageSelected = nodes.length > 0 && nodes.every((n) => selected.has(n.id));
  const toggleSelectAll = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allOnPageSelected) nodes.forEach((n) => next.delete(n.id));
      else nodes.forEach((n) => next.add(n.id));
      return next;
    });
  };

  // Bulk review actions (mark known / ignore)
  const [bulkAction, setBulkAction] = useState<'known' | 'ignored' | null>(null);
  const runBulkReview = async (review: 'known' | 'ignored') => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    setBulkAction(review);
    setBulkSummary(null);
    setActionError(null);
    let ok = 0;
    let failed = 0;
    for (const id of ids) {
      try {
        await api.request(`/netsentinel/discovery/nodes/${id}/${review === 'known' ? 'mark-known' : 'ignore'}`, {
          method: 'POST',
        });
        ok++;
      } catch {
        failed++;
      }
    }
    setBulkAction(null);
    setBulkSummary(`${ok} ${t('discovery.bulkOk')} · ${failed} ${t('discovery.bulkFailed')}`);
    setSelected(new Set());
    refetchNodes();
  };

  // Bulk enrollment
  const [enrollBulkOpen, setEnrollBulkOpen] = useState(false);
  const [enrollBulkResults, setEnrollBulkResults] = useState<EnrollResultRow[]>([]);
  const [enrollingBulk, setEnrollingBulk] = useState(false);
  const runBulkEnroll = async () => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    setEnrollingBulk(true);
    setActionError(null);
    const results: EnrollResultRow[] = [];
    for (const id of ids) {
      const node = nodes.find((n) => n.id === id);
      const ip = node?.ip_address || id;
      try {
        const res = (await api.request(`/netsentinel/discovery/nodes/${id}/enroll-request`, {
          method: 'POST',
        })) as { data?: { token?: string; commands?: EnrollCommandSet } };
        results.push({ ip, ok: true, commands: res?.data?.commands });
      } catch (err) {
        results.push({ ip, ok: false, error: err instanceof Error ? err.message : t('common.error') });
      }
    }
    setEnrollingBulk(false);
    setEnrollBulkResults(results);
    setEnrollBulkOpen(true);
    setSelected(new Set());
    refetchNodes();
  };

  // Row modals
  const [viewNode, setViewNode] = useState<DiscoveryNode | null>(null);
  const [identifyNode, setIdentifyNode] = useState<DiscoveryNode | null>(null);
  const [identifyName, setIdentifyName] = useState('');
  const [identifyType, setIdentifyType] = useState('');
  const [identifying, setIdentifying] = useState(false);
  const [enrollNode, setEnrollNode] = useState<DiscoveryNode | null>(null);
  const [enrollResult, setEnrollResult] = useState<EnrollCommandSet | null>(null);
  const [enrollingSingle, setEnrollingSingle] = useState(false);
  const [copied, setCopied] = useState(false);

  const openIdentify = (node: DiscoveryNode) => {
    setIdentifyNode(node);
    setIdentifyName(node.name || '');
    setIdentifyType(node.node_type || '');
  };

  const submitIdentify = async () => {
    if (!identifyNode) return;
    setIdentifying(true);
    try {
      await api.request(`/netsentinel/discovery/nodes/${identifyNode.id}/identify`, {
        method: 'POST',
        body: JSON.stringify({ name: identifyName, node_type: identifyType }),
      });
      setIdentifyNode(null);
      refetchNodes();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t('common.error'));
    } finally {
      setIdentifying(false);
    }
  };

  const openEnroll = async (node: DiscoveryNode) => {
    setEnrollNode(node);
    setEnrollResult(null);
    setEnrollingSingle(true);
    try {
      const res = (await api.request(`/netsentinel/discovery/nodes/${node.id}/enroll-request`, {
        method: 'POST',
      })) as { data?: { commands?: EnrollCommandSet } };
      setEnrollResult(res?.data?.commands ?? null);
      refetchNodes();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t('common.error'));
      setEnrollNode(null);
    } finally {
      setEnrollingSingle(false);
    }
  };

  const copyWindowsCommand = async (cmd: string) => {
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable — the command stays selectable in the pre block.
    }
  };

  const reviewLabel = (status: string) => {
    if (status === 'known') return t('discovery.review.known');
    if (status === 'ignored') return t('discovery.review.ignored');
    if (status === 'enrollment_requested') return t('discovery.review.enrollmentRequested');
    return t('discovery.review.new');
  };

  const tableColumns = [
    {
      key: 'select',
      label: '',
      width: '40px',
      render: (row: DiscoveryNode) => (
        <input
          type="checkbox"
          checked={selected.has(row.id)}
          onChange={() => toggleSelected(row.id)}
          onClick={(e) => e.stopPropagation()}
          className="rounded border-gray-300 dark:border-gray-600 text-blue-600 focus:ring-blue-500"
          aria-label={row.ip_address || row.id}
        />
      ),
    },
    {
      key: 'ip_address',
      label: 'IP',
      sortable: true,
      render: (row: DiscoveryNode) => (
        <span className="font-mono text-gray-900 dark:text-white">{row.ip_address || t('common.unknown')}</span>
      ),
    },
    {
      key: 'mac_address',
      label: 'MAC',
      render: (row: DiscoveryNode) => (
        <span className="font-mono text-gray-500 dark:text-gray-400">{row.mac_address || t('common.unknown')}</span>
      ),
    },
    {
      key: 'hostname',
      label: t('discovery.columns.hostname'),
      sortable: true,
      render: (row: DiscoveryNode) => (
        <span className="text-gray-700 dark:text-gray-300">{row.hostname || t('common.unknown')}</span>
      ),
    },
    {
      key: 'node_type',
      label: t('discovery.columns.type'),
      render: (row: DiscoveryNode) => (
        <span className="text-gray-500 dark:text-gray-400 text-xs uppercase">{row.node_type}</span>
      ),
    },
    {
      key: 'enrollment',
      label: t('discovery.columns.enrollment'),
      render: (row: DiscoveryNode) =>
        row.device_id ? (
          <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400">
            {t('discovery.enrolled')}
          </span>
        ) : (
          <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400">
            {t('discovery.notEnrolled')}
          </span>
        ),
    },
    {
      key: 'review_status',
      label: t('discovery.columns.review'),
      render: (row: DiscoveryNode) => (
        <span className={reviewBadgeClasses(row.review_status)}>{reviewLabel(row.review_status)}</span>
      ),
    },
    {
      key: 'last_seen',
      label: t('discovery.columns.lastSeen'),
      sortable: true,
      render: (row: DiscoveryNode) => (
        <span className="text-gray-500 dark:text-gray-400">
          {row.last_seen ? new Date(row.last_seen).toLocaleString() : t('common.unknown')}
        </span>
      ),
    },
    {
      key: 'actions',
      label: t('common.actions'),
      render: (row: DiscoveryNode) => (
        <div className="flex items-center gap-1">
          <button
            onClick={(e) => {
              e.stopPropagation();
              setViewNode(row);
            }}
            className="p-1.5 rounded-md text-gray-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors"
            title={t('common.view')}
          >
            <Eye className="w-4 h-4" />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              openIdentify(row);
            }}
            className="p-1.5 rounded-md text-gray-400 hover:text-violet-600 hover:bg-violet-50 dark:hover:bg-violet-900/20 transition-colors"
            title={t('discovery.identify')}
          >
            <Tag className="w-4 h-4" />
          </button>
          {canEnroll && !row.device_id && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                openEnroll(row);
              }}
              className="p-1.5 rounded-md text-gray-400 hover:text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 transition-colors"
              title={t('discovery.enroll')}
            >
              <UserPlus className="w-4 h-4" />
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
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">{t('discovery.title')}</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            {totalCount} {t('discovery.nodeCount')}
          </p>
        </div>
        <button
          onClick={() => {
            setDiscoverOpen(true);
            setDiscoverError(null);
          }}
          disabled={running}
          className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium rounded-lg text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <Radar className="w-4 h-4" />}
          {running ? t('discovery.running') : t('discovery.discover')}
        </button>
      </div>

      {running && (
        <div className="px-4 py-3 rounded-lg bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin text-blue-600 dark:text-blue-400" />
          <p className="text-sm text-blue-700 dark:text-blue-300">{t('discovery.runningHint')}</p>
        </div>
      )}

      {runStats && !running && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="px-4 py-3 rounded-lg bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700">
            <p className="text-xs text-gray-500 dark:text-gray-400">{t('discovery.stats.hostsAlive')}</p>
            <p className="text-lg font-semibold text-gray-900 dark:text-white">{runStats.hosts_alive ?? 0}</p>
          </div>
          <div className="px-4 py-3 rounded-lg bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700">
            <p className="text-xs text-gray-500 dark:text-gray-400">{t('discovery.stats.newNodes')}</p>
            <p className="text-lg font-semibold text-gray-900 dark:text-white">{runStats.new_nodes ?? 0}</p>
          </div>
          <div className="px-4 py-3 rounded-lg bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700">
            <p className="text-xs text-gray-500 dark:text-gray-400">{t('discovery.stats.updatedNodes')}</p>
            <p className="text-lg font-semibold text-gray-900 dark:text-white">{runStats.updated_nodes ?? 0}</p>
          </div>
          <div className="px-4 py-3 rounded-lg bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700">
            <p className="text-xs text-gray-500 dark:text-gray-400">{t('discovery.stats.linkedDevices')}</p>
            <p className="text-lg font-semibold text-gray-900 dark:text-white">{runStats.linked_devices ?? 0}</p>
          </div>
        </div>
      )}

      {runError && !running && (
        <div className="px-4 py-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
          <p className="text-sm text-red-600 dark:text-red-400">{runError}</p>
        </div>
      )}

      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
        <SearchInput
          value={search}
          onChange={(val) => {
            setSearch(val);
            setPage(1);
          }}
          placeholder={t('discovery.search')}
          className="w-full sm:w-72"
        />
        <select
          value={reviewFilter}
          onChange={(e) => {
            setReviewFilter(e.target.value);
            setPage(1);
          }}
          className="px-3 py-2.5 text-sm bg-gray-100 dark:bg-gray-700 border border-transparent rounded-lg text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
        >
          <option value="">{t('discovery.filter.all')}</option>
          <option value="new">{t('discovery.review.new')}</option>
          <option value="known">{t('discovery.review.known')}</option>
          <option value="ignored">{t('discovery.review.ignored')}</option>
          <option value="enrollment_requested">{t('discovery.review.enrollmentRequested')}</option>
        </select>
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
      {bulkSummary && (
        <div className="px-4 py-3 rounded-lg bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 flex items-center justify-between">
          <p className="text-sm text-gray-700 dark:text-gray-300">{bulkSummary}</p>
          <button
            onClick={() => setBulkSummary(null)}
            className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
          >
            {t('nav.dismiss')}
          </button>
        </div>
      )}

      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-3 px-4 py-3 rounded-lg bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800">
          <span className="text-sm font-medium text-blue-800 dark:text-blue-300">
            {selected.size} {t('discovery.selected')}
          </span>
          <div className="flex items-center gap-2 ml-auto">
            {canEnroll && (
              <button
                onClick={runBulkEnroll}
                disabled={enrollingBulk || bulkAction !== null}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 transition-colors"
              >
                {enrollingBulk ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UserPlus className="w-3.5 h-3.5" />}
                {t('discovery.requestEnrollment')}
              </button>
            )}
            <button
              onClick={() => runBulkReview('known')}
              disabled={bulkAction !== null}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50 transition-colors"
            >
              <Tag className="w-3.5 h-3.5" />
              {t('discovery.markKnown')}
            </button>
            <button
              onClick={() => runBulkReview('ignored')}
              disabled={bulkAction !== null}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg text-gray-500 dark:text-gray-400 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50 transition-colors"
            >
              <Ban className="w-3.5 h-3.5" />
              {t('discovery.ignore')}
            </button>
          </div>
        </div>
      )}

      <DataTable
        columns={tableColumns}
        data={nodes}
        loading={loading}
        emptyMessage={t('discovery.empty')}
      />

      <Pagination currentPage={page} totalPages={totalPages} onPageChange={setPage} />

      {/* Discover run modal */}
      <Modal
        isOpen={discoverOpen}
        onClose={() => setDiscoverOpen(false)}
        title={t('discovery.modal.discoverTitle')}
        size="sm"
      >
        <div className="p-6 space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
              {t('discovery.modal.agent')}
            </label>
            <select
              value={discoverAgentId}
              onChange={(e) => setDiscoverAgentId(e.target.value)}
              className="w-full px-3 py-2 text-sm bg-gray-100 dark:bg-gray-700 border border-transparent rounded-lg text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
            >
              <option value="">{t('discovery.modal.autoSelect')}</option>
              {onlineAgents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.hostname || t('common.unknown')}
                  {a.ip_address ? ` (${a.ip_address})` : ''}
                </option>
              ))}
            </select>
            {onlineAgents.length === 0 && (
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{t('discovery.modal.noAgents')}</p>
            )}
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
              {t('discovery.modal.cidr')}
            </label>
            <input
              type="text"
              value={discoverCidr}
              onChange={(e) => setDiscoverCidr(e.target.value)}
              placeholder="192.168.1.0/24"
              className="w-full px-3 py-2 text-sm bg-gray-100 dark:bg-gray-700 border border-transparent rounded-lg text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none font-mono"
            />
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{t('discovery.modal.cidrHint')}</p>
          </div>
          {discoverError && (
            <div className="px-3 py-2 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
              <p className="text-xs text-red-600 dark:text-red-400">{discoverError}</p>
            </div>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <button
              onClick={() => setDiscoverOpen(false)}
              className="px-3 py-2 text-sm rounded-lg text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
            >
              {t('common.cancel')}
            </button>
            <button
              onClick={startRun}
              disabled={startingRun}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {startingRun ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
              {t('discovery.modal.start')}
            </button>
          </div>
        </div>
      </Modal>

      {/* View node modal */}
      <Modal
        isOpen={!!viewNode}
        onClose={() => setViewNode(null)}
        title={t('discovery.modal.viewTitle')}
        size="lg"
      >
        {viewNode && (
          <div className="p-6 space-y-3 text-sm">
            <div className="grid grid-cols-2 gap-x-4 gap-y-2">
              <div>
                <p className="text-xs text-gray-500 dark:text-gray-400">IP</p>
                <p className="font-mono text-gray-900 dark:text-white">{viewNode.ip_address || t('common.unknown')}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500 dark:text-gray-400">MAC</p>
                <p className="font-mono text-gray-900 dark:text-white">{viewNode.mac_address || t('common.unknown')}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500 dark:text-gray-400">{t('discovery.columns.hostname')}</p>
                <p className="text-gray-900 dark:text-white">{viewNode.hostname || t('common.unknown')}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500 dark:text-gray-400">{t('discovery.columns.type')}</p>
                <p className="text-gray-900 dark:text-white uppercase">{viewNode.node_type}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500 dark:text-gray-400">{t('discovery.modal.name')}</p>
                <p className="text-gray-900 dark:text-white">{viewNode.name || t('common.unknown')}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500 dark:text-gray-400">Vendor</p>
                <p className="text-gray-900 dark:text-white">{viewNode.vendor || t('common.unknown')}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500 dark:text-gray-400">VLAN</p>
                <p className="text-gray-900 dark:text-white">{viewNode.vlan || t('common.unknown')}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500 dark:text-gray-400">{t('discovery.modal.site')}</p>
                <p className="text-gray-900 dark:text-white">{viewNode.site || t('common.unknown')}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500 dark:text-gray-400">{t('discovery.columns.enrollment')}</p>
                <p className="text-gray-900 dark:text-white">
                  {viewNode.device_id ? t('discovery.enrolled') : t('discovery.notEnrolled')}
                </p>
              </div>
              <div>
                <p className="text-xs text-gray-500 dark:text-gray-400">{t('discovery.columns.review')}</p>
                <p className="text-gray-900 dark:text-white">{reviewLabel(viewNode.review_status)}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500 dark:text-gray-400">{t('discovery.columns.firstSeen')}</p>
                <p className="text-gray-900 dark:text-white">
                  {viewNode.first_seen ? new Date(viewNode.first_seen).toLocaleString() : t('common.unknown')}
                </p>
              </div>
              <div>
                <p className="text-xs text-gray-500 dark:text-gray-400">{t('discovery.columns.lastSeen')}</p>
                <p className="text-gray-900 dark:text-white">
                  {viewNode.last_seen ? new Date(viewNode.last_seen).toLocaleString() : t('common.unknown')}
                </p>
              </div>
              <div>
                <p className="text-xs text-gray-500 dark:text-gray-400">{t('discovery.modal.source')}</p>
                <p className="text-gray-900 dark:text-white">{viewNode.source || t('common.unknown')}</p>
              </div>
            </div>
            <div>
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">Metadata</p>
              <pre className="px-3 py-2 rounded-lg bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 text-xs text-gray-700 dark:text-gray-300 overflow-x-auto">
                {JSON.stringify(viewNode.metadata ?? {}, null, 2)}
              </pre>
            </div>
          </div>
        )}
      </Modal>

      {/* Identify modal */}
      <Modal
        isOpen={!!identifyNode}
        onClose={() => setIdentifyNode(null)}
        title={t('discovery.modal.identifyTitle')}
        size="sm"
      >
        {identifyNode && (
          <div className="p-6 space-y-4">
            <p className="text-sm text-gray-600 dark:text-gray-400">
              {identifyNode.ip_address}
              {identifyNode.hostname ? ` · ${identifyNode.hostname}` : ''}
            </p>
            <div>
              <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                {t('discovery.modal.name')}
              </label>
              <input
                type="text"
                value={identifyName}
                onChange={(e) => setIdentifyName(e.target.value)}
                className="w-full px-3 py-2 text-sm bg-gray-100 dark:bg-gray-700 border border-transparent rounded-lg text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                {t('discovery.columns.type')}
              </label>
              <select
                value={identifyType}
                onChange={(e) => setIdentifyType(e.target.value)}
                className="w-full px-3 py-2 text-sm bg-gray-100 dark:bg-gray-700 border border-transparent rounded-lg text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
              >
                <option value="UNKNOWN">UNKNOWN</option>
                <option value="ENDPOINT">ENDPOINT</option>
                <option value="SERVER">SERVER</option>
                <option value="PRINTER">PRINTER</option>
                <option value="CAMERA">CAMERA</option>
                <option value="ROUTER">ROUTER</option>
                <option value="SWITCH">SWITCH</option>
                <option value="ACCESS_POINT">ACCESS_POINT</option>
                <option value="IOT">IOT</option>
                <option value="OTHER">OTHER</option>
              </select>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => setIdentifyNode(null)}
                className="px-3 py-2 text-sm rounded-lg text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={submitIdentify}
                disabled={identifying}
                className="px-3 py-2 text-sm rounded-lg text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 transition-colors"
              >
                {identifying ? t('common.loading') : t('common.save')}
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* Single enroll modal */}
      <Modal
        isOpen={!!enrollNode}
        onClose={() => setEnrollNode(null)}
        title={t('discovery.modal.enrollTitle')}
        size="md"
      >
        {enrollNode && (
          <div className="p-6 space-y-4">
            <p className="text-sm text-gray-600 dark:text-gray-400">
              {enrollNode.ip_address}
              {enrollNode.hostname ? ` · ${enrollNode.hostname}` : ''}
            </p>
            {enrollingSingle && (
              <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
                <Loader2 className="w-4 h-4 animate-spin" />
                {t('common.loading')}
              </div>
            )}
            {enrollResult && (
              <div className="space-y-3">
                <p className="text-sm text-gray-700 dark:text-gray-300">{t('discovery.modal.enrollCommandHint')}</p>
                <div className="relative">
                  <pre className="px-3 py-2 pr-10 rounded-lg bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 text-xs text-gray-700 dark:text-gray-300 overflow-x-auto">
                    {enrollResult.windows}
                  </pre>
                  <button
                    onClick={() => copyWindowsCommand(enrollResult.windows)}
                    className="absolute top-1.5 right-1.5 p-1.5 rounded-md text-gray-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors"
                    title={t('discovery.modal.copy')}
                  >
                    {copied ? <Check className="w-4 h-4 text-emerald-500" /> : <Copy className="w-4 h-4" />}
                  </button>
                </div>
                <div className="space-y-2">
                  <p className="text-xs font-medium text-gray-500 dark:text-gray-400">Linux</p>
                  <pre className="px-3 py-2 rounded-lg bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 text-xs text-gray-700 dark:text-gray-300 overflow-x-auto">
                    {enrollResult.linux}
                  </pre>
                  <p className="text-xs font-medium text-gray-500 dark:text-gray-400">macOS</p>
                  <pre className="px-3 py-2 rounded-lg bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 text-xs text-gray-700 dark:text-gray-300 overflow-x-auto">
                    {enrollResult.macos}
                  </pre>
                </div>
              </div>
            )}
            <div className="flex justify-end pt-2">
              <button
                onClick={() => setEnrollNode(null)}
                className="px-3 py-2 text-sm rounded-lg text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
              >
                {t('common.close')}
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* Bulk enrollment results modal */}
      <Modal
        isOpen={enrollBulkOpen}
        onClose={() => setEnrollBulkOpen(false)}
        title={t('discovery.modal.enrollResultsTitle')}
        size="lg"
      >
        <div className="p-6 space-y-4">
          {(() => {
            const firstSuccess = enrollBulkResults.find((r) => r.ok && r.commands);
            return firstSuccess?.commands ? (
              <div className="space-y-2">
                <p className="text-sm text-gray-700 dark:text-gray-300">
                  {t('discovery.modal.enrollCommandHint')}
                </p>
                <div className="relative">
                  <pre className="px-3 py-2 pr-10 rounded-lg bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 text-xs text-gray-700 dark:text-gray-300 overflow-x-auto">
                    {firstSuccess.commands.windows}
                  </pre>
                  <button
                    onClick={() => copyWindowsCommand(firstSuccess.commands!.windows)}
                    className="absolute top-1.5 right-1.5 p-1.5 rounded-md text-gray-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors"
                    title={t('discovery.modal.copy')}
                  >
                    {copied ? <Check className="w-4 h-4 text-emerald-500" /> : <Copy className="w-4 h-4" />}
                  </button>
                </div>
              </div>
            ) : null;
          })()}
          <ul className="divide-y divide-gray-200 dark:divide-gray-700">
            {enrollBulkResults.map((r, i) => (
              <li key={`${r.ip}-${i}`} className="py-2 flex items-center justify-between gap-3">
                <span className="font-mono text-sm text-gray-900 dark:text-white">{r.ip}</span>
                {r.ok ? (
                  <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400">
                    {t('discovery.modal.enrollOk')}
                  </span>
                ) : (
                  <span className="text-xs text-red-600 dark:text-red-400">{r.error || t('common.error')}</span>
                )}
              </li>
            ))}
          </ul>
          <div className="flex justify-end pt-2">
            <button
              onClick={() => setEnrollBulkOpen(false)}
              className="px-3 py-2 text-sm rounded-lg text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
            >
              {t('common.close')}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
