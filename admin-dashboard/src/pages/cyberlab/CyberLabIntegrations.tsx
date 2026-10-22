import React from 'react';
import { Plug, RefreshCw, Terminal, Info } from 'lucide-react';
import { useApi } from '../../hooks/useApi';
import CyberLabStateBadge, { CyberLabState } from '../../components/CyberLabStateBadge';
import ErrorState from '../../components/ErrorState';
import LoadingSpinner from '../../components/LoadingSpinner';
import { useI18n } from '../../i18n';

type ProviderStatus = {
  available: boolean;
  reason: 'not_configured' | 'probe_failed' | null;
  version: string | null;
  detail: string | null;
};

export default function CyberLabIntegrations() {
  const { t } = useI18n();
  const providers = useApi<ProviderStatus>('/cyberlab/providers');
  const provider = providers.data;

  // The API reports three honest states, and a request that never reached the
  // server is a fourth. A failed probe is not "not configured": the engine
  // may be configured and unreachable, and the operator must be told which.
  const badgeState: CyberLabState = providers.error
    ? 'unavailable'
    : provider?.available
      ? 'available'
      : provider?.reason === 'probe_failed'
        ? 'unavailable'
        : 'not_configured';

  if (providers.error && !provider) {
    return (
      <ErrorState
        error={providers.error}
        onRetry={providers.refetch}
        title={t('cyberlab.integrations.failedLoad')}
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">
            {t('nav.cyberlab.integrations')}
          </h1>
          {provider && <CyberLabStateBadge state={badgeState} />}
        </div>
        <button
          onClick={() => providers.refetch()}
          disabled={providers.loading}
          className="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50 transition-colors"
        >
          <RefreshCw className={`w-4 h-4 ${providers.loading ? 'animate-spin' : ''}`} />
          {t('common.refresh')}
        </button>
      </div>

      <p className="text-sm text-gray-600 dark:text-gray-300">{t('cyberlab.integrations.subtitle')}</p>

      <div className="bg-white dark:bg-gray-900 rounded-xl border border-slate-200 dark:border-gray-700 p-6 shadow-sm shadow-slate-200/60">
        <div className="flex items-start gap-3">
          <div className="flex shrink-0 items-center justify-center w-9 h-9 rounded-lg bg-slate-100 dark:bg-slate-800 ring-1 ring-slate-200 dark:ring-slate-700">
            <Plug className="w-[18px] h-[18px] text-slate-500 dark:text-slate-400" />
          </div>
          <div className="min-w-0 flex-1 space-y-3">
            {providers.loading && !provider ? (
              <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
                <LoadingSpinner size="sm" />
                {t('common.loading')}
              </div>
            ) : provider ? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <CyberLabStateBadge state={badgeState} />
                  {provider.available && provider.version && (
                    <span className="text-xs text-gray-500 dark:text-gray-400">
                      {t('cyberlab.integrations.versionLabel')}: {provider.version}
                    </span>
                  )}
                </div>

                {provider.available && (
                  <p className="text-sm text-gray-700 dark:text-gray-300">
                    {t('cyberlab.integrations.availableBody')}
                  </p>
                )}

                {!provider.available && provider.reason === 'not_configured' && (
                  <div className="space-y-3">
                    <p className="text-sm text-gray-700 dark:text-gray-300">
                      {t('cyberlab.integrations.notConfiguredBody')}
                    </p>
                    <ul className="space-y-2">
                      {[
                        'cyberlab.integrations.step1',
                        'cyberlab.integrations.step2',
                        'cyberlab.integrations.step3',
                      ].map((key) => (
                        <li
                          key={key}
                          className="flex items-start gap-2 text-sm text-gray-600 dark:text-gray-300"
                        >
                          <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-slate-400 shrink-0" />
                          <span>{t(key)}</span>
                        </li>
                      ))}
                    </ul>
                    <p className="inline-flex items-center gap-1.5 text-xs font-mono bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 px-2 py-1 rounded-md">
                      <Terminal className="w-3.5 h-3.5" />
                      SEEFAST_CLI
                    </p>
                  </div>
                )}

                {!provider.available && provider.reason === 'probe_failed' && (
                  <div className="space-y-2">
                    <p className="text-sm text-gray-700 dark:text-gray-300">
                      {t('cyberlab.reason.probeFailed')} — {t('cyberlab.integrations.probeFailedBody')}
                    </p>
                    {provider.detail ? (
                      <pre className="text-xs font-mono whitespace-pre-wrap break-words bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 rounded-lg px-3 py-2">
                        {provider.detail}
                      </pre>
                    ) : (
                      <p className="text-sm text-gray-500 dark:text-gray-400">
                        {t('cyberlab.integrations.noDetail')}
                      </p>
                    )}
                  </div>
                )}
              </>
            ) : (
              <p className="text-sm text-gray-500 dark:text-gray-400">{t('common.error')}</p>
            )}
          </div>
        </div>
      </div>

      <div className="flex items-start gap-2 text-xs text-gray-500 dark:text-gray-400">
        <Info className="w-4 h-4 mt-0.5 shrink-0" />
        <p>{t('cyberlab.integrations.provenanceNote')}</p>
      </div>
    </div>
  );
}
