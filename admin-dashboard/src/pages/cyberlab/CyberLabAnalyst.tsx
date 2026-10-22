import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { FlaskConical, Loader2, Play, Upload, ArrowRight } from 'lucide-react';
import { useApiMutation } from '../../hooks/useApi';
import { useAuth } from '../../contexts/AuthContext';
import AlertBanner from '../../components/AlertBanner';
import CyberLabStateBadge from '../../components/CyberLabStateBadge';
import { useI18n } from '../../i18n';

type PlanStep = {
  op: 'js_analysis' | 'go_binary' | 'rust_binary';
  risk: 'low' | 'medium' | 'high';
  needsApproval: boolean;
};

type PlanResponse =
  | { state: 'not_configured' }
  | { state: 'invalid_plan' }
  | { state: 'error'; message: string }
  | { state: 'ok'; steps: PlanStep[] };

type Job = { id: string; type: string; status: string; error: string | null };

const QUESTION_MIN = 3;
const QUESTION_MAX = 2000;

const riskChip: Record<string, string> = {
  low: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  medium: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  high: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
};

function readFileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : '');
    };
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

export default function CyberLabAnalyst() {
  const { t } = useI18n();
  const { hasPermission } = useAuth();
  const canManage = hasPermission('cyberlab.manage');

  const [question, setQuestion] = useState('');
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [artifact, setArtifact] = useState<{ id: string; name: string } | null>(null);
  const [runningIndex, setRunningIndex] = useState<number | null>(null);
  const [stepJobs, setStepJobs] = useState<Record<number, Job>>({});

  const planMutation = useApiMutation<PlanResponse, { question: string }>('/cyberlab/ai/plan', 'POST');
  const artifactMutation = useApiMutation<{ artifact: { id: string } }>('/cyberlab/artifacts', 'POST');
  const jobMutation = useApiMutation<{ job: Job; started: boolean }>('/cyberlab/jobs', 'POST');

  const handlePlan = async (event: React.FormEvent) => {
    event.preventDefault();
    if (planMutation.loading) return;
    const trimmed = question.trim();
    if (trimmed.length < QUESTION_MIN) {
      setToast({ type: 'error', message: t('cyberlab.analyst.tooShort') });
      return;
    }
    setToast(null);
    setPlan(null);
    planMutation.reset();
    const result = await planMutation.mutate({ question: trimmed });
    if (result) {
      setPlan(result);
    }
    // Failure: the server's message lands in planMutation.error and is
    // rendered below as an AlertBanner (no second, vaguer toast).
  };

  const handleUpload = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!file || artifactMutation.loading) return;
    setToast(null);
    artifactMutation.reset();
    try {
      const contentBase64 = await readFileBase64(file);
      const response = await artifactMutation.mutate({
        name: name.trim() || file.name,
        contentBase64,
      });
      if (response?.artifact?.id) {
        setArtifact({ id: response.artifact.id, name: name.trim() || file.name });
        setFile(null);
        setName('');
        setToast({ type: 'success', message: t('cyberlab.analyst.artifactReady') });
      }
      // else: the server's message is rendered by the uploadError banner.
    } catch {
      setToast({ type: 'error', message: t('cyberlab.analyst.uploadFailed') });
    }
  };

  const handleRun = async (index: number, step: PlanStep) => {
    if (!artifact || runningIndex !== null) return;
    setToast(null);
    jobMutation.reset();
    setRunningIndex(index);
    const result = await jobMutation.mutate({ type: step.op, artifactId: artifact.id });
    if (result?.job) {
      setStepJobs((previous) => ({ ...previous, [index]: result.job }));
      setToast({ type: 'success', message: t('cyberlab.analyst.jobCreated') });
    }
    // else: the runError banner below carries the server's own message.
    setRunningIndex(null);
  };

  const stepBlockReason = (step: PlanStep): string | null => {
    if (step.needsApproval) return t('cyberlab.analyst.approvalComingSoon');
    if (!canManage) return t('cyberlab.analyst.noPermission');
    if (!artifact) return t('cyberlab.analyst.uploadFirst');
    if (runningIndex !== null) return t('cyberlab.analyst.running');
    return null;
  };

  const uploadError = artifactMutation.error ? mapUploadError(artifactMutation.error, t) : null;
  const runError = jobMutation.error ? mapRunError(jobMutation.error, t) : null;
  const planError = planMutation.error ? mapPlanError(planMutation.error, t) : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">
            {t('nav.cyberlab.analyst')}
          </h1>
          <CyberLabStateBadge state="experimental" />
        </div>
      </div>

      <p className="text-sm text-gray-600 dark:text-gray-300">{t('cyberlab.analyst.subtitle')}</p>

      {toast && <AlertBanner type={toast.type} message={toast.message} onClose={() => setToast(null)} />}
      {uploadError && <AlertBanner type="error" message={uploadError} />}
      {runError && <AlertBanner type="error" message={runError} />}
      {planError && <AlertBanner type="error" message={planError} />}

      {canManage && (
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-slate-200 dark:border-gray-700 p-4 shadow-sm shadow-slate-200/60">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-white mb-1">
            {t('cyberlab.analyst.artifactTitle')}
          </h2>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
            {t('cyberlab.analyst.artifactHelp')}
          </p>

          {artifact && (
            <p className="mb-3 inline-flex items-center gap-2 text-xs font-medium text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/20 px-2.5 py-1 rounded-full">
              <FlaskConical className="w-3.5 h-3.5" />
              {t('cyberlab.analyst.artifactReady')}: {artifact.name}
            </p>
          )}

          <form onSubmit={handleUpload} className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
            <div>
              <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                {t('cyberlab.jobs.file')}
              </label>
              <input
                type="file"
                onChange={(event) => {
                  const selected = event.target.files?.[0] ?? null;
                  setFile(selected);
                  if (selected && !name) setName(selected.name);
                }}
                className="block w-full text-sm text-gray-600 dark:text-gray-300 file:mr-3 file:px-3 file:py-2 file:rounded-lg file:border-0 file:bg-slate-100 dark:file:bg-slate-800 file:text-sm file:text-gray-700 dark:file:text-gray-300"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                {t('cyberlab.jobs.name')}
              </label>
              <input
                type="text"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={file ? file.name : t('cyberlab.jobs.selectFile')}
                className="w-full px-3 py-2 text-sm bg-gray-100 dark:bg-gray-800 border border-transparent rounded-lg text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
              />
            </div>
            <div>
              <button
                type="submit"
                disabled={!file || artifactMutation.loading}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {artifactMutation.loading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Upload className="w-4 h-4" />
                )}
                {artifactMutation.loading ? t('cyberlab.analyst.uploading') : t('cyberlab.analyst.upload')}
              </button>
            </div>
          </form>
        </div>
      )}

      <form
        onSubmit={handlePlan}
        className="bg-white dark:bg-gray-900 rounded-xl border border-slate-200 dark:border-gray-700 p-4 shadow-sm shadow-slate-200/60"
      >
        <label className="block text-sm font-semibold text-slate-900 dark:text-white mb-1">
          {t('cyberlab.analyst.questionLabel')}
        </label>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">{t('cyberlab.analyst.proposeOnly')}</p>
        <textarea
          value={question}
          onChange={(event) => setQuestion(event.target.value.slice(0, QUESTION_MAX))}
          rows={3}
          maxLength={QUESTION_MAX}
          placeholder={t('cyberlab.analyst.placeholder')}
          className="w-full px-3 py-2 text-sm bg-gray-100 dark:bg-gray-800 border border-transparent rounded-lg text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none resize-y"
        />
        <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {question.length}/{QUESTION_MAX}
          </span>
          <button
            type="submit"
            disabled={planMutation.loading || question.trim().length < QUESTION_MIN}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {planMutation.loading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <FlaskConical className="w-4 h-4" />
            )}
            {planMutation.loading ? t('cyberlab.analyst.planning') : t('cyberlab.analyst.plan')}
          </button>
        </div>
      </form>

      {plan && plan.state === 'not_configured' && (
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-slate-200 dark:border-gray-700 p-4 shadow-sm shadow-slate-200/60">
          <p className="text-sm text-gray-700 dark:text-gray-300">{t('cyberlab.analyst.notConfigured')}</p>
        </div>
      )}

      {plan && plan.state === 'invalid_plan' && (
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-slate-200 dark:border-gray-700 p-4 shadow-sm shadow-slate-200/60">
          <p className="text-sm text-gray-700 dark:text-gray-300">{t('cyberlab.analyst.invalidPlan')}</p>
        </div>
      )}

      {plan && plan.state === 'error' && (
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-red-200 dark:border-red-900/50 p-4 shadow-sm">
          <p className="text-sm text-red-700 dark:text-red-300">{t('cyberlab.analyst.providerFailed')}</p>
          <p className="mt-1 text-xs font-mono text-red-600 dark:text-red-400 break-words">
            {plan.message}
          </p>
        </div>
      )}

      {plan && plan.state === 'ok' && (
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-slate-200 dark:border-gray-700 p-4 shadow-sm shadow-slate-200/60 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
              {t('cyberlab.analyst.planTitle')}
            </h2>
            <span className="text-xs text-gray-500 dark:text-gray-400">
              {t('cyberlab.analyst.stepCount')}: {plan.steps.length}
            </span>
          </div>

          <p className="text-xs text-gray-500 dark:text-gray-400">{t('cyberlab.analyst.neverAuto')}</p>

          {plan.steps.length === 0 ? (
            <p className="text-sm text-gray-600 dark:text-gray-300">{t('cyberlab.analyst.noSteps')}</p>
          ) : (
            <>
              <p className="text-xs text-amber-600 dark:text-amber-400">
                {t('cyberlab.analyst.approvalNote')}
              </p>
              <ul className="space-y-3">
                {plan.steps.map((step, index) => {
                  const blockReason = stepBlockReason(step);
                  const job = stepJobs[index];
                  return (
                    <li
                      key={`${step.op}-${index}`}
                      className="flex flex-wrap items-center gap-3 border border-slate-200 dark:border-gray-700 rounded-lg px-3 py-2.5"
                    >
                      <span className="text-xs font-mono text-gray-400 dark:text-gray-500 w-6 shrink-0">
                        #{index + 1}
                      </span>
                      <span className="text-sm font-medium text-slate-900 dark:text-white">
                        {t(`cyberlab.type.${step.op}`)}
                      </span>
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                          riskChip[step.risk] || riskChip.low
                        }`}
                      >
                        {t('cyberlab.analyst.risk')}: {t(`cyberlab.severity.${step.risk}`)}
                      </span>
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                          step.needsApproval
                            ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                            : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'
                        }`}
                      >
                        {step.needsApproval
                          ? t('cyberlab.analyst.needsApproval')
                          : t('cyberlab.analyst.noApproval')}
                      </span>

                      <div className="ml-auto flex items-center gap-3">
                        {job && (
                          <Link
                            to={`/cyberlab/jobs/${job.id}`}
                            className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline"
                          >
                            {t('cyberlab.analyst.viewJob')}
                            <ArrowRight className="w-3.5 h-3.5" />
                          </Link>
                        )}
                        <span title={blockReason ?? undefined}>
                          <button
                            type="button"
                            onClick={() => handleRun(index, step)}
                            disabled={Boolean(blockReason) || runningIndex !== null}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                          >
                            {runningIndex === index ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <Play className="w-3.5 h-3.5" />
                            )}
                            {runningIndex === index
                              ? t('cyberlab.analyst.running')
                              : t('cyberlab.analyst.run')}
                          </button>
                        </span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// Server messages that mean something specific to the operator get a clear
// local wording; anything else is shown verbatim (it is already honest).
function mapUploadError(message: string, t: (key: string) => string): string {
  if (/exceeds the maximum size/i.test(message)) return t('cyberlab.jobs.uploadTooLarge');
  if (/valid base64/i.test(message)) return t('cyberlab.analyst.uploadFailed');
  return message;
}

function mapRunError(message: string, t: (key: string) => string): string {
  if (/Engine provider is not available/i.test(message)) return t('cyberlab.jobs.engineNotConfigured');
  if (/permission|403|forbidden/i.test(message)) return t('cyberlab.analyst.noPermission');
  return message;
}

function mapPlanError(message: string, t: (key: string) => string): string {
  if (/permission|403|forbidden/i.test(message)) return t('common.permissionDeniedBody');
  if (/question/i.test(message)) return t('cyberlab.analyst.tooShort');
  return message;
}
