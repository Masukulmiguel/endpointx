import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Archive, ExternalLink, Info } from 'lucide-react';
import { useApi } from '../../hooks/useApi';
import { useI18n } from '../../i18n';
import DataTable from '../../components/DataTable';
import Pagination from '../../components/Pagination';
import AlertBanner from '../../components/AlertBanner';
import ErrorState from '../../components/ErrorState';
import LoadingSpinner from '../../components/LoadingSpinner';

type Artifact = {
  id: string;
  sha256: string;
  original_name: string;
  size_bytes: number;
  created_at: string;
  // The exact number of jobs that reference this artifact, counted by the
  // database. It is not a client-side guess over a window of recent jobs.
  job_count: number;
};

type Job = {
  id: string;
  type: string;
  status: string;
  artifact_id: string | null;
};

const PAGE_SIZE = 20;

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

export default function CyberLabEvidence() {
  const { t, locale } = useI18n();
  const [page, setPage] = useState(1);

  const params = useMemo(
    () => ({ limit: String(PAGE_SIZE), offset: String((page - 1) * PAGE_SIZE) }),
    [page]
  );
  const artifacts = useApi<{ artifacts: Artifact[]; total: number }>('/cyberlab/artifacts', { params });

  // Jobs are the only link from an artifact to its analysis. The count comes
  // from the database (job_count on the artifact row); this list only adds
  // the deep links for the jobs that fall inside the loaded window.
  const jobs = useApi<{ jobs: Job[]; total: number }>('/cyberlab/jobs', { params: { limit: '100' } });

  const jobsByArtifact = useMemo(() => {
    const map = new Map<string, Job[]>();
    for (const job of jobs.data?.jobs ?? []) {
      if (!job.artifact_id) continue;
      const list = map.get(job.artifact_id) ?? [];
      list.push(job);
      map.set(job.artifact_id, list);
    }
    return map;
  }, [jobs.data]);

  const total = artifacts.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const formatDate = (dateStr: string) =>
    new Date(dateStr).toLocaleString(locale === 'pt' ? 'pt-PT' : 'en-GB');

  const columns = [
    {
      key: 'original_name',
      label: t('cyberlab.evidence.name'),
      sortable: true,
      render: (row: Artifact) => (
        <div className="flex items-center gap-2 min-w-0">
          <Archive className="w-4 h-4 shrink-0 text-slate-400" />
          <span className="text-sm font-medium text-gray-900 dark:text-white truncate">
            {row.original_name}
          </span>
        </div>
      ),
    },
    {
      key: 'sha256',
      label: t('cyberlab.evidence.sha256'),
      render: (row: Artifact) => (
        <span className="font-mono text-xs text-gray-500 dark:text-gray-400" title={row.sha256}>
          {row.sha256.slice(0, 16)}…
        </span>
      ),
    },
    {
      key: 'size_bytes',
      label: t('cyberlab.evidence.size'),
      sortable: true,
      render: (row: Artifact) => (
        <span className="text-sm text-gray-700 dark:text-gray-300">{formatBytes(row.size_bytes)}</span>
      ),
    },
    {
      key: 'created_at',
      label: t('cyberlab.evidence.created'),
      sortable: true,
      render: (row: Artifact) => (
        <span className="text-xs font-mono text-gray-500 dark:text-gray-400">
          {formatDate(row.created_at)}
        </span>
      ),
    },
    {
      key: 'jobs',
      label: t('cyberlab.evidence.jobs'),
      render: (row: Artifact) => {
        // The count is the database's answer: exact and complete. The links
        // below are only the jobs inside the loaded window, so they are a
        // subset of that count — the page used to derive the count from the
        // same window and then state "no known jobs" for everything outside
        // it, which is a claim the page could not support.
        const count = row.job_count ?? 0;
        if (count === 0) {
          return <span className="text-xs text-gray-400 dark:text-gray-500">{t('cyberlab.evidence.noJobs')}</span>;
        }
        const linked = jobsByArtifact.get(row.id) ?? [];
        return (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs font-medium text-gray-600 dark:text-gray-300">{count}</span>
            {linked.map((job) => (
              <Link
                key={job.id}
                to={`/cyberlab/jobs/${job.id}`}
                onClick={(e) => e.stopPropagation()}
                className="inline-flex items-center gap-1 font-mono text-xs text-blue-600 hover:text-blue-500 dark:text-blue-400"
                title={t(`cyberlab.job.${job.status}`)}
              >
                {job.id.slice(0, 8)}
                <ExternalLink className="w-3 h-3" />
              </Link>
            ))}
          </div>
        );
      },
    },
  ];

  if (artifacts.error && !artifacts.data) {
    return (
      <ErrorState
        error={artifacts.error}
        onRetry={artifacts.refetch}
        title={t('cyberlab.evidence.failedLoad')}
      />
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">
          {t('cyberlab.evidence.title')}
        </h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          {t('cyberlab.evidence.subtitle')}
        </p>
      </div>

      <div className="flex items-start gap-3 px-4 py-3 rounded-lg border-l-4 border-l-blue-500 bg-blue-50 dark:bg-blue-900/20">
        <Info className="w-5 h-5 flex-shrink-0 text-blue-500 mt-0.5" />
        <p className="text-sm font-medium text-blue-800 dark:text-blue-300">
          {t('cyberlab.evidence.exportNote')}{' '}
          <Link to="/cyberlab/jobs" className="underline hover:text-blue-600 dark:hover:text-blue-200">
            {t('cyberlab.evidence.viewJobs')}
          </Link>
        </p>
      </div>

      {jobs.error && (
        <AlertBanner type="error" message={jobs.error} onClose={jobs.refetch} />
      )}

      {artifacts.loading && !artifacts.data ? (
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <LoadingSpinner size="sm" />
          {t('common.loading')}
        </div>
      ) : (
        <DataTable
          columns={columns}
          data={artifacts.data?.artifacts ?? []}
          emptyMessage={t('cyberlab.evidence.empty')}
        />
      )}

      <Pagination currentPage={page} totalPages={totalPages} onPageChange={setPage} />
    </div>
  );
}
