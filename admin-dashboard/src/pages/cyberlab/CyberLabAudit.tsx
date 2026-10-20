import React, { useState } from 'react';
import { ChevronLeft, ChevronRight, ScrollText } from 'lucide-react';
import { useApi } from '../../hooks/useApi';
import DataTable from '../../components/DataTable';
import ErrorState from '../../components/ErrorState';
import LoadingSpinner from '../../components/LoadingSpinner';
import { useI18n } from '../../i18n';

type AuditEntry = {
  id: string;
  user_id: string | null;
  user_email: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  description: string | null;
  ip_address: string | null;
  created_at: string;
};

const PAGE_SIZE = 20;

export default function CyberLabAudit() {
  const { t, locale } = useI18n();
  const [page, setPage] = useState(1);

  const offset = (page - 1) * PAGE_SIZE;
  const audit = useApi<{ entries: AuditEntry[]; total: number }>('/cyberlab/audit', {
    params: { limit: String(PAGE_SIZE), offset: String(offset) },
  });

  const entries = audit.data?.entries ?? [];
  const total = audit.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const formatDate = (dateStr: string) =>
    new Date(dateStr).toLocaleString(locale === 'pt' ? 'pt-PT' : 'en-GB');

  const columns = [
    {
      key: 'created_at',
      label: t('cyberlab.audit.date'),
      sortable: true,
      render: (row: AuditEntry) => (
        <span className="text-xs font-mono text-gray-500 dark:text-gray-400 whitespace-nowrap">
          {formatDate(row.created_at)}
        </span>
      ),
    },
    {
      key: 'action',
      label: t('cyberlab.audit.action'),
      sortable: true,
      render: (row: AuditEntry) => (
        <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-slate-100 dark:bg-slate-800 text-xs font-mono text-slate-700 dark:text-slate-300">
          {row.action}
        </span>
      ),
    },
    {
      key: 'user_email',
      label: t('cyberlab.audit.user'),
      sortable: true,
      render: (row: AuditEntry) => (
        <span className="text-sm text-gray-700 dark:text-gray-300">
          {row.user_email || t('cyberlab.audit.system')}
        </span>
      ),
    },
    {
      key: 'description',
      label: t('cyberlab.audit.description'),
      render: (row: AuditEntry) => (
        <span className="text-sm text-gray-600 dark:text-gray-300 break-words">
          {row.description || t('cyberlab.common.none')}
        </span>
      ),
    },
    {
      key: 'target_type',
      label: t('cyberlab.audit.target'),
      render: (row: AuditEntry) => (
        <span className="text-xs text-gray-500 dark:text-gray-400 font-mono break-all">
          {row.target_type || t('cyberlab.common.none')}
          {row.target_id ? ` · ${row.target_id}` : ''}
        </span>
      ),
    },
    {
      key: 'ip_address',
      label: t('cyberlab.audit.ip'),
      render: (row: AuditEntry) => (
        <span className="text-xs font-mono text-gray-500 dark:text-gray-400">
          {row.ip_address || t('cyberlab.common.none')}
        </span>
      ),
    },
  ];

  if (audit.error && !audit.data) {
    return (
      <ErrorState
        error={audit.error}
        onRetry={audit.refetch}
        title={t('cyberlab.audit.failedLoad')}
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">
            {t('cyberlab.audit.title')}
          </h1>
        </div>
        <button
          onClick={() => audit.refetch()}
          disabled={audit.loading}
          className="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50 transition-colors"
        >
          <ScrollText className="w-4 h-4" />
          {t('common.refresh')}
        </button>
      </div>

      <p className="text-sm text-gray-600 dark:text-gray-300">{t('cyberlab.audit.subtitle')}</p>

      {audit.loading && !audit.data ? (
        <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
          <LoadingSpinner size="sm" />
          {t('common.loading')}
        </div>
      ) : (
        <>
          <DataTable
            columns={columns}
            data={entries}
            loading={audit.loading}
            emptyMessage={t('cyberlab.audit.empty')}
          />

          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {t('cyberlab.audit.total')}: {total} ·{' '}
              {t('cyberlab.audit.page')
                .replace('{page}', String(page))
                .replace('{pages}', String(totalPages))}
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage((current) => Math.max(1, current - 1))}
                disabled={page <= 1}
                className="inline-flex items-center gap-1 px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <ChevronLeft className="w-4 h-4" />
                {t('cyberlab.audit.prev')}
              </button>
              <button
                onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
                disabled={page >= totalPages}
                className="inline-flex items-center gap-1 px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {t('cyberlab.audit.next')}
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
