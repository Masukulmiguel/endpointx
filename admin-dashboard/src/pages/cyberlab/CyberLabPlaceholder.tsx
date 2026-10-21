import React from 'react';
import { Construction } from 'lucide-react';
import CyberLabStateBadge, { type CyberLabState } from '../../components/CyberLabStateBadge';
import { useI18n } from '../../i18n';

interface CyberLabPlaceholderProps {
  titleKey: string;
  state: CyberLabState;
  bodyKey: string;
}

export default function CyberLabPlaceholder({ titleKey, state, bodyKey }: CyberLabPlaceholderProps) {
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
            <Construction className="w-[18px] h-[18px] text-slate-500 dark:text-slate-400" />
          </div>
          <p className="text-sm text-gray-600 dark:text-gray-300 leading-relaxed">{t(bodyKey)}</p>
        </div>
      </div>
    </div>
  );
}
