import React, { useState, useMemo } from 'react';
import { RefreshCw, Check, Inbox } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { useI18n } from '../i18n';
import api from '../services/api';
import Pagination from '../components/Pagination';
import LoadingSpinner from '../components/LoadingSpinner';
import ErrorState from '../components/ErrorState';
import AlertBanner from '../components/AlertBanner';

interface Contact {
  id: string;
  name: string;
  email: string;
  message: string;
  is_read: boolean;
  created_at: string;
}

const PAGE_SIZE = 25;

export default function ContactosPage() {
  const { t } = useI18n();
  const [page, setPage] = useState(1);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [markingId, setMarkingId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const params = useMemo(() => {
    const p: Record<string, string> = {
      limit: String(PAGE_SIZE),
      offset: String((page - 1) * PAGE_SIZE),
    };
    if (unreadOnly) p.unreadOnly = 'true';
    return p;
  }, [page, unreadOnly]);

  const { data, loading, error, refetch } = useApi<{ contacts: Contact[]; total: number }>('/contacts', { params });

  const contacts = Array.isArray(data?.contacts) ? data.contacts : [];
  const total = data?.total || 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const handleMarkRead = async (id: string) => {
    setMarkingId(id);
    try {
      await api.request(`/contacts/${id}/read`, { method: 'PATCH' });
      await refetch();
    } catch {
      setToast({ type: 'error', message: t('contacts.markReadFailed') });
    } finally {
      setMarkingId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">{t('page.contacts.title')}</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            {total} {t('contacts.total')}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={unreadOnly}
              onChange={(e) => {
                setUnreadOnly(e.target.checked);
                setPage(1);
              }}
              className="rounded border-gray-300 dark:border-gray-600 text-blue-600 focus:ring-blue-500"
            />
            {t('contacts.unreadOnly')}
          </label>
          <button
            onClick={() => refetch()}
            disabled={loading}
            className="inline-flex items-center gap-2 px-4 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-60 transition-colors"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            {t('common.refresh')}
          </button>
        </div>
      </div>

      {toast && <AlertBanner type={toast.type} message={toast.message} onClose={() => setToast(null)} />}

      {loading ? (
        <LoadingSpinner size="lg" className="h-64" />
      ) : error ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : contacts.length === 0 ? (
        <div className="text-center py-16">
          <Inbox className="w-12 h-12 mx-auto text-gray-400 dark:text-gray-500" />
          <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">{t('contacts.empty')}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {contacts.map((contact) => (
            <div
              key={contact.id}
              className={`bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4 ${
                contact.is_read ? 'opacity-70' : ''
              }`}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-sm font-semibold text-gray-900 dark:text-white">{contact.name}</p>
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                        contact.is_read
                          ? 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300'
                          : 'bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400'
                      }`}
                    >
                      {contact.is_read ? t('contacts.read') : t('contacts.unread')}
                    </span>
                  </div>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                    {t('contacts.from')} {contact.email} · {new Date(contact.created_at).toLocaleString()}
                  </p>
                  <p className="mt-2 text-sm text-gray-700 dark:text-gray-300 line-clamp-2" title={contact.message}>
                    {contact.message}
                  </p>
                </div>
                {!contact.is_read && (
                  <button
                    onClick={() => handleMarkRead(contact.id)}
                    disabled={markingId === contact.id}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg disabled:opacity-60 flex-shrink-0 transition-colors"
                  >
                    <Check className="w-3.5 h-3.5" />
                    {t('contacts.markRead')}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <Pagination currentPage={page} totalPages={totalPages} onPageChange={setPage} />
    </div>
  );
}
