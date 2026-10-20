import React, { useEffect, useMemo, useState } from 'react';
import { Save, SlidersHorizontal, Info, Loader2 } from 'lucide-react';
import { useApi, useApiMutation } from '../../hooks/useApi';
import { useAuth } from '../../contexts/AuthContext';
import AlertBanner from '../../components/AlertBanner';
import ErrorState from '../../components/ErrorState';
import LoadingSpinner from '../../components/LoadingSpinner';
import { useI18n } from '../../i18n';

type Bounds = { min: number; max: number };

type ConfigPayload = {
  limits: { max_artifact_mb: number; job_timeout_s: number; max_concurrent: number };
  overrides: {
    cyberlab_max_artifact_mb: string | null;
    cyberlab_job_timeout_s: string | null;
    cyberlab_max_concurrent: string | null;
  };
  bounds: { max_artifact_mb: Bounds; job_timeout_s: Bounds; max_concurrent: Bounds };
};

type FieldKey = 'maxArtifactMb' | 'jobTimeoutS' | 'maxConcurrent';

const FIELDS: Array<{
  key: FieldKey;
  labelKey: string;
  unitKey: string;
  limitKey: keyof ConfigPayload['limits'];
  overrideKey: keyof ConfigPayload['overrides'];
  boundKey: keyof ConfigPayload['bounds'];
}> = [
  {
    key: 'maxArtifactMb',
    labelKey: 'cyberlab.settings.field.maxArtifactMb',
    unitKey: 'cyberlab.settings.unit.mb',
    limitKey: 'max_artifact_mb',
    overrideKey: 'cyberlab_max_artifact_mb',
    boundKey: 'max_artifact_mb',
  },
  {
    key: 'jobTimeoutS',
    labelKey: 'cyberlab.settings.field.jobTimeoutS',
    unitKey: 'cyberlab.settings.unit.seconds',
    limitKey: 'job_timeout_s',
    overrideKey: 'cyberlab_job_timeout_s',
    boundKey: 'job_timeout_s',
  },
  {
    key: 'maxConcurrent',
    labelKey: 'cyberlab.settings.field.maxConcurrent',
    unitKey: 'cyberlab.settings.unit.jobs',
    limitKey: 'max_concurrent',
    overrideKey: 'cyberlab_max_concurrent',
    boundKey: 'max_concurrent',
  },
];

export default function CyberLabSettings() {
  const { t } = useI18n();
  const { hasPermission } = useAuth();
  const canManage = hasPermission('cyberlab.manage');

  const config = useApi<ConfigPayload>('/cyberlab/config');
  const saveMutation = useApiMutation<ConfigPayload, Partial<Record<FieldKey, number>>>('/cyberlab/config', 'PUT');

  const [form, setForm] = useState<Record<FieldKey, string>>({
    maxArtifactMb: '',
    jobTimeoutS: '',
    maxConcurrent: '',
  });
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const data = config.data;

  // The stored override wins as the starting value; with no override the
  // effective limit is what the operator is looking at.
  const baseline = useMemo<Record<FieldKey, number | null>>(() => {
    if (!data) return { maxArtifactMb: null, jobTimeoutS: null, maxConcurrent: null };
    const out = {} as Record<FieldKey, number | null>;
    for (const field of FIELDS) {
      const raw = data.overrides[field.overrideKey];
      const parsedOverride = raw === null || raw === '' ? null : Number(raw);
      out[field.key] =
        parsedOverride !== null && Number.isFinite(parsedOverride)
          ? parsedOverride
          : data.limits[field.limitKey];
    }
    return out;
  }, [data]);

  useEffect(() => {
    if (!data) return;
    setForm({
      maxArtifactMb: String(baseline.maxArtifactMb ?? data.limits.max_artifact_mb),
      jobTimeoutS: String(baseline.jobTimeoutS ?? data.limits.job_timeout_s),
      maxConcurrent: String(baseline.maxConcurrent ?? data.limits.max_concurrent),
    });
    // baseline tracks config.data, so one effect is enough to follow refetches.
  }, [data, baseline]);

  const invalidField = useMemo(() => {
    if (!data) return null;
    for (const field of FIELDS) {
      const bounds = data.bounds[field.boundKey];
      const raw = form[field.key].trim();
      if (raw === '') return field.key;
      const value = Number(raw);
      if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) return field.key;
    }
    return null;
  }, [data, form]);

  const changed = useMemo(() => {
    if (!data) return false;
    return FIELDS.some((field) => {
      const base = baseline[field.key];
      if (base === null) return form[field.key].trim() !== '';
      return form[field.key].trim() !== String(base);
    });
  }, [data, form, baseline]);

  // An override that does not show up in the effective limits means an env
  // variable is winning the precedence race — say so instead of silently
  // showing a value that is not what actually runs.
  const shadowedFields = useMemo(() => {
    if (!data) return [];
    return FIELDS.filter((field) => {
      const raw = data.overrides[field.overrideKey];
      if (raw === null || raw === '') return false;
      const overrideValue = Number(raw);
      return Number.isFinite(overrideValue) && overrideValue !== data.limits[field.limitKey];
    });
  }, [data]);

  const handleSave = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!data || !changed || invalidField || saveMutation.loading) return;
    setToast(null);
    saveMutation.reset();

    const payload: Partial<Record<FieldKey, number>> = {};
    for (const field of FIELDS) {
      const value = Number(form[field.key].trim());
      const base = baseline[field.key];
      if (base === null || value !== base) payload[field.key] = value;
    }
    if (Object.keys(payload).length === 0) return;

    const result = await saveMutation.mutate(payload);
    if (result) {
      setToast({ type: 'success', message: t('cyberlab.settings.saved') });
      await config.refetch();
    }
    // On failure the server's own message (400 out of bounds / validation)
    // lands in saveMutation.error and is rendered below.
  };

  if (config.error && !data) {
    return (
      <ErrorState
        error={config.error}
        onRetry={config.refetch}
        title={t('cyberlab.settings.failedLoad')}
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">
            {t('cyberlab.settings.title')}
          </h1>
        </div>
        <button
          onClick={() => config.refetch()}
          disabled={config.loading}
          className="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50 transition-colors"
        >
          <SlidersHorizontal className="w-4 h-4" />
          {t('common.refresh')}
        </button>
      </div>

      <p className="text-sm text-gray-600 dark:text-gray-300">{t('cyberlab.settings.subtitle')}</p>

      {toast && <AlertBanner type={toast.type} message={toast.message} onClose={() => setToast(null)} />}
      {saveMutation.error && !toast && <AlertBanner type="error" message={saveMutation.error} />}

      {!data ? (
        config.loading ? (
          <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
            <LoadingSpinner size="sm" />
            {t('common.loading')}
          </div>
        ) : (
          <p className="text-sm text-gray-500 dark:text-gray-400">{t('common.error')}</p>
        )
      ) : (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="bg-white dark:bg-gray-900 rounded-xl border border-slate-200 dark:border-gray-700 p-4 shadow-sm shadow-slate-200/60">
              <h2 className="text-sm font-semibold text-slate-900 dark:text-white mb-1">
                {t('cyberlab.settings.effective')}
              </h2>
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
                {t('cyberlab.settings.effectiveHelp')}
              </p>
              <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                {FIELDS.map((field) => (
                  <li key={field.key} className="py-2 flex items-center justify-between gap-3">
                    <span className="text-sm text-gray-600 dark:text-gray-300">{t(field.labelKey)}</span>
                    <span className="text-sm font-medium text-slate-900 dark:text-white">
                      {data.limits[field.limitKey]} {t(field.unitKey)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="bg-white dark:bg-gray-900 rounded-xl border border-slate-200 dark:border-gray-700 p-4 shadow-sm shadow-slate-200/60">
              <h2 className="text-sm font-semibold text-slate-900 dark:text-white mb-1">
                {t('cyberlab.settings.overrides')}
              </h2>
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
                {t('cyberlab.settings.overrideHelp')}
              </p>
              <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                {FIELDS.map((field) => {
                  const raw = data.overrides[field.overrideKey];
                  const hasOverride = raw !== null && raw !== '';
                  return (
                    <li key={field.key} className="py-2 flex items-center justify-between gap-3">
                      <span className="text-sm text-gray-600 dark:text-gray-300">
                        {t(field.labelKey)}
                      </span>
                      <span
                        className={`text-sm font-medium ${
                          hasOverride
                            ? 'text-slate-900 dark:text-white'
                            : 'text-gray-400 dark:text-gray-500'
                        }`}
                      >
                        {hasOverride ? `${raw} ${t(field.unitKey)}` : t('cyberlab.common.none')}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>

          <div className="flex items-start gap-2 text-xs text-gray-500 dark:text-gray-400">
            <Info className="w-4 h-4 mt-0.5 shrink-0" />
            <p>{t('cyberlab.settings.envPrecedence')}</p>
          </div>

          {shadowedFields.length > 0 && (
            <AlertBanner
              type="warning"
              message={shadowedFields.map((field) => t(field.labelKey)).join(' · ') + ' — ' + t('cyberlab.settings.envShadowed')}
            />
          )}

          <div className="bg-white dark:bg-gray-900 rounded-xl border border-slate-200 dark:border-gray-700 p-4 shadow-sm shadow-slate-200/60">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-white mb-3">
              {t('cyberlab.settings.editTitle')}
            </h2>

            {!canManage ? (
              <p className="text-sm text-gray-600 dark:text-gray-300">{t('cyberlab.settings.noPermission')}</p>
            ) : (
              <form onSubmit={handleSave} className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  {FIELDS.map((field) => {
                    const bounds = data.bounds[field.boundKey];
                    const shadowed =
                      shadowedFields.some((candidate) => candidate.key === field.key);
                    const isInvalid = invalidField === field.key;
                    return (
                      <div key={field.key}>
                        <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                          {t(field.labelKey)}
                        </label>
                        <input
                          type="number"
                          inputMode="numeric"
                          min={bounds.min}
                          max={bounds.max}
                          step={1}
                          value={form[field.key]}
                          onChange={(event) =>
                            setForm((previous) => ({ ...previous, [field.key]: event.target.value }))
                          }
                          aria-invalid={isInvalid}
                          className={`w-full px-3 py-2 text-sm bg-gray-100 dark:bg-gray-800 border rounded-lg text-gray-900 dark:text-white focus:ring-2 outline-none ${
                            isInvalid
                              ? 'border-red-400 focus:ring-red-400'
                              : 'border-transparent focus:ring-blue-500'
                          }`}
                        />
                        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                          {t('cyberlab.settings.range')}: {bounds.min}–{bounds.max} {t(field.unitKey)}
                        </p>
                        {shadowed && (
                          <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                            {t('cyberlab.settings.envShadowed')}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>

                {invalidField && (
                  <p className="text-xs text-red-500 dark:text-red-400">
                    {t('cyberlab.settings.outOfRange')}
                  </p>
                )}

                <div className="flex items-center gap-3">
                  <button
                    type="submit"
                    disabled={!changed || invalidField !== null || saveMutation.loading}
                    className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {saveMutation.loading ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Save className="w-4 h-4" />
                    )}
                    {saveMutation.loading ? t('cyberlab.settings.saving') : t('common.save')}
                  </button>
                  {!changed && !saveMutation.loading && (
                    <span className="text-xs text-gray-500 dark:text-gray-400">
                      {t('cyberlab.settings.noChanges')}
                    </span>
                  )}
                </div>
              </form>
            )}
          </div>
        </>
      )}
    </div>
  );
}
