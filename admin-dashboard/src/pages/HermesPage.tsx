import React, { useState } from 'react';
import {
  Radar,
  Play,
  Square,
  ShieldAlert,
  Server,
  Bug,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Activity,
  FileText,
  Sparkles,
} from 'lucide-react';
import { useApi, useApiMutation } from '../hooks/useApi';
import ErrorState from '../components/ErrorState';
import LoadingSpinner from '../components/LoadingSpinner';
import { useI18n } from '../i18n';

type HermesStatus = {
  assets: number;
  authorized_assets: number;
  unknown_assets: number;
  vulnerabilities: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
  security_score: number;
  open_alerts: number;
  pending_recommendations: number;
  scan_stats: Record<string, number>;
  active_scans: Array<{ id: string; scan_type: string; status: string; started_at?: string }>;
  top_findings: Array<{
    id: string;
    title: string;
    severity: string;
    confidence: number;
    is_potential: boolean;
    cve_id?: string;
    hostname?: string;
    ip_address?: string;
  }>;
  emergency_stop: boolean;
};

type Finding = {
  id: string;
  title: string;
  severity: string;
  description?: string;
  confidence: number;
  is_potential: boolean;
  cve_id?: string;
  evidence?: any;
  hostname?: string;
  ip_address?: string;
  risk_score?: number;
};

type Recommendation = {
  id: string;
  title: string;
  description?: string;
  status: string;
  hostname?: string;
};

type Scan = {
  id: string;
  scan_type: string;
  status: string;
  started_at?: string;
  completed_at?: string;
  stats?: any;
};

type Asset = {
  id: string;
  hostname?: string;
  ip_address?: string;
  is_authorized: boolean;
  posture_score: number;
  last_score?: number;
  last_grade?: string;
};

const severityBadge = (s: string) => {
  switch (s) {
    case 'critical':
      return 'bg-red-500/20 text-red-400 border border-red-500/30';
    case 'high':
      return 'bg-orange-500/20 text-orange-400 border border-orange-500/30';
    case 'medium':
      return 'bg-amber-500/20 text-amber-400 border border-amber-500/30';
    case 'low':
      return 'bg-blue-500/20 text-blue-400 border border-blue-500/30';
    default:
      return 'bg-gray-500/20 text-gray-400 border border-gray-500/30';
  }
};

const attackSurfaceLabels: Record<string, string> = {
  total_assets: 'hermes.attackSurface.totalAssets',
  assets: 'hermes.attackSurface.totalAssets',
  open_ports: 'hermes.attackSurface.openPorts',
  high_risk_services: 'hermes.attackSurface.highRiskServices',
  unknown_assets: 'hermes.attackSurface.unknownAssets',
  internet_exposed: 'hermes.attackSurface.internetExposed',
  critical: 'hermes.attackSurface.criticalFindings',
  critical_findings: 'hermes.attackSurface.criticalFindings',
};

function formatScanStats(stats: any, status: string, t: (key: string) => string): React.ReactNode {
  if (status === 'pending') return <span className="text-gray-500">{t('hermes.scanResult.pending')}</span>;
  if (status === 'running') return <span className="text-blue-500">{t('hermes.scanResult.running')}</span>;
  if (status === 'failed') return <span className="text-red-500">{t('hermes.scanResult.failed')}</span>;
  if (status === 'stopped') return <span className="text-amber-500">{t('hermes.scanResult.stopped')}</span>;

  if (!stats || typeof stats !== 'object') {
    return <span className="text-gray-500">{t('hermes.scanResult.noStats')}</span>;
  }

  const assets = Number(stats.assets ?? stats.assetsScanned ?? 0);
  const ports = Number(stats.ports_found ?? stats.portsFound ?? 0);
  const services = Number(stats.services_found ?? stats.servicesFound ?? 0);

  const lines: React.ReactNode[] = [];
  lines.push(
    <span key="assets" className="block">
      <strong className="text-gray-900 dark:text-white">{assets}</strong> {t('hermes.scanResult.devices')}
    </span>
  );
  lines.push(
    <span key="ports" className="block">
      <strong className="text-gray-900 dark:text-white">{ports}</strong>{' '}
      {ports === 0 ? t('hermes.scanResult.nonePorts') : t('hermes.scanResult.ports')}
    </span>
  );
  lines.push(
    <span key="services" className="block">
      <strong className="text-gray-900 dark:text-white">{services}</strong>{' '}
      {services === 0 ? t('hermes.scanResult.noneServices') : t('hermes.scanResult.services')}
    </span>
  );

  return <div className="space-y-0.5 leading-snug">{lines}</div>;
}

function formatEvidence(evidence: any, t: (key: string) => string): React.ReactNode {
  if (evidence == null || (typeof evidence === 'object' && !Array.isArray(evidence) && Object.keys(evidence).length === 0)) {
    return <span className="text-gray-500 italic">{t('hermes.evidenceNone')}</span>;
  }

  const toEntries = (obj: Record<string, unknown>): [string, unknown][] => Object.entries(obj);

  if (Array.isArray(evidence)) {
    if (evidence.length === 0) return <span className="text-gray-500 italic">{t('hermes.evidenceNone')}</span>;
    return (
      <ul className="space-y-1">
        {evidence.map((item, idx) => (
          <li key={idx} className="rounded bg-gray-50 dark:bg-gray-800/70 px-2 py-1">
            {typeof item === 'object' && item !== null
              ? toEntries(item as Record<string, unknown>).map(([k, v]) => (
                  <div key={k}>
                    <span className="text-gray-500">{k.replace(/_/g, ' ')}:</span>{' '}
                    <span className="text-gray-800 dark:text-gray-200">{String(v ?? '—')}</span>
                  </div>
                ))
              : String(item)}
          </li>
        ))}
      </ul>
    );
  }

  if (typeof evidence === 'object') {
    return (
      <ul className="space-y-1">
        {toEntries(evidence as Record<string, unknown>).map(([k, v]) => (
          <li key={k}>
            <span className="text-gray-500 capitalize">{k.replace(/_/g, ' ')}:</span>{' '}
            <span className="text-gray-800 dark:text-gray-200">
              {typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? '—')}
            </span>
          </li>
        ))}
      </ul>
    );
  }

  return <span>{String(evidence)}</span>;
}

export default function HermesPage() {
  const [tab, setTab] = useState<'overview' | 'findings' | 'assets' | 'scans' | 'recommendations' | 'ai'>('overview');
  const [toast, setToast] = useState<string | null>(null);
  const [aiAnalysis, setAiAnalysis] = useState<string | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiFindingId, setAiFindingId] = useState<string | null>(null);
  const [aiRecommendation, setAiRecommendation] = useState<string | null>(null);
  const { locale, t } = useI18n();

  const { data: status, loading, error, refetch } = useApi<HermesStatus>('/hermes/status');
  const { data: findingsData } = useApi<{ findings: Finding[] }>('/hermes/findings');
  const { data: assetsData } = useApi<{ assets: Asset[] }>('/hermes/assets');
  const { data: scansData } = useApi<{ scans: Scan[] }>('/hermes/scans');
  const { data: recsData } = useApi<{ recommendations: Recommendation[] }>('/hermes/recommendations');
  const { data: surface } = useApi<any>('/hermes/attack-surface');
  const { data: aiStatus } = useApi<{ configured: boolean; healthy: boolean; provider?: string | null; model?: string | null; freeModels?: string[]; version?: string | null; error?: string | null }>('/hermes/ai/status');

  const { loading: starting, mutate: startScan } = useApiMutation('/hermes/scans', 'POST');
  const { loading: stopping, mutate: emergency } = useApiMutation('/hermes/emergency-stop', 'POST');
  const { loading: approving, mutate: approveRec } = useApiMutation('', 'POST');
  const { loading: rejecting, mutate: rejectRec } = useApiMutation('', 'POST');
  const { loading: analyzing, mutate: analyzeAi } = useApiMutation('/hermes/ai/analyze', 'POST');
  const { loading: recommending, mutate: recommendAi } = useApiMutation('/hermes/ai/recommend', 'POST');

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3500);
  };

  const handleStartScan = async (scanType: string) => {
    const res = await startScan({ scan_type: scanType });
    if (res) {
      showToast(`${t('hermes.scanStarted')} (${scanType})`);
      refetch();
    }
  };

  const handleEmergency = async () => {
    const enable = !status?.emergency_stop;
    await emergency({ enable });
    showToast(enable ? t('hermes.emergencyOn') : t('hermes.emergencyOff'));
    refetch();
  };

  const handleDecision = async (id: string, action: 'approve' | 'reject') => {
    const res = action === 'approve' ? await approveRec(`/hermes/recommendations/${id}/approve`, {}) : await rejectRec(`/hermes/recommendations/${id}/reject`, {});
    if (res) {
      showToast(action === 'approve' ? t('hermes.recApproved') : t('hermes.recRejected'));
      refetch();
    }
  };

  const handleAiAnalyze = async () => {
    setAiError(null);
    setAiAnalysis(null);
    const res = await analyzeAi({ locale }) as { analysis?: string } | null;
    if (res?.analysis) {
      setAiAnalysis(res.analysis);
    } else {
      setAiError(t('common.error'));
    }
  };

  const handleAiRecommend = async (findingId: string) => {
    setAiFindingId(findingId);
    setAiRecommendation(null);
    setAiError(null);
    const res = await recommendAi({ finding_id: findingId, locale }) as { recommendation?: string } | null;
    if (res?.recommendation) {
      setAiRecommendation(res.recommendation);
    } else {
      setAiError(t('common.error'));
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (error || !status) {
    return <ErrorState title={t('hermes.failedLoad')} error={error || t('hermes.failedLoadBody')} onRetry={refetch} />;
  }

  const findings = findingsData?.findings || [];
  const assets = assetsData?.assets || [];
  const scans = scansData?.scans || [];
  const recs = recsData?.recommendations || [];
  const pendingRecs = recs.filter((r) => r.status === 'pending');

  const score = status.security_score ?? 0;
  const scoreColor = score >= 80 ? 'text-blue-500' : score >= 60 ? 'text-amber-500' : 'text-red-500';

  return (
    <div className="space-y-6">
      {toast && (
        <div className="px-4 py-3 rounded-lg bg-blue-500/10 border border-blue-500/30 text-sm text-blue-400">
          {toast}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-blue-600/20 border border-blue-500/30 flex items-center justify-center">
            <Radar className="w-5 h-5 text-blue-500" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-gray-900 dark:text-white">{t('page.hermes.title')}</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {t('hermes.subtitle')}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={() => handleStartScan('quick')} disabled={starting || status.emergency_stop} className="btn-primary disabled:opacity-50">
            <Play className="w-4 h-4" /> {t('hermes.quickScan')}
          </button>
          <button onClick={() => handleStartScan('daily')} disabled={starting || status.emergency_stop} className="btn-secondary disabled:opacity-50">
            <Play className="w-4 h-4" /> {t('hermes.standardScan')}
          </button>
          <button onClick={() => handleStartScan('full')} disabled={starting || status.emergency_stop} className="btn-secondary disabled:opacity-50">
            <Play className="w-4 h-4" /> {t('hermes.fullScan')}
          </button>
          <button
            onClick={handleEmergency}
            disabled={stopping}
            className={`px-4 py-2 rounded-lg font-medium border transition-colors disabled:opacity-50 ${
              status.emergency_stop
                ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/30'
                : 'bg-red-500/20 text-red-400 border-red-500/30 hover:bg-red-500/30'
            }`}
            title={t('hermes.stopAll')}
          >
            <Square className="w-4 h-4 inline mr-1" />
            {status.emergency_stop ? t('hermes.clearStop') : t('hermes.stopAll')}
          </button>
        </div>
      </div>

      {status.emergency_stop && (
        <div className="px-4 py-3 rounded-lg bg-red-500/10 border border-red-500/30 text-sm text-red-400 flex items-center gap-2">
          <ShieldAlert className="w-4 h-4" />
          {t('hermes.emergencyActive')}
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4">
        {[
          { label: t('hermes.assets'), value: status.assets, icon: Server },
          { label: t('hermes.vulnerabilities'), value: status.vulnerabilities, icon: Bug },
          { label: t('hermes.critical'), value: status.critical, icon: ShieldAlert },
          { label: t('hermes.high'), value: status.high, icon: AlertTriangle },
          { label: t('hermes.medium'), value: status.medium, icon: Activity },
          { label: t('hermes.unknownDevices'), value: status.unknown_assets, icon: AlertTriangle },
        ].map((s) => (
          <div key={s.label} className="card">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">{s.label}</span>
              <s.icon className="w-4 h-4 text-blue-500" />
            </div>
            <p className="text-2xl font-bold text-gray-900 dark:text-white mt-1">{s.value}</p>
          </div>
        ))}
      </div>

      <div className="card flex flex-col sm:flex-row sm:items-center gap-6">
        <div className="flex items-center gap-4">
          <div className="relative w-20 h-20">
            <svg className="w-20 h-20 -rotate-90" viewBox="0 0 80 80">
              <circle cx="40" cy="40" r="34" strokeWidth="8" fill="none" className="stroke-gray-200 dark:stroke-gray-700" />
              <circle
                cx="40"
                cy="40"
                r="34"
                strokeWidth="8"
                fill="none"
                strokeLinecap="round"
                className={`stroke-blue-500 transition-all duration-700`}
                strokeDasharray={`${(score / 100) * 213.6} 213.6`}
              />
            </svg>
            <div className="absolute inset-0 flex items-center justify-center">
              <span className={`text-lg font-bold ${scoreColor}`}>{score}</span>
            </div>
          </div>
          <div>
            <p className="text-sm font-medium text-gray-500 dark:text-gray-400">{t('hermes.securityPosture')}</p>
            <p className={`text-3xl font-bold ${scoreColor}`}>{score}/100</p>
            <p className="text-xs text-gray-400">{t('hermes.scoreHelp')}</p>
          </div>
        </div>
        <div className="flex-1 grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
          {[
            [t('hermes.openPorts'), surface?.open_ports ?? '—'],
            [t('hermes.highRiskSvc'), surface?.high_risk_services ?? '—'],
            [t('hermes.criticalCve'), status.critical],
            [t('hermes.alerts'), status.open_alerts],
          ].map(([label, val]) => (
            <div key={String(label)} className="rounded-lg bg-gray-50 dark:bg-gray-800/60 p-3">
              <p className="text-xs text-gray-500 dark:text-gray-400">{label}</p>
              <p className="text-lg font-semibold text-gray-900 dark:text-white">{val}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="flex gap-1 border-b border-gray-200 dark:border-gray-700">
        {(
          [
            ['overview', t('hermes.tab.overview')],
            ['findings', `${t('hermes.tab.findings')} (${findings.length})`],
            ['assets', t('hermes.tab.assets')],
            ['scans', t('hermes.tab.scans')],
            ['recommendations', `${t('hermes.tab.recommendations')} (${pendingRecs.length})`],
            ['ai', t('hermes.tab.ai')],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              tab === key
                ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                : 'border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <div className="grid lg:grid-cols-2 gap-6">
          <div className="card">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3 uppercase tracking-wide">{t('hermes.activeScans')}</h3>
            {status.active_scans.length === 0 ? (
              <p className="text-sm text-gray-500 dark:text-gray-400">{t('hermes.noActiveScans')}</p>
            ) : (
              <ul className="space-y-2">
                {status.active_scans.map((s) => (
                  <li key={s.id} className="flex items-center justify-between text-sm">
                    <span className="text-gray-700 dark:text-gray-300">
                      {(() => {
                        const typeKey = `hermes.scanType.${s.scan_type}`;
                        const label = t(typeKey);
                        return label === typeKey ? s.scan_type.replace('_', ' ') : label;
                      })()}
                    </span>
                    <span className={`badge ${s.status === 'running' ? 'bg-blue-500/20 text-blue-400' : 'bg-gray-500/20 text-gray-400'}`}>
                      {(() => {
                        const statusKey = `hermes.status.${s.status}`;
                        const label = t(statusKey);
                        return label === statusKey ? s.status.toUpperCase() : label;
                      })()}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-4 pt-4 border-t border-gray-100 dark:border-gray-700 text-sm text-gray-500 dark:text-gray-400 space-y-1">
              <div className="flex justify-between"><span>{t('hermes.completedScans')}</span><span>{status.scan_stats?.completed || 0}</span></div>
              <div className="flex justify-between"><span>{t('hermes.running')}</span><span>{status.scan_stats?.running || 0}</span></div>
              <div className="flex justify-between"><span>{t('hermes.pendingRecs')}</span><span>{status.pending_recommendations}</span></div>
            </div>
          </div>

          <div className="card">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3 uppercase tracking-wide">{t('hermes.topFindings')}</h3>
            {status.top_findings.length === 0 ? (
              <p className="text-sm text-gray-500 dark:text-gray-400">{t('hermes.noFindings')}</p>
            ) : (
              <ul className="space-y-3">
                {status.top_findings.map((f) => (
                  <li key={f.id} className="flex items-start gap-3">
                    <span className={`badge uppercase shrink-0 ${severityBadge(f.severity)}`}>{f.severity}</span>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-900 dark:text-white truncate">{f.title}</p>
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        {f.hostname || f.ip_address || t('common.unknown')} · {t('hermes.confidence')} {f.confidence}%
                        {f.is_potential ? ` · ${t('hermes.potential')}` : ''}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="card lg:col-span-2">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3 uppercase tracking-wide">{t('hermes.attackSurface')}</h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {surface &&
                Object.entries(surface).map(([key, val]) => {
                  const labelKey = attackSurfaceLabels[key];
                  const label = labelKey ? t(labelKey) : key.replace(/_/g, ' ');
                  return (
                    <div key={key} className="rounded-lg bg-gray-50 dark:bg-gray-800/60 p-3">
                      <p className="text-xs text-gray-500 dark:text-gray-400 capitalize">{label}</p>
                      <p className="text-lg font-semibold text-gray-900 dark:text-white">{String(val)}</p>
                    </div>
                  );
                })}
            </div>
            <div className="mt-4 rounded-lg bg-gray-50 dark:bg-gray-800/60 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-2">
                {t('hermes.attackSurface.diagram')}
              </p>
              <div className="flex flex-col gap-2 text-sm text-gray-700 dark:text-gray-300">
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center px-2.5 py-1 rounded-md bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20">
                    {t('hermes.attackSurface.internet')}
                  </span>
                  <span className="text-gray-400">↓</span>
                  <span className="inline-flex items-center px-2.5 py-1 rounded-md bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20">
                    {t('hermes.attackSurface.firewall')}
                  </span>
                  <span className="text-gray-400">↓</span>
                  <span className="inline-flex items-center px-2.5 py-1 rounded-md bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                    {t('hermes.attackSurface.network')}
                  </span>
                </div>
                <div>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">{t('hermes.attackSurface.devicesIn')}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {assets
                      .filter((a) => a.is_authorized)
                      .slice(0, 8)
                      .map((a) => (
                        <span
                          key={a.id}
                          className="px-2 py-0.5 rounded bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 text-xs"
                        >
                          {a.hostname || a.ip_address || 'asset'}
                        </span>
                      ))}
                    {assets.filter((a) => a.is_authorized).length === 0 && (
                      <span className="text-xs text-gray-400">—</span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {tab === 'findings' && (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
                <th className="py-2 pr-3">{t('hermes.severity')}</th>
                <th className="py-2 pr-3">{t('hermes.finding')}</th>
                <th className="py-2 pr-3">{t('hermes.asset')}</th>
                <th className="py-2 pr-3">{t('hermes.confidence')}</th>
                <th className="py-2 pr-3">{t('hermes.evidence')}</th>
              </tr>
            </thead>
            <tbody>
              {findings.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-gray-500 dark:text-gray-400">
                    {t('hermes.noFindingsRun')}
                  </td>
                </tr>
              ) : (
                findings.map((f) => (
                  <tr key={f.id} className="table-row">
                    <td className="py-3 pr-3">
                      <span className={`badge uppercase ${severityBadge(f.severity)}`}>{f.severity}</span>
                    </td>
                    <td className="py-3 pr-3">
                      <p className="font-medium text-gray-900 dark:text-white">{f.title}</p>
                      {f.description && (
                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 line-clamp-2">{f.description}</p>
                      )}
                      {f.is_potential && (
                        <span className="text-xs text-amber-500">{t('hermes.potentialVuln')}</span>
                      )}
                    </td>
                    <td className="py-3 pr-3 text-gray-600 dark:text-gray-300">{f.hostname || f.ip_address || '—'}</td>
                    <td className="py-3 pr-3">{f.confidence}%</td>
                    <td className="py-3 pr-3 text-xs text-gray-500 dark:text-gray-400 max-w-[280px]">
                      <details>
                        <summary className="cursor-pointer text-blue-500">{t('common.view')}</summary>
                        <div className="mt-1">{formatEvidence(f.evidence, t)}</div>
                      </details>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'assets' && (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
                <th className="py-2 pr-3">{t('hermes.hostname')}</th>
                <th className="py-2 pr-3">{t('hermes.ip')}</th>
                <th className="py-2 pr-3">{t('hermes.authorized')}</th>
                <th className="py-2 pr-3">{t('hermes.posture')}</th>
                <th className="py-2 pr-3">{t('hermes.grade')}</th>
              </tr>
            </thead>
            <tbody>
              {assets.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-gray-500 dark:text-gray-400">
                    {t('hermes.noAssets')}
                  </td>
                </tr>
              ) : (
                assets.map((a) => (
                  <tr key={a.id} className="table-row">
                    <td className="py-3 pr-3 font-medium text-gray-900 dark:text-white">{a.hostname || t('common.unknown')}</td>
                    <td className="py-3 pr-3 font-mono text-xs">{a.ip_address || '—'}</td>
                    <td className="py-3 pr-3">
                      {a.is_authorized ? (
                        <span className="badge-green">{t('hermes.yes')}</span>
                      ) : (
                        <span className="badge-red">{t('common.unknown').toUpperCase()}</span>
                      )}
                    </td>
                    <td className="py-3 pr-3">{a.posture_score}/100</td>
                    <td className="py-3 pr-3 font-semibold">{a.last_grade || '—'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'scans' && (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
                <th className="py-2 pr-3">{t('hermes.type')}</th>
                <th className="py-2 pr-3">{t('common.status')}</th>
                <th className="py-2 pr-3">{t('hermes.started')}</th>
                <th className="py-2 pr-3">{t('hermes.completed')}</th>
                <th className="py-2 pr-3">{t('hermes.stats')}</th>
              </tr>
            </thead>
            <tbody>
              {scans.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-gray-500 dark:text-gray-400">{t('hermes.noScans')}</td>
                </tr>
              ) : (
                scans.map((s) => (
                  <tr key={s.id} className="table-row">
                    <td className="py-3 pr-3 capitalize">
                      {(() => {
                        const typeKey = `hermes.scanType.${s.scan_type}`;
                        const label = t(typeKey);
                        return label === typeKey ? s.scan_type.replace('_', ' ') : label;
                      })()}
                    </td>
                    <td className="py-3 pr-3">
                      <span
                        className={`badge ${
                          s.status === 'completed'
                            ? 'badge-green'
                            : s.status === 'running'
                            ? 'bg-blue-500/20 text-blue-400'
                            : s.status === 'failed'
                            ? 'badge-red'
                            : 'badge-gray'
                        }`}
                      >
                        {(() => {
                          const statusKey = `hermes.status.${s.status}`;
                          const label = t(statusKey);
                          return label === statusKey ? s.status : label;
                        })()}
                      </span>
                    </td>
                    <td className="py-3 pr-3 text-xs text-gray-500">{s.started_at ? new Date(s.started_at).toLocaleString() : '—'}</td>
                    <td className="py-3 pr-3 text-xs text-gray-500">{s.completed_at ? new Date(s.completed_at).toLocaleString() : '—'}</td>
                    <td className="py-3 pr-3 text-xs max-w-[220px]">
                      {formatScanStats(s.stats, s.status, t)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'recommendations' && (
        <div className="space-y-3">
          {pendingRecs.length === 0 && recs.length === 0 && (
            <div className="card text-sm text-gray-500 dark:text-gray-400">{t('hermes.noRecs')}</div>
          )}
          {recs.map((r) => (
            <div key={r.id} className="card flex flex-col sm:flex-row sm:items-center gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="font-medium text-gray-900 dark:text-white truncate">{r.title}</p>
                  <span className={`badge ${r.status === 'approved' ? 'badge-green' : r.status === 'rejected' ? 'badge-red' : 'badge-yellow'}`}>
                    {r.status}
                  </span>
                </div>
                <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{r.description}</p>
                <p className="text-xs text-gray-400 mt-1">{r.hostname || ''}</p>
              </div>
              {r.status === 'pending' && (
                <div className="flex gap-2 shrink-0">
                  <button onClick={() => handleDecision(r.id, 'approve')} disabled={approving} className="btn-success text-xs">
                    <CheckCircle2 className="w-4 h-4" /> {t('common.approve')}
                  </button>
                  <button onClick={() => handleDecision(r.id, 'reject')} disabled={rejecting} className="btn-danger text-xs">
                    <XCircle className="w-4 h-4" /> {t('common.reject')}
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {tab === 'ai' && (
        <div className="space-y-4">
          <div className="card">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <Sparkles className="w-5 h-5 text-blue-500" />
                  <h3 className="text-sm font-semibold text-gray-900 dark:text-white uppercase tracking-wide">{t('hermes.ai.title')}</h3>
                </div>
                <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{t('hermes.ai.subtitle')}</p>
                <p className="text-xs text-gray-400 mt-1">
                  {aiStatus?.configured
                    ? `${aiStatus.provider || 'ai'}${aiStatus.model ? ` · ${aiStatus.model}` : ''}: ${aiStatus.healthy ? 'OK' : aiStatus.error || 'offline'}${aiStatus.version ? ` · v${aiStatus.version}` : ''}${aiStatus.freeModels?.length ? ` · free: ${aiStatus.freeModels.slice(0, 3).join(', ')}` : ''}`
                    : `${t('hermes.ai.localMode')}`}
                </p>
              </div>
              <button
                onClick={handleAiAnalyze}
                disabled={analyzing}
                className="btn-primary disabled:opacity-50"
              >
                <Sparkles className="w-4 h-4" />
                {analyzing ? t('hermes.ai.analyzing') : t('hermes.ai.analyze')}
              </button>
            </div>

            {aiError && (
              <div className="mt-4 px-4 py-3 rounded-lg bg-red-500/10 border border-red-500/30 text-sm text-red-400">
                {aiError}
              </div>
            )}

            {aiAnalysis && (
              <div className="mt-4 rounded-lg bg-gray-50 dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 p-4">
                <pre className="whitespace-pre-wrap text-sm text-gray-700 dark:text-gray-300">{aiAnalysis}</pre>
              </div>
            )}
          </div>

          <div className="card">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3 uppercase tracking-wide">{t('hermes.tab.findings')}</h3>
            <div className="space-y-2">
              {findings.slice(0, 20).map((f) => (
                <div key={f.id} className="flex flex-col sm:flex-row sm:items-center gap-2 rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={`badge uppercase shrink-0 ${severityBadge(f.severity)}`}>{f.severity}</span>
                      <p className="text-sm font-medium text-gray-900 dark:text-white truncate">{f.title}</p>
                    </div>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{f.hostname || f.ip_address || t('common.unknown')}</p>
                  </div>
                  <button
                    onClick={() => handleAiRecommend(f.id)}
                    disabled={recommending}
                    className="btn-secondary text-xs shrink-0 disabled:opacity-50"
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    {aiFindingId === f.id && recommending ? t('hermes.ai.recommending') : t('hermes.ai.recommend')}
                  </button>
                </div>
              ))}
            </div>

            {aiRecommendation && (
              <div className="mt-4 rounded-lg bg-blue-500/5 border border-blue-500/20 p-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-blue-500 mb-2">{t('hermes.ai.forFinding')}</p>
                <pre className="whitespace-pre-wrap text-sm text-gray-700 dark:text-gray-300">{aiRecommendation}</pre>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
