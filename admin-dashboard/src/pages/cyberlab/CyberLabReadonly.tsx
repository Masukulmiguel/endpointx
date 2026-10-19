import React from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Database } from 'lucide-react';
import CyberLabStateBadge from '../../components/CyberLabStateBadge';
import { useI18n } from '../../i18n';

export interface CyberLabReadonlyStat {
  labelKey: string;
  value: number;
}

interface CyberLabReadonlyProps {
  titleKey: string;
  state: 'available' | 'not_configured';
  stats?: CyberLabReadonlyStat[];
  link?: { to: string; labelKey: string };
}

export default function CyberLabReadonly({ titleKey, state, stats, link }: CyberLabReadonlyProps) {
  const { t } = useI18n();

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold tracking-tight text-gray-900">{t(titleKey)}</h1>
        <CyberLabStateBadge state={state} />
      </div>

      <div className="bg-white rounded-xl border border-slate-200 p-6 shadow-sm shadow-slate-200/60">
        <div className="flex items-start gap-3">
          <div className="flex shrink-0 items-center justify-center w-9 h-9 rounded-lg bg-slate-100 dark:bg-slate-800 ring-1 ring-slate-200 dark:ring-slate-700">
            <Database className="w-[18px] h-[18px] text-slate-500 dark:text-slate-400" />
          </div>
          <div className="space-y-3">
            <p className="text-sm text-gray-600 dark:text-gray-300 leading-relaxed">
              {t(state === 'not_configured' ? 'cyberlab.readonly.notConfiguredBody' : 'cyberlab.readonly.availableBody')}
            </p>

            {stats && stats.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                {stats.map((stat) => (
                  <span
                    key={stat.labelKey}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300"
                  >
                    {t(stat.labelKey)}
                    <strong className="font-bold">{stat.value}</strong>
                  </span>
                ))}
              </div>
            )}

            {link && (
              <Link
                to={link.to}
                className="inline-flex items-center gap-1.5 text-sm font-medium text-primary-700 hover:text-primary-700/80"
              >
                {t(link.labelKey)}
                <ArrowRight className="w-4 h-4" />
              </Link>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
