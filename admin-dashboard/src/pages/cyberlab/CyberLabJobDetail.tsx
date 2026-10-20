import React, { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Download, Loader2, XCircle } from 'lucide-react';
import { useApi, useApiMutation } from '../../hooks/useApi';
import { useAuth } from '../../contexts/AuthContext';
import { useI18n } from '../../i18n';
import ErrorState from '../../components/ErrorState';
import LoadingSpinner from '../../components/LoadingSpinner';
import AlertBanner from '../../components/AlertBanner';
import api from '../../services/api';

type Job = {
  id: string;
  type: string;
  status: string;
  artifact_id: string | null;
  progress: number | null;
  cancel_requested: boolean;
  error: string | null;
  result: unknown;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

type Finding = {
  id: string;
  job_id: string;
  kind: string;
  title: string;
  severity: string;
  confidence: number | null;
  evidence: unknown;
  status: string;
};

const jobStatusChip: Record<string, string> = {
  queued: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
  running: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  completed: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  failed: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  cancelled: 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-500',
  partial: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
};

const severityChip: Record<string, string> = {
  critical: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  high: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400',
  medium: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  low: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  info: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
};

const ACTIVE_STATUSES = ['queued', 'running'];

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="bg-white dark:bg-gray-900 rounded-xl border border-slate-200 dark:border-gray-700 p-4 shadow-sm shadow-slate-200/60">
      <h3 className="text-sm font-semibold text-slate-900 dark:text-white mb-3">{title}</h3>
      {children}
    </section>
  );
}

export default function CyberLabJobDetail() {
  const { id = '' } = useParams();
  const { t, locale } = useI18n();
  const { hasPermission } = useAuth();
  const canManage = hasPermission('cyberlab.manage');
  const canExport = hasPermission('cyberlab.export');

  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [exporting, setExporting] = useState<'json' | 'csv' | null>(null);

  // Poll only while the job is still queued or running.
  const [refreshInterval, setRefreshInterval] = useState(0);
  const jobQuery = useApi<{ job: Job }>(`/cyberlab/jobs/${id}`, { refreshInterval });
  const job = jobQuery.data?.job ?? null;
  const isActive = !!job && ACTIVE_STATUSES.includes(job.status);

  useEffect(() => {
    setRefreshInterval(isActive ? 3000 : 0);
  }, [isActive]);

  // The findings API has no job filter — fetch the latest batch and filter here.
  // Poll alongside the job while it is active so a job that finishes on-screen
  // loads the findings it just produced (no false "no findings" claim).
  const findingsQuery = useApi<{ findings: Finding[]; total: number }>('/cyberlab/findings', {
    params: { limit: '100' },
    refreshInterval: refreshInterval > 0 ? refreshInterval : undefined,
  });
  const jobFindings = (findingsQuery.data?.findings ?? []).filter((f) => f.job_id === id);

  // Findings are written when the job finishes, possibly after the last
  // active poll — refetch once on the active→terminal transition.
  const wasActiveRef = useRef(isActive);
  useEffect(() => {
    if (wasActiveRef.current && !isActive) {
      findingsQuery.refetch();
    }
    wasActiveRef.current = isActive;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive]);

  const cancelMutation = useApiMutation('', 'POST');

  const handleCancel = async () => {
    setToast(null);
    cancelMutation.reset();
    // mutate() resolves to null on failure and stores the server message in
    // hook state (not readable in this closure) — surface a localized error
    // whenever the call did not succeed, then refetch to show the true state.
    const result = await cancelMutation.mutate(`/cyberlab/jobs/${id}/cancel`);
    if (result) {
      setToast({ type: 'success', message: t('cyberlab.jobDetail.cancelledMsg') });
    } else {
      setToast({ type: 'error', message: t('cyberlab.common.cancelFailed') });
    }
    jobQuery.refetch();
  };

  const handleExport = async (format: 'json' | 'csv') => {
    setToast(null);
    setExporting(format);
    try {
      const blob = await api.download(`/cyberlab/jobs/${id}/export?format=${format}`);
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `cyberlab-job-${id}.${format}`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err) {
      setToast({
        type: 'error',
        message: err instanceof Error ? `${t('cyberlab.jobDetail.exportFailed')}: ${err.message}` : t('cyberlab.jobDetail.exportFailed'),
      });
    } finally {
      setExporting(null);
    }
  };

  const formatDate = (dateStr: string | null) =>
    dateStr ? new Date(dateStr).toLocaleString(locale === 'pt' ? 'pt-PT' : 'en-GB') : '—';

  if (jobQuery.loading && !job) return <LoadingSpinner size="lg" />;
  if (jobQuery.error && !job) {
    return <ErrorState error={jobQuery.error} onRetry={jobQuery.refetch} title={t('cyberlab.jobDetail.title')} />;
  }
  if (!job) {
    return <ErrorState error={t('cyberlab.jobDetail.title')} onRetry={jobQuery.refetch} />;
  }

  const resultObj =
    job.result && typeof job.result === 'object' ? (job.result as Record<string, unknown>) : null;
  const isTruncated = resultObj?.truncated === true;
  const isPartial = job.status === 'partial';
  const summary =
    resultObj && typeof resultObj.summary === 'string' && resultObj.summary
      ? (resultObj.summary as string)
      : null;

  return (
    <div className="space-y-6">
      {toast && <AlertBanner type={toast.type} message={toast.message} onClose={() => setToast(null)} />}

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link
            to="/cyberlab/jobs"
            className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 mb-2"
          >
            <ArrowLeft className="w-4 h-4" />
            {t('cyberlab.jobDetail.back')}
          </Link>
          <h1 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">
            {t('cyberlab.jobDetail.title')}
          </h1>
          <p className="text-xs font-mono text-gray-400 mt-1">{job.id}</p>
        </div>
        <div className="flex items-center gap-2">
          {isActive && canManage && (
            <button
              onClick={handleCancel}
              disabled={cancelMutation.loading}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50"
            >
              <XCircle className="w-4 h-4" />
              {t('cyberlab.common.cancelJob')}
            </button>
          )}
          {canExport && (
            <>
              <button
                onClick={() => handleExport('json')}
                disabled={exporting !== null}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {exporting === 'json' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                {t('cyberlab.jobDetail.exportJson')}
              </button>
              <button
                onClick={() => handleExport('csv')}
                disabled={exporting !== null}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50"
              >
                {exporting === 'csv' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                {t('cyberlab.jobDetail.exportCsv')}
              </button>
            </>
          )}
        </div>
      </div>

      <div className="bg-white dark:bg-gray-900 rounded-xl border border-slate-200 dark:border-gray-700 p-4 shadow-sm shadow-slate-200/60">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium ${
              jobStatusChip[job.status] || jobStatusChip.queued
            }`}
          >
            {t(`cyberlab.job.${job.status}`)}
          </span>
          <span className="text-sm text-gray-700 dark:text-gray-300">{t(`cyberlab.type.${job.type}`)}</span>
          {(isTruncated || isPartial) && (
            <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
              {t('cyberlab.jobDetail.truncated')}
            </span>
          )}
          {job.progress !== null && (
            <span className="text-xs text-gray-500 dark:text-gray-400">
              {t('cyberlab.jobDetail.progress')}: {job.progress}%
            </span>
          )}
        </div>

        <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-gray-500 dark:text-gray-400 mt-3">
          <span>
            {t('cyberlab.jobDetail.created')}: {formatDate(job.created_at)}
          </span>
          <span>
            {t('cyberlab.jobDetail.started')}: {formatDate(job.started_at)}
          </span>
          <span>
            {t('cyberlab.jobDetail.finished')}: {formatDate(job.finished_at)}
          </span>
          <span>
            {t('cyberlab.jobDetail.artifact')}:{' '}
            {job.artifact_id ? (
              <span className="font-mono">{job.artifact_id}</span>
            ) : (
              t('cyberlab.common.none')
            )}
          </span>
        </div>

        {job.error && (
          <div className="mt-3 rounded-lg bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-700 dark:text-red-300">
            <strong className="font-semibold">{t('cyberlab.jobDetail.error')}: </strong>
            {job.error}
          </div>
        )}
      </div>

      {summary && (
        <Card title={t('cyberlab.jobDetail.summary')}>
          <p className="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap">{summary}</p>
        </Card>
      )}

      <Card title={t('cyberlab.jobDetail.result')}>
        {resultObj ? (
          <pre className="text-xs font-mono text-gray-700 dark:text-gray-300 bg-gray-50 dark:bg-gray-800/60 p-3 rounded-lg overflow-x-auto max-h-96">
            {JSON.stringify(job.result, null, 2)}
          </pre>
        ) : isActive ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">{t('cyberlab.jobDetail.noResult')}</p>
        ) : job.status === 'failed' ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">{t('cyberlab.jobDetail.noResultFailed')}</p>
        ) : job.status === 'cancelled' ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">{t('cyberlab.jobDetail.noResultCancelled')}</p>
        ) : (
          <p className="text-sm text-gray-500 dark:text-gray-400">{t('cyberlab.jobDetail.noResultCompleted')}</p>
        )}
      </Card>

      <Card title={`${t('cyberlab.jobDetail.findings')} (${jobFindings.length})`}>
        <p className="text-xs text-gray-400 dark:text-gray-500 mb-3">{t('cyberlab.jobDetail.findingsNote')}</p>
        {findingsQuery.loading && !findingsQuery.data ? (
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <LoadingSpinner size="sm" />
            {t('common.loading')}
          </div>
        ) : jobFindings.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {isActive ? t('cyberlab.jobDetail.findingsPending') : t('cyberlab.jobDetail.noFindings')}
          </p>
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {jobFindings.map((finding) => (
              <li key={finding.id} className="py-2 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-900 dark:text-white">{finding.title}</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                    {t(`cyberlab.kind.${finding.kind}`)} · {t(`cyberlab.findingStatus.${finding.status}`)}
                  </p>
                </div>
                <span
                  className={`shrink-0 inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium ${
                    severityChip[finding.severity] || severityChip.info
                  }`}
                >
                  {t(`cyberlab.severity.${finding.severity}`)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
