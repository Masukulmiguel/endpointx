import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Download, Loader2, XCircle, ShieldCheck, FileText, ListTree } from 'lucide-react';
import { useApi, useApiMutation } from '../hooks/useApi';
import { useAuth } from '../contexts/AuthContext';
import { useI18n } from '../i18n';
import ErrorState from '../components/ErrorState';
import LoadingSpinner from '../components/LoadingSpinner';
import StatusBadge from '../components/StatusBadge';
import AlertBanner from '../components/AlertBanner';
import api from '../services/api';

type Investigation = {
  id: string;
  status: string;
  risk: string;
  confidence: string;
  summary: string | null;
  error_message: string | null;
  started_at: string | null;
  collected_at: string | null;
  completed_at: string | null;
  hostname?: string | null;
  ip_address?: string | null;
  alert_id?: string | null;
  alert_title?: string | null;
  alert_severity?: string | null;
  alert_type?: string | null;
  stats?: Record<string, any>;
  report?: Record<string, any>;
};

const STATUS_STYLE: Record<string, string> = {
  queued: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300',
  collecting: 'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  analyzing: 'bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  complete: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  failed: 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  cancelled: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
};

const ACTIVE = ['queued', 'collecting', 'analyzing'];

function Card({ title, children, className = '' }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3 uppercase tracking-wide">{title}</h3>
      {children}
    </section>
  );
}

function StringList({ items }: { items: any[] }) {
  const { t } = useI18n();
  if (!Array.isArray(items) || items.length === 0) {
    return <p className="text-sm text-gray-500 dark:text-gray-400">{t('hermes.invest.emptyList')}</p>;
  }
  return (
    <ul className="space-y-2">
      {items.map((item, index) => (
        <li key={index} className="text-sm text-gray-700 dark:text-gray-300">
          {String(item)}
        </li>
      ))}
    </ul>
  );
}

function StatementList({
  items,
  showSource = true,
}: {
  items: { title?: string; detail?: string; source?: string; confidence?: string; severity?: string; from?: string; to?: string; relation?: string; basis?: string }[];
  showSource?: boolean;
}) {
  const { t } = useI18n();
  if (!Array.isArray(items) || items.length === 0) {
    return <p className="text-sm text-gray-500 dark:text-gray-400">{t('hermes.invest.emptyList')}</p>;
  }
  return (
    <ul className="space-y-3">
      {items.map((item, index) => (
        <li key={index} className="rounded-lg bg-gray-50 dark:bg-gray-800/60 p-3">
          <p className="text-sm font-medium text-gray-900 dark:text-white">
            {item.title || `${item.from} — ${item.relation} → ${item.to}`}
          </p>
          <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">{item.detail || item.basis}</p>
          {showSource && (item.source || item.confidence || item.severity) && (
            <p className="text-xs text-gray-400 mt-1.5">
              {[item.source, item.severity, item.confidence].filter(Boolean).join(' · ')}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

export default function InvestigationPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { t } = useI18n();
  const { hasPermission } = useAuth();
  const canManage = hasPermission('hermes.manage');

  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [downloading, setDownloading] = useState(false);

  // Polling only while the agent is still collecting or the engine is analyzing.
  const [refreshInterval, setRefreshInterval] = useState(0);
  const { data, loading, error, refetch } = useApi<{ investigation: Investigation }>(
    `/hermes/investigations/${id}`,
    { refreshInterval }
  );
  const current = data?.investigation || null;
  const status = current?.status || '';
  const isActive = ACTIVE.includes(status);
  const report = current?.report || {};

  useEffect(() => {
    setRefreshInterval(ACTIVE.includes(status) ? 4000 : 0);
  }, [status]);

  const { loading: cancelling, mutate: cancelInvestigation } = useApiMutation('', 'POST');

  const handleCancel = async () => {
    const result = await cancelInvestigation(`/hermes/investigations/${id}/cancel`);
    if (result) {
      setToast({ type: 'success', message: t('hermes.invest.cancelledMsg') });
      refetch();
    }
  };

  const handleDownload = async () => {
    setDownloading(true);
    try {
      const blob = await api.downloadInvestigationReport(id);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `hermes-investigation-${id}.md`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setToast({ type: 'error', message: err instanceof Error ? err.message : t('common.error') });
    } finally {
      setDownloading(false);
    }
  };

  if (loading && !current) return <LoadingSpinner size="lg" />;
  if (error && !current) return <ErrorState error={error} onRetry={refetch} title={t('hermes.invest.title')} />;
  if (!current) return <ErrorState error={t('hermes.invest.title')} onRetry={refetch} />;

  const stats = current.stats || {};
  const custody = report.chain_of_custody || {};

  return (
    <div className="space-y-6">
      {toast && <AlertBanner type={toast.type} message={toast.message} onClose={() => setToast(null)} />}

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <button
            onClick={() => navigate(-1)}
            className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 mb-2"
          >
            <ArrowLeft className="w-4 h-4" />
            {t('nav.dashboard')}
          </button>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">{t('hermes.invest.title')}</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{t('hermes.invest.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          {isActive && canManage && (
            <button
              onClick={handleCancel}
              disabled={cancelling}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50"
            >
              <XCircle className="w-4 h-4" />
              {t('hermes.invest.cancel')}
            </button>
          )}
          {current.status === 'complete' && (
            <button
              onClick={handleDownload}
              disabled={downloading}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-500 rounded-lg disabled:opacity-50"
            >
              {downloading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
              {t('hermes.invest.download')}
            </button>
          )}
        </div>
      </div>

      <div className="card">
        <div className="flex flex-wrap items-center gap-3">
          <span
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${
              STATUS_STYLE[current.status] || STATUS_STYLE.queued
            }`}
          >
            {isActive && <Loader2 className="w-3 h-3 animate-spin" />}
            {(() => {
              const key = `hermes.invest.status.${current.status}`;
              const label = t(key);
              return label === key ? current.status : label;
            })()}
          </span>
          <StatusBadge status={(current.risk || 'info') as any} />
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {t('hermes.invest.confidence')}: {current.confidence || 'low'}
          </span>
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {current.hostname || t('common.unknown')} {current.ip_address ? `· ${current.ip_address}` : ''}
          </span>
          <span className="text-xs text-gray-400">{current.id}</span>
        </div>

        <p className="text-xs text-gray-500 dark:text-gray-400 mt-3 inline-flex items-start gap-1.5">
          <ShieldCheck className="w-4 h-4 shrink-0 text-emerald-500" />
          {t('hermes.invest.readOnly')}
        </p>

        {current.alert_title && (
          <p className="text-sm text-gray-700 dark:text-gray-300 mt-3">
            <span className="text-gray-500 dark:text-gray-400">{t('hermes.invest.alert')}: </span>
            {current.alert_title}
            {current.alert_severity ? ` (${current.alert_severity})` : ''}
          </p>
        )}

        <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-gray-500 dark:text-gray-400 mt-3">
          <span>
            {t('hermes.invest.startedAt')}: {current.started_at ? new Date(current.started_at).toLocaleString() : '-'}
          </span>
          <span>
            {t('hermes.invest.collectedAt')}:{' '}
            {current.collected_at ? new Date(current.collected_at).toLocaleString() : '-'}
          </span>
          <span>
            {t('hermes.invest.completedAt')}:{' '}
            {current.completed_at ? new Date(current.completed_at).toLocaleString() : '-'}
          </span>
        </div>

        {current.error_message && (
          <div className="mt-3 rounded-lg bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-700 dark:text-red-300">
            {current.error_message}
          </div>
        )}

        {isActive && (
          <p className="mt-3 text-sm text-blue-600 dark:text-blue-400 inline-flex items-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" />
            {current.status === 'analyzing' ? t('hermes.invest.analyzing') : t('hermes.invest.collecting')}
          </p>
        )}
      </div>

      {current.status === 'complete' && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
            {[
              [t('hermes.invest.artifacts'), stats.artifacts],
              [t('hermes.invest.evidence'), stats.evidence],
              [t('hermes.invest.indicators'), stats.indicators],
              [t('hermes.invest.iocs'), stats.iocs],
              [t('hermes.invest.timeline'), stats.timeline],
              [t('hermes.invest.gaps'), stats.gaps],
              [t('hermes.invest.lateral'), stats.lateral_matches],
            ].map(([label, value]) => (
              <div key={String(label)} className="rounded-lg bg-gray-50 dark:bg-gray-800/60 p-3 text-center">
                <p className="text-xs text-gray-500 dark:text-gray-400">{label}</p>
                <p className="text-lg font-semibold text-gray-900 dark:text-white">{value ?? 0}</p>
              </div>
            ))}
          </div>

          <Card title={t('hermes.invest.summary')}>
            <p className="text-sm text-gray-700 dark:text-gray-300">
              {report.executive_summary || current.summary || t('hermes.invest.emptyList')}
            </p>
          </Card>

          <div className="grid lg:grid-cols-2 gap-6">
            <Card title={t('hermes.invest.evidenceChain')}>
              <ol className="space-y-2">
                {(report.evidence_chain || []).map((step: string, index: number) => (
                  <li key={index} className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-300">
                    <ListTree className="w-4 h-4 mt-0.5 shrink-0 text-blue-500" />
                    <span className="break-all">{step}</span>
                  </li>
                ))}
              </ol>
            </Card>

            <Card title={t('hermes.invest.custody')}>
              <dl className="space-y-2 text-sm">
                <div className="flex justify-between gap-3">
                  <dt className="text-gray-500 dark:text-gray-400">{t('hermes.invest.collectedBy')}</dt>
                  <dd className="text-gray-700 dark:text-gray-300 text-right">{custody.collected_by || '-'}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-gray-500 dark:text-gray-400">{t('hermes.invest.collectedAt')}</dt>
                  <dd className="text-gray-700 dark:text-gray-300 text-right">
                    {custody.collected_at ? new Date(custody.collected_at).toLocaleString() : '-'}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-gray-500 dark:text-gray-400">{t('hermes.invest.analyzedAt')}</dt>
                  <dd className="text-gray-700 dark:text-gray-300 text-right">
                    {custody.analyzed_at ? new Date(custody.analyzed_at).toLocaleString() : '-'}
                  </dd>
                </div>
                <div className="pt-2 border-t border-gray-100 dark:border-gray-700">
                  <dt className="text-gray-500 dark:text-gray-400">{t('hermes.invest.notes')}</dt>
                  <dd className="text-gray-700 dark:text-gray-300 mt-1">{custody.notes || '-'}</dd>
                </div>
              </dl>
            </Card>
          </div>

          <div className="grid lg:grid-cols-2 gap-6">
            <Card title={`${t('hermes.invest.evidence')} (${(report.evidence || []).length})`}>
              <StatementList items={report.evidence || []} />
            </Card>
            <Card title={`${t('hermes.invest.indicators')} (${(report.indicators || []).length})`}>
              <StatementList items={report.indicators || []} />
            </Card>
            <Card title={`${t('hermes.invest.correlations')} (${(report.correlations || []).length})`}>
              <StatementList items={report.correlations || []} showSource={false} />
            </Card>
            <Card title={`${t('hermes.invest.hypotheses')} (${(report.hypotheses || []).length})`}>
              <StatementList items={report.hypotheses || []} showSource={false} />
            </Card>
          </div>

          <Card title={`${t('hermes.invest.iocs')} (${(report.iocs || []).length})`}>
            {(report.iocs || []).length === 0 ? (
              <p className="text-sm text-gray-500 dark:text-gray-400">{t('hermes.invest.emptyList')}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
                      <th className="py-2 pr-4 font-medium">{t('hermes.invest.iocType')}</th>
                      <th className="py-2 pr-4 font-medium">{t('hermes.invest.value')}</th>
                      <th className="py-2 pr-4 font-medium">{t('hermes.invest.context')}</th>
                      <th className="py-2 font-medium">{t('hermes.invest.confidence')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(report.iocs || []).map((ioc: any, index: number) => (
                      <tr key={`${ioc.value}-${index}`} className="table-row">
                        <td className="py-2 pr-4 text-gray-500 dark:text-gray-400">{ioc.type}</td>
                        <td className="py-2 pr-4 font-mono text-xs text-gray-800 dark:text-gray-200 break-all">
                          {ioc.value}
                        </td>
                        <td className="py-2 pr-4 text-gray-600 dark:text-gray-400 break-all">{ioc.label}</td>
                        <td className="py-2 text-gray-600 dark:text-gray-400">{ioc.confidence}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card title={`${t('hermes.invest.timeline')} (${(report.timeline || []).length})`}>
            {(report.timeline || []).length === 0 ? (
              <p className="text-sm text-gray-500 dark:text-gray-400">{t('hermes.invest.emptyList')}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
                      <th className="py-2 pr-4 font-medium">{t('hermes.invest.when')}</th>
                      <th className="py-2 pr-4 font-medium">{t('hermes.invest.event')}</th>
                      <th className="py-2 pr-4 font-medium">{t('hermes.invest.entity')}</th>
                      <th className="py-2 font-medium">{t('hermes.invest.evidenceCol')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(report.timeline || []).map((entry: any, index: number) => (
                      <tr key={index} className="table-row">
                        <td className="py-2 pr-4 text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">
                          {entry.occurred_at ? new Date(entry.occurred_at).toLocaleString() : '-'}
                        </td>
                        <td className="py-2 pr-4 text-gray-800 dark:text-gray-200">{entry.event}</td>
                        <td className="py-2 pr-4 text-gray-600 dark:text-gray-400 break-all">{entry.entity}</td>
                        <td className="py-2 text-gray-600 dark:text-gray-400 break-all">{entry.evidence}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <div className="grid lg:grid-cols-2 gap-6">
            <Card title={t('hermes.invest.lateral')}>
              {(report.lateral_movement || []).length === 0 ? (
                <p className="text-sm text-gray-500 dark:text-gray-400">{t('hermes.invest.lateralNone')}</p>
              ) : (
                <ul className="space-y-2">
                  {(report.lateral_movement || []).map((match: any, index: number) => (
                    <li key={index} className="rounded-lg bg-gray-50 dark:bg-gray-800/60 p-3 text-sm">
                      <p className="font-mono text-xs text-gray-800 dark:text-gray-200 break-all">{match.value}</p>
                      <p className="text-gray-600 dark:text-gray-400 mt-1">
                        {match.ioc_type} · {match.endpoint_count} endpoint(s)
                      </p>
                      <p className="text-xs text-gray-400 mt-1 break-all">
                        {(match.devices || []).join(', ')}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card title={t('hermes.invest.gaps')}>
              {(report.gaps || []).length === 0 ? (
                <p className="text-sm text-gray-500 dark:text-gray-400">{t('hermes.invest.emptyList')}</p>
              ) : (
                <ul className="space-y-2">
                  {(report.gaps || []).map((gap: any, index: number) => (
                    <li key={index} className="flex items-center justify-between gap-3 text-sm">
                      <span className="text-gray-700 dark:text-gray-300">{gap.section}</span>
                      <span className="text-xs text-gray-500 dark:text-gray-400 text-right">{gap.reason}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          <div className="grid lg:grid-cols-2 gap-6">
            <Card title={t('hermes.invest.recommendations')}>
              <StringList items={report.recommendations || []} />
            </Card>

            <Card title={t('hermes.invest.containment')}>
              <ul className="space-y-2">
                {(report.containment_options || []).map((option: any) => (
                  <li key={option.action} className="flex items-start gap-2 text-sm">
                    <span className="font-mono text-xs text-gray-500 dark:text-gray-400 mt-0.5">{option.action}</span>
                    <span className="text-gray-700 dark:text-gray-300">{option.label}</span>
                  </li>
                ))}
              </ul>
            </Card>
          </div>

          <Card title={t('hermes.invest.sections')}>
            <div className="flex flex-wrap gap-2">
              {['processes', 'connections', 'files', 'persistence', 'browser', 'events', 'users'].map((section) => {
                const gap = (report.gaps || []).find((g: any) => g.section === section);
                return (
                  <span
                    key={section}
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${
                      gap
                        ? 'bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                        : 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
                    }`}
                    title={gap ? gap.reason : undefined}
                  >
                    <FileText className="w-3 h-3" />
                    {section}
                    {gap ? ` · ${gap.reason}` : ''}
                  </span>
                );
              })}
            </div>
          </Card>
        </>
      )}

      {isActive && (
        <div className="flex justify-center py-6">
          <Link
            to="/alerts"
            className="text-sm text-blue-600 hover:text-blue-500 dark:text-blue-400"
          >
            {t('nav.alerts')}
          </Link>
        </div>
      )}
    </div>
  );
}
