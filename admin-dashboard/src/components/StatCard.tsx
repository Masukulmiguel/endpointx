import React from 'react';
import { LucideIcon, TrendingUp, TrendingDown } from 'lucide-react';

type StatColor = 'primary' | 'success' | 'warning' | 'danger' | 'info';

interface StatCardProps {
  title: string;
  value: string | number;
  change: number;
  icon: LucideIcon;
  color?: StatColor;
}

const colorConfig: Record<StatColor, { bg: string; icon: string; ring: string }> = {
  primary: {
    bg: 'bg-blue-100 dark:bg-blue-900/30',
    icon: 'text-blue-600 dark:text-blue-400',
    ring: 'ring-blue-200 dark:ring-blue-800',
  },
  success: {
    bg: 'bg-emerald-100 dark:bg-emerald-900/30',
    icon: 'text-emerald-600 dark:text-emerald-400',
    ring: 'ring-emerald-200 dark:ring-emerald-800',
  },
  warning: {
    bg: 'bg-amber-100 dark:bg-amber-900/30',
    icon: 'text-amber-600 dark:text-amber-400',
    ring: 'ring-amber-200 dark:ring-amber-800',
  },
  danger: {
    bg: 'bg-red-100 dark:bg-red-900/30',
    icon: 'text-red-600 dark:text-red-400',
    ring: 'ring-red-200 dark:ring-red-800',
  },
  info: {
    bg: 'bg-blue-100 dark:bg-blue-900/30',
    icon: 'text-blue-600 dark:text-blue-400',
    ring: 'ring-blue-200 dark:ring-blue-800',
  },
};

export default function StatCard({ title, value, change, icon: Icon, color = 'primary' }: StatCardProps) {
  const colors = colorConfig[color];
  const isPositive = change >= 0;

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm shadow-slate-200/60 hover:border-slate-300 transition-colors">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-medium leading-5 text-slate-500">{title}</p>
        <div className={`flex shrink-0 items-center justify-center w-10 h-10 rounded-lg ring-1 ${colors.bg} ${colors.ring}`}>
          <Icon className={`w-5 h-5 ${colors.icon}`} />
        </div>
      </div>
      <p className="mt-3 text-3xl font-bold tracking-tight text-slate-900">{value}</p>
      <div className={`mt-1 flex items-center gap-1 text-xs font-semibold ${isPositive ? 'text-emerald-600' : 'text-red-600'}`}>
        {isPositive ? <TrendingUp className="w-3.5 h-3.5" /> : <TrendingDown className="w-3.5 h-3.5" />}
        {isPositive ? '+' : ''}{change}%
      </div>
    </div>
  );
}
