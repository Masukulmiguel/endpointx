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
    bg: 'bg-indigo-100 dark:bg-indigo-900/30',
    icon: 'text-indigo-600 dark:text-indigo-400',
    ring: 'ring-indigo-200 dark:ring-indigo-800',
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
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-5 hover:border-gray-300 dark:hover:border-gray-600 transition-colors">
      <div className="flex items-start justify-between">
        <div className={`flex items-center justify-center w-11 h-11 rounded-lg ring-1 ${colors.bg} ${colors.ring}`}>
          <Icon className={`w-5 h-5 ${colors.icon}`} />
        </div>
        <div className={`flex items-center gap-1 text-sm font-medium ${isPositive ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
          {isPositive ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
          {isPositive ? '+' : ''}{change}%
        </div>
      </div>
      <div className="mt-4">
        <p className="text-2xl font-bold text-gray-900 dark:text-white">{value}</p>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{title}</p>
      </div>
    </div>
  );
}
