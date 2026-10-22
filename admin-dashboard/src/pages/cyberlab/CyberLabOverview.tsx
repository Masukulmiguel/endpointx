import React, { useEffect, useState } from 'react';
import {
  FlaskConical,
  ListChecks,
  ShieldAlert,
  Archive,
  Clock,
} from 'lucide-react';
import { useApi } from '../../hooks/useApi';
import ErrorState from '../../components/ErrorState';
import LoadingSpinner from '../../components/LoadingSpinner';
import CyberLabStateBadge from '../../components/CyberLabStateBadge';
import { useI18n } from '../../i18n';

type ProviderStatus = {
  available: boolean;
  reason: 'not_configured' | 'probe_failed' | null;
  version: string | null;
  detail: string | null;
};

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

type CyberLabFinding = {
  id: string;
  job_id: string;
  kind: string;
  title: string;
  severity: string;
  confidence: string | null;
  evidence: unknown;
  status: string;
};

type Artifact = {
  id: string;
  sha256: string;
  original_name: string;
  size_bytes: number;
  created_at: string;
};

const JOB_STATUSES = ['queued', 'running', 'completed', 'failed', 'cancelled', 'partial'] as const;
const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;

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

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function Card({
  children,
  className = '',
  style,
}: {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div
      className={`bg-white rounded-xl border border-slate-200 p-4 shadow-sm shadow-slate-200/60 ${className}`}
      style={style}
    >
      {children}
    </div>
  );
}

function CardHeader({ icon: Icon, title }: { icon: React.ElementType; title: string }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <Icon className="w-4 h-4 text-slate-400" />
      <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
    </div>
  );
}

function InlineLoading() {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-2 text-sm text-gray-500">
      <LoadingSpinner size="sm" />
      {t('common.loading')}
    </div>
  );
}

export default function CyberLabOverview() {
  const { t, locale } = useI18n();

  const providers = useApi<ProviderStatus>('/cyberlab/providers');
  const findings = useApi<{ findings: CyberLabFinding[]; total: number }>('/cyberlab/findings', {
    params: { limit: '100' },
  });
  const artifacts = useApi<{ artifacts: Artifact[]; total: number }>('/cyberlab/artifacts', {
    params: { limit: '10' },
  });

  // Poll jobs at 5s only while something is queued/running; idle lab = no polling.
  const [pollJobs, setPollJobs] = useState(false);
  const jobs = useApi<{ jobs: Job[]; total: number }>('/cyberlab/jobs', {
    params: { limit: '100' },
    refreshInterval: pollJobs ? 5000 : undefined,
  });

  const jobList = jobs.data?.jobs ?? [];
  const hasActiveJob = jobList.some((j) => j.status === 'running' || j.status === 'queued');

  useEffect(() => {
    setPollJobs(hasActiveJob);
  }, [hasActiveJob]);

  const jobCounts = JOB_STATUSES.reduce<Record<string, number>>((acc, status) => {
    acc[status] = jobList.filter((j) => j.status === status).length;
    return acc;
  }, {});

  const findingList = findings.data?.findings ?? [];
  const severityCounts = SEVERITIES.reduce<Record<string, number>>((acc, severity) => {
    acc[severity] = findingList.filter((f) => f.severity === severity).length;
    return acc;
  }, {});

  const artifactList = artifacts.data?.artifacts ?? [];

  const provider = providers.data;
  const providerState: 'available' | 'not_configured' = provider?.available ? 'available' : 'not_configured';
  const providerReasonKey =
    provider?.reason === 'probe_failed' ? 'cyberlab.reason.probeFailed' : 'cyberlab.reason.notConfigured';

  if (providers.error && jobs.error && findings.error && artifacts.error) {
    return (
      <ErrorState
        error={providers.error}
        onRetry={providers.refetch}
        title={t('cyberlab.overview.failedLoad')}
      />
    );
  }

  return (
    <div className="space-y-6">
      <section
        aria-labelledby="cyberlab-hero-title"
        className="enter-rise relative overflow-hidden rounded-2xl bg-[#050B14] ring-1 ring-black/5"
      >
        {/* The source frame is 1200x630 with its left half deliberately empty and
            near-black: the title lives there. `object-right` keeps the analyst
            and the monitors in frame when the strip is cropped, and the
            left-to-right gradient guarantees the text contrast even if the
            image ever fails to load. */}
        <img
          src="/cyberlab-hero.png"
          alt=""
          aria-hidden="true"
          className="absolute inset-0 h-full w-full object-cover object-right"
        />
        <div className="absolute inset-0 bg-gradient-to-r from-[#050B14] via-[#050B14]/85 to-transparent" />
        <div className="relative flex min-h-[190px] max-w-[46rem] flex-col justify-center gap-3 p-6 sm:p-8">
          <div className="flex flex-wrap items-center gap-3">
            <h1
              id="cyberlab-hero-title"
              className="text-2xl font-bold tracking-tight text-white sm:text-3xl"
            >
              {t('cyberlab.overview.title')}
            </h1>
            <CyberLabStateBadge state={providerState} />
          </div>
          <p className="max-w-[34rem] text-sm text-slate-300 sm:text-base">
            {t('cyberlab.overview.heroSubtitle')}
          </p>
          {hasActiveJob && (
            <p className="flex items-center gap-1.5 text-sm text-slate-400">
              <Clock className="w-4 h-4" />
              {t('cyberlab.overview.activeRefresh')}
            </p>
          )}
        </div>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="enter-rise-fast" style={{ animationDelay: '0ms' }}>
          <CardHeader icon={FlaskConical} title={t('cyberlab.overview.engine')} />
          {providers.loading ? (
            <InlineLoading />
          ) : provider ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <CyberLabStateBadge state={providerState} />
                {provider.version && (
                  <span className="text-xs text-gray-500">
                    {t('cyberlab.overview.engineVersion')}: {provider.version}
                  </span>
                )}
              </div>
              {!provider.available && (
                <p className="text-sm text-gray-600">
                  {t(providerReasonKey)}
                  {provider.detail ? ` — ${provider.detail}` : ''}
                </p>
              )}
            </div>
          ) : (
            <p className="text-sm text-gray-500">{t('common.error')}</p>
          )}
        </Card>

        <Card className="enter-rise-fast" style={{ animationDelay: '40ms' }}>
          <CardHeader icon={ListChecks} title={t('cyberlab.overview.jobs')} />
          {jobs.loading && !jobs.data ? (
            <InlineLoading />
          ) : jobs.error && !jobs.data ? (
            <p className="text-sm text-red-500">{jobs.error}</p>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              {JOB_STATUSES.map((status) => (
                <span
                  key={status}
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${
                    jobStatusChip[status] || jobStatusChip.queued
                  }`}
                >
                  {t(`cyberlab.job.${status}`)}
                  <strong className="font-bold">{jobCounts[status] ?? 0}</strong>
                </span>
              ))}
            </div>
          )}
        </Card>

        <Card className="enter-rise-fast" style={{ animationDelay: '80ms' }}>
          <CardHeader icon={ShieldAlert} title={t('cyberlab.overview.findings')} />
          {findings.loading && !findings.data ? (
            <InlineLoading />
          ) : findings.error && !findings.data ? (
            <p className="text-sm text-red-500">{findings.error}</p>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              {SEVERITIES.map((severity) => (
                <span
                  key={severity}
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${
                    severityChip[severity] || severityChip.info
                  }`}
                >
                  {t(`cyberlab.severity.${severity}`)}
                  <strong className="font-bold">{severityCounts[severity] ?? 0}</strong>
                </span>
              ))}
            </div>
          )}
        </Card>

        <Card className="enter-rise-fast" style={{ animationDelay: '120ms' }}>
          <CardHeader icon={Archive} title={t('cyberlab.overview.recentArtifacts')} />
          {artifacts.loading && !artifacts.data ? (
            <InlineLoading />
          ) : artifacts.error && !artifacts.data ? (
            <p className="text-sm text-red-500">{artifacts.error}</p>
          ) : artifactList.length === 0 ? (
            <p className="text-sm text-gray-500">{t('cyberlab.overview.noArtifacts')}</p>
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {artifactList.map((artifact) => (
                <li key={artifact.id} className="py-2 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-slate-900 truncate">
                      {artifact.original_name}
                    </p>
                    <p className="text-xs text-slate-400 font-mono truncate">{artifact.sha256}</p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-xs font-medium text-slate-600">
                      {formatBytes(artifact.size_bytes)}
                    </p>
                    <p className="text-xs text-slate-400">
                      {new Date(artifact.created_at).toLocaleString(
                        locale === 'pt' ? 'pt-PT' : 'en-GB'
                      )}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
