import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Clock, Eye, FileUp, Loader2, XCircle } from 'lucide-react';
import { useApi, useApiMutation } from '../../hooks/useApi';
import { useAuth } from '../../contexts/AuthContext';
import { useI18n } from '../../i18n';
import DataTable from '../../components/DataTable';
import AlertBanner from '../../components/AlertBanner';
import ErrorState from '../../components/ErrorState';
import LoadingSpinner from '../../components/LoadingSpinner';

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

const JOB_TYPES = ['js_analysis', 'go_binary', 'rust_binary'] as const;

const jobStatusChip: Record<string, string> = {
  queued: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
  running: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  completed: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  failed: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  cancelled: 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-500',
  partial: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
};

const ACTIVE_STATUSES = ['queued', 'running'];

function readFileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

export default function CyberLabJobs() {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const canManage = hasPermission('cyberlab.manage');

  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Poll jobs at 3s only while something is queued/running; idle lab = no polling.
  const [pollJobs, setPollJobs] = useState(false);
  const jobs = useApi<{ jobs: Job[]; total: number }>('/cyberlab/jobs', {
    params: { limit: '50' },
    refreshInterval: pollJobs ? 3000 : undefined,
  });

  const jobList = jobs.data?.jobs ?? [];
  const hasActiveJob = jobList.some((j) => ACTIVE_STATUSES.includes(j.status));

  useEffect(() => {
    setPollJobs(hasActiveJob);
  }, [hasActiveJob]);

  const artifactMutation = useApiMutation<{ artifact: { id: string } }>('/cyberlab/artifacts', 'POST');
  const jobMutation = useApiMutation<{ job: Job; started: boolean }>('/cyberlab/jobs', 'POST');
  const cancelMutation = useApiMutation('', 'POST');

  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [type, setType] = useState<string>('js_analysis');

  const rawError = jobMutation.error || artifactMutation.error;
  const createError = rawError ? mapCreateError(rawError, t) : null;
  const creating = artifactMutation.loading || jobMutation.loading;

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!file || creating) return;
    setToast(null);
    artifactMutation.reset();
    jobMutation.reset();
    try {
      const contentBase64 = await readFileBase64(file);
      const artifactRes = await artifactMutation.mutate({
        name: name.trim() || file.name,
        contentBase64,
      });
      if (!artifactRes?.artifact?.id) return;
      const jobRes = await jobMutation.mutate({ type, artifactId: artifactRes.artifact.id });
      if (!jobRes?.job) return;
      setFile(null);
      setName('');
      setToast({ type: 'success', message: t('cyberlab.jobs.created') });
      jobs.refetch();
    } catch {
      // readFileBase64 failures surface through the mutation error path on
      // submit; a local read failure gets the generic create-failed message.
      setToast({ type: 'error', message: t('cyberlab.jobs.failedCreate') });
    }
  };

  const handleCancel = async (id: string) => {
    setToast(null);
    cancelMutation.reset();
    const result = await cancelMutation.mutate(`/cyberlab/jobs/${id}/cancel`);
    if (result) {
      setToast({ type: 'success', message: t('cyberlab.jobDetail.cancelledMsg') });
    } else if (cancelMutation.error) {
      setToast({ type: 'error', message: cancelMutation.error });
    }
    jobs.refetch();
  };

  const formatDate = (dateStr: string) =>
    new Date(dateStr).toLocaleString(locale === 'pt' ? 'pt-PT' : 'en-GB');

  const columns = [
    {
      key: 'type',
      label: t('cyberlab.jobs.type'),
      sortable: true,
      render: (row: Job) => <span className="text-sm">{t(`cyberlab.type.${row.type}`)}</span>,
    },
    {
      key: 'status',
      label: t('common.status'),
      sortable: true,
      render: (row: Job) => (
        <div className="flex flex-wrap items-center gap-1.5">
          <span
            className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium ${
              jobStatusChip[row.status] || jobStatusChip.queued
            }`}
          >
            {t(`cyberlab.job.${row.status}`)}
          </span>
          {row.cancel_requested && ACTIVE_STATUSES.includes(row.status) && (
            <span className="text-xs text-amber-600 dark:text-amber-400">
              {t('cyberlab.common.cancelRequested')}
            </span>
          )}
        </div>
      ),
    },
    {
      key: 'created_at',
      label: t('cyberlab.jobDetail.created'),
      sortable: true,
      render: (row: Job) => (
        <span className="text-xs font-mono text-gray-500 dark:text-gray-400">
          {formatDate(row.created_at)}
        </span>
      ),
    },
    {
      key: 'actions',
      label: t('common.actions'),
      width: '90px',
      render: (row: Job) => (
        <div className="flex items-center gap-1">
          <button
            onClick={(e) => {
              e.stopPropagation();
              navigate(`/cyberlab/jobs/${row.id}`);
            }}
            className="p-1.5 rounded-md text-gray-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors"
            title={t('common.view')}
          >
            <Eye className="w-4 h-4" />
          </button>
          {canManage && ACTIVE_STATUSES.includes(row.status) && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleCancel(row.id);
              }}
              className="p-1.5 rounded-md text-gray-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
              title={t('cyberlab.common.cancelJob')}
            >
              <XCircle className="w-4 h-4" />
            </button>
          )}
        </div>
      ),
    },
  ];

  if (jobs.error && !jobs.data) {
    return <ErrorState error={jobs.error} onRetry={jobs.refetch} title={t('cyberlab.jobs.failedLoad')} />;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">
          {t('cyberlab.jobs.title')}
        </h1>
        {hasActiveJob && (
          <p className="flex items-center gap-1.5 text-sm text-gray-500 dark:text-gray-400">
            <Clock className="w-4 h-4" />
            {t('cyberlab.jobs.activeRefresh')}
          </p>
        )}
      </div>

      {toast && <AlertBanner type={toast.type} message={toast.message} onClose={() => setToast(null)} />}
      {createError && <AlertBanner type="error" message={createError} onClose={() => {}} />}

      {canManage && (
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-slate-200 dark:border-gray-700 p-4 shadow-sm shadow-slate-200/60">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-white mb-3">
            {t('cyberlab.jobs.newJob')}
          </h2>
          <form onSubmit={handleSubmit} className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
            <div>
              <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                {t('cyberlab.jobs.file')}
              </label>
              <input
                type="file"
                onChange={(e) => {
                  const selected = e.target.files?.[0] ?? null;
                  setFile(selected);
                  if (selected && !name) setName(selected.name);
                }}
                className="block w-full text-sm text-gray-600 dark:text-gray-300 file:mr-3 file:px-3 file:py-2 file:rounded-lg file:border-0 file:bg-slate-100 dark:file:bg-slate-800 file:text-sm file:text-gray-700 dark:file:text-gray-300"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                {t('cyberlab.jobs.name')}
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={file ? file.name : t('cyberlab.jobs.selectFile')}
                className="w-full px-3 py-2 text-sm bg-gray-100 dark:bg-gray-800 border border-transparent rounded-lg text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
              />
            </div>
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                  {t('cyberlab.jobs.type')}
                </label>
                <select
                  value={type}
                  onChange={(e) => setType(e.target.value)}
                  className="w-full px-3 py-2 text-sm bg-gray-100 dark:bg-gray-800 border border-transparent rounded-lg text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
                >
                  {JOB_TYPES.map((jobType) => (
                    <option key={jobType} value={jobType}>
                      {t(`cyberlab.type.${jobType}`)}
                    </option>
                  ))}
                </select>
              </div>
              <button
                type="submit"
                disabled={!file || creating}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileUp className="w-4 h-4" />}
                {creating ? t('cyberlab.jobs.creating') : t('cyberlab.jobs.submit')}
              </button>
            </div>
          </form>
        </div>
      )}

      {jobs.loading && !jobs.data ? (
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <LoadingSpinner size="sm" />
          {t('common.loading')}
        </div>
      ) : (
        <DataTable
          columns={columns}
          data={jobList}
          emptyMessage={t('cyberlab.jobs.empty')}
          onRowClick={(row) => navigate(`/cyberlab/jobs/${row.id}`)}
        />
      )}
    </div>
  );
}

// Honest mapping of the backend's failure modes: the engine gate and the
// size/type rejections get clear local messages; everything else shows the
// server's own message verbatim.
function mapCreateError(message: string, t: (key: string) => string): string {
  if (/Engine provider is not available/i.test(message)) return t('cyberlab.jobs.engineNotConfigured');
  if (/exceeds the maximum size/i.test(message)) return t('cyberlab.jobs.uploadTooLarge');
  if (/Unsupported|UNSUPPORTED/i.test(message)) return t('cyberlab.jobs.invalidType');
  return message;
}
