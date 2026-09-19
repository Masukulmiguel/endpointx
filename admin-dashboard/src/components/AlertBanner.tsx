import React from 'react';
import { CheckCircle, XCircle, AlertTriangle, Info, X } from 'lucide-react';

type AlertType = 'success' | 'error' | 'warning' | 'info';

interface AlertBannerProps {
  type: AlertType;
  message: string;
  onClose?: () => void;
  className?: string;
}

const typeConfig: Record<AlertType, { border: string; bg: string; icon: React.ElementType; iconColor: string; textColor: string }> = {
  success: {
    border: 'border-l-emerald-500',
    bg: 'bg-emerald-50 dark:bg-emerald-900/20',
    icon: CheckCircle,
    iconColor: 'text-emerald-500',
    textColor: 'text-emerald-800 dark:text-emerald-300',
  },
  error: {
    border: 'border-l-red-500',
    bg: 'bg-red-50 dark:bg-red-900/20',
    icon: XCircle,
    iconColor: 'text-red-500',
    textColor: 'text-red-800 dark:text-red-300',
  },
  warning: {
    border: 'border-l-amber-500',
    bg: 'bg-amber-50 dark:bg-amber-900/20',
    icon: AlertTriangle,
    iconColor: 'text-amber-500',
    textColor: 'text-amber-800 dark:text-amber-300',
  },
  info: {
    border: 'border-l-blue-500',
    bg: 'bg-blue-50 dark:bg-blue-900/20',
    icon: Info,
    iconColor: 'text-blue-500',
    textColor: 'text-blue-800 dark:text-blue-300',
  },
};

export default function AlertBanner({ type, message, onClose, className = '' }: AlertBannerProps) {
  const config = typeConfig[type];
  const Icon = config.icon;

  return (
    <div
      className={`flex items-start gap-3 px-4 py-3 rounded-lg border-l-4 ${config.border} ${config.bg} ${className}`}
    >
      <Icon className={`w-5 h-5 flex-shrink-0 mt-0.5 ${config.iconColor}`} />
      <p className={`flex-1 text-sm font-medium ${config.textColor}`}>{message}</p>
      {onClose && (
        <button
          onClick={onClose}
          className={`flex-shrink-0 p-0.5 rounded ${config.textColor} hover:opacity-70 transition-opacity`}
        >
          <X className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}
