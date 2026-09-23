import React, { useState } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface ErrorStateProps {
  error: string;
  onRetry: () => Promise<void> | void;
  title?: string;
}

export default function ErrorState({ error, onRetry, title = 'Something went wrong' }: ErrorStateProps) {
  const [retrying, setRetrying] = useState(false);
  const [attempts, setAttempts] = useState(0);

  const handleRetry = async () => {
    if (retrying) return;
    setRetrying(true);
    setAttempts((a) => a + 1);
    try {
      await onRetry();
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div className="flex items-center justify-center h-64">
      <div className="text-center max-w-sm px-4">
        <div className="mx-auto w-12 h-12 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center mb-4">
          <AlertTriangle className="w-6 h-6 text-red-600 dark:text-red-400" />
        </div>
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">{title}</h3>
        <p className="mt-1 text-sm text-red-500 dark:text-red-400 break-words">{error}</p>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {attempts === 0 ? 'Check your connection and try again' : `Attempt ${attempts}`}
        </p>
        <button
          onClick={handleRetry}
          disabled={retrying}
          className="mt-4 inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-500 rounded-lg disabled:opacity-60 disabled:cursor-not-allowed transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-gray-800"
        >
          <RefreshCw className={`w-4 h-4 ${retrying ? 'animate-spin' : ''}`} />
          {retrying ? 'Retrying…' : 'Retry'}
        </button>
      </div>
    </div>
  );
}
