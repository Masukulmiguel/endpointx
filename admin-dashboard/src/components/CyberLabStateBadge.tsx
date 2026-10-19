import React from 'react';
import { useI18n } from '../i18n';

export type CyberLabState = 'available' | 'experimental' | 'not_configured' | 'coming_soon';

interface CyberLabStateBadgeProps {
  state: CyberLabState;
  className?: string;
}

const stateConfig: Record<
  CyberLabState,
  { bg: string; text: string; dot: string; pulse: boolean; labelKey: string }
> = {
  available: {
    bg: 'bg-emerald-50 dark:bg-emerald-900/20',
    text: 'text-emerald-700 dark:text-emerald-400',
    dot: 'bg-emerald-500',
    pulse: false,
    labelKey: 'cyberlab.state.available',
  },
  experimental: {
    bg: 'bg-purple-50 dark:bg-purple-900/20',
    text: 'text-purple-700 dark:text-purple-400',
    dot: 'bg-purple-500',
    pulse: false,
    labelKey: 'cyberlab.state.experimental',
  },
  not_configured: {
    bg: 'bg-gray-100 dark:bg-gray-800',
    text: 'text-gray-600 dark:text-gray-400',
    dot: 'bg-gray-400',
    pulse: false,
    labelKey: 'cyberlab.state.notConfigured',
  },
  coming_soon: {
    bg: 'bg-blue-50 dark:bg-blue-900/20',
    text: 'text-blue-700 dark:text-blue-400',
    dot: 'bg-blue-500',
    pulse: false,
    labelKey: 'cyberlab.state.comingSoon',
  },
};

export default function CyberLabStateBadge({ state, className = '' }: CyberLabStateBadgeProps) {
  const { t } = useI18n();
  const config = stateConfig[state] || stateConfig.not_configured;

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${config.bg} ${config.text} ${className}`}
    >
      <span className="relative flex h-2 w-2">
        {config.pulse && (
          <span className={`absolute inline-flex h-full w-full rounded-full ${config.dot} opacity-75 animate-ping`} />
        )}
        <span className={`relative inline-flex h-2 w-2 rounded-full ${config.dot}`} />
      </span>
      {t(config.labelKey)}
    </span>
  );
}
