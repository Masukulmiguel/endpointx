import React from 'react';
import { Construction } from 'lucide-react';
import CyberLabStateBadge from '../../components/CyberLabStateBadge';
import { useI18n } from '../../i18n';

interface CyberLabSoonProps {
  titleKey: string;
  explanationKey: string;
}

export default function CyberLabSoon({ titleKey, explanationKey }: CyberLabSoonProps) {
  const { t } = useI18n();

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold tracking-tight text-gray-900">{t(titleKey)}</h1>
        <CyberLabStateBadge state="coming_soon" />
      </div>

      <div className="bg-white rounded-xl border border-slate-200 p-6 shadow-sm shadow-slate-200/60">
        <div className="flex items-start gap-3">
          <div className="flex shrink-0 items-center justify-center w-9 h-9 rounded-lg bg-blue-100 dark:bg-blue-900/30 ring-1 ring-blue-200 dark:ring-blue-800">
            <Construction className="w-[18px] h-[18px] text-blue-600 dark:text-blue-400" />
          </div>
          <p className="text-sm text-gray-600 dark:text-gray-300 leading-relaxed">
            {t(explanationKey)}
          </p>
        </div>
      </div>
    </div>
  );
}
