import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCheck } from 'lucide-react';
import { useApi, useApiMutation } from '../../hooks/useApi';
import { useAuth } from '../../contexts/AuthContext';
import { useI18n } from '../../i18n';
import DataTable from '../../components/DataTable';
import Pagination from '../../components/Pagination';
import AlertBanner from '../../components/AlertBanner';
import ErrorState from '../../components/ErrorState';
import LoadingSpinner from '../../components/LoadingSpinner';

type Finding = {
  id: string;
  job_id: string;
  kind: string;
  title: string;
  severity: string;
  confidence: number | null;
  evidence: unknown;
  asset_ref: string | null;
  status: string;
};

const FINDING_KINDS = [
  'fact',
  'indicator',
  'hypothesis',
  'validated_vuln',
  'inconclusive',
  'false_positive',
  'recommendation',
] as const;
const SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'] as const;
const FINDING_STATUSES = ['open', 'acknowledged'] as const;

const PAGE_SIZE = 20;

const severityChip: Record<string, string> = {
  critical: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  high: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400',
  medium: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  low: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  info: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
};

type EvidenceShape = {
  source?: string;
  method?: string;
  observed_at?: string;
  limitations?: string[];
  details?: Record<string, unknown>;
};

function parseEvidence(evidence: unknown): EvidenceShape | null {
  if (evidence && typeof evidence === 'object') return evidence as EvidenceShape;
  return null;
}

export default function CyberLabFindings() {
  const { t } = useI18n();
  const { hasPermission } = useAuth();
  const canManage = hasPermission('cyberlab.manage');

  const [kind, setKind] = useState('');
  const [severity, setSeverity] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const params = useMemo(() => {
    const p: Record<string, string> = { limit: String(PAGE_SIZE), offset: String((page - 1) * PAGE_SIZE) };
    if (kind) p.kind = kind;
    if (severity) p.severity = severity;
    if (status) p.status = status;
    return p;
  }, [kind, severity, status, page]);

  const findings = useApi<{ findings: Finding[]; total: number }>('/cyberlab/findings', { params });
  const ackMutation = useApiMutation('', 'POST');

  const total = findings.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const handleAcknowledge = async (id: string) => {
    setToast(null);
    ackMutation.reset();
    // mutate() resolves to null on failure and stores the server message in
    // hook state (not readable in this closure) — always surface a localized
    // error on failure, then refetch to show the true state.
    const result = await ackMutation.mutate(`/cyberlab/findings/${id}/acknowledge`);
    if (result) {
      setToast({ type: 'success', message: t('cyberlab.findings.acknowledgedMsg') });
    } else {
      setToast({ type: 'error', message: t('cyberlab.findings.ackFailed') });
    }
    findings.refetch();
  };

  const columns = [
    {
      key: 'title',
      label: t('cyberlab.findings.findingTitle'),
      render: (row: Finding) => {
        const evidence = parseEvidence(row.evidence);
        const detailsText =
          evidence?.details && Object.keys(evidence.details).length > 0
            ? JSON.stringify(evidence.details)
            : '';
        const evidenceLine = [evidence?.source, evidence?.method, detailsText]
          .filter(Boolean)
          .join(' · ');
        return (
          <div className="max-w-md">
            <p className="text-sm font-medium text-gray-900 dark:text-white">{row.title}</p>
            {evidenceLine ? (
              <p
                className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 line-clamp-2"
                title={evidenceLine}
              >
                {evidenceLine}
              </p>
            ) : (
              <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
                {t('cyberlab.findings.noEvidence')}
              </p>
            )}
          </div>
        );
      },
    },
    {
      key: 'kind',
      label: t('cyberlab.findings.kind'),
      sortable: true,
      render: (row: Finding) => (
        <span className="text-sm text-gray-700 dark:text-gray-300">{t(`cyberlab.kind.${row.kind}`)}</span>
      ),
    },
    {
      key: 'severity',
      label: t('cyberlab.findings.severity'),
      sortable: true,
      render: (row: Finding) => (
        <span
          className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium ${
            severityChip[row.severity] || severityChip.info
          }`}
        >
          {t(`cyberlab.severity.${row.severity}`)}
        </span>
      ),
    },
    {
      key: 'confidence',
      label: t('cyberlab.findings.confidence'),
      sortable: true,
      render: (row: Finding) => (
        <span className="text-sm text-gray-700 dark:text-gray-300">
          {row.confidence !== null ? row.confidence : '—'}
        </span>
      ),
    },
    {
      key: 'status',
      label: t('common.status'),
      sortable: true,
      render: (row: Finding) => (
        <span
          className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium ${
            row.status === 'open'
              ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
              : 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-500'
          }`}
        >
          {t(`cyberlab.findingStatus.${row.status}`)}
        </span>
      ),
    },
    {
      key: 'job_id',
      label: t('cyberlab.findings.job'),
      render: (row: Finding) => (
        <Link
          to={`/cyberlab/jobs/${row.job_id}`}
          onClick={(e) => e.stopPropagation()}
          className="font-mono text-xs text-blue-600 hover:text-blue-500 dark:text-blue-400"
        >
          {row.job_id.slice(0, 8)}
        </Link>
      ),
    },
    {
      key: 'actions',
      label: t('common.actions'),
      width: '110px',
      render: (row: Finding) =>
        canManage && row.status === 'open' ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleAcknowledge(row.id);
            }}
            disabled={ackMutation.loading}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium text-gray-600 dark:text-gray-300 hover:bg-emerald-50 hover:text-emerald-700 dark:hover:bg-emerald-900/20 disabled:opacity-50 transition-colors"
            title={t('cyberlab.findings.acknowledge')}
          >
            <CheckCheck className="w-3.5 h-3.5" />
            {t('cyberlab.findings.acknowledge')}
          </button>
        ) : (
          <span className="text-xs text-gray-400">—</span>
        ),
    },
  ];

  if (findings.error && !findings.data) {
    return (
      <ErrorState error={findings.error} onRetry={findings.refetch} title={t('cyberlab.findings.failedLoad')} />
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">
          {t('cyberlab.findings.title')}
        </h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          {t('cyberlab.findings.count')}: {total}
        </p>
      </div>

      {toast && <AlertBanner type={toast.type} message={toast.message} onClose={() => setToast(null)} />}

      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
        <select
          value={kind}
          onChange={(e) => {
            setKind(e.target.value);
            setPage(1);
          }}
          className="px-3 py-2.5 text-sm bg-gray-100 dark:bg-gray-700 border border-transparent rounded-lg text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
        >
          <option value="">{t('cyberlab.findings.allKinds')}</option>
          {FINDING_KINDS.map((k) => (
            <option key={k} value={k}>
              {t(`cyberlab.kind.${k}`)}
            </option>
          ))}
        </select>
        <select
          value={severity}
          onChange={(e) => {
            setSeverity(e.target.value);
            setPage(1);
          }}
          className="px-3 py-2.5 text-sm bg-gray-100 dark:bg-gray-700 border border-transparent rounded-lg text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
        >
          <option value="">{t('cyberlab.findings.allSeverities')}</option>
          {SEVERITIES.map((s) => (
            <option key={s} value={s}>
              {t(`cyberlab.severity.${s}`)}
            </option>
          ))}
        </select>
        <select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
          className="px-3 py-2.5 text-sm bg-gray-100 dark:bg-gray-700 border border-transparent rounded-lg text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
        >
          <option value="">{t('cyberlab.findings.allStatuses')}</option>
          {FINDING_STATUSES.map((s) => (
            <option key={s} value={s}>
              {t(`cyberlab.findingStatus.${s}`)}
            </option>
          ))}
        </select>
      </div>

      {findings.loading && !findings.data ? (
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <LoadingSpinner size="sm" />
          {t('common.loading')}
        </div>
      ) : (
        <DataTable
          columns={columns}
          data={findings.data?.findings ?? []}
          emptyMessage={t('cyberlab.findings.empty')}
        />
      )}

      <Pagination currentPage={page} totalPages={totalPages} onPageChange={setPage} />
    </div>
  );
}
