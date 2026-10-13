import React, { useState, useCallback } from 'react';
import {
  Globe,
  Search,
  MapPin,
  Network,
  Server,
  Mail,
  Phone,
  Car,
  History,
  Settings,
  Trash2,
  RefreshCw,
  ExternalLink,
  Shield,
  AlertTriangle,
  CheckCircle2,
  XCircle,
} from 'lucide-react';
import api from '../services/api';
import { useAuth } from '../contexts/AuthContext';
import { useI18n } from '../i18n';
import SearchInput from '../components/SearchInput';
import AlertBanner from '../components/AlertBanner';
import LoadingSpinner from '../components/LoadingSpinner';

type LookupType = 'ip' | 'domain' | 'email' | 'phone' | 'vin' | 'subdomain' | 'port';

interface OsintResult {
  id: string;
  type: LookupType;
  target: string;
  result: {
    type: LookupType;
    target: string;
    timestamp: string;
    sources: string[];
    data: any;
    errors?: string[];
  };
  created_at: string;
}

interface HistoryItem {
  id: string;
  type: LookupType;
  target: string;
  sources: string[];
  created_at: string;
}

interface ApiSettings {
  shodan: { configured: boolean; masked: string };
  hibp: { configured: boolean; masked: string };
  numverify: { configured: boolean; masked: string };
}

const TYPE_OPTIONS: { value: LookupType; labelKey: string }[] = [
  { value: 'ip', labelKey: 'osint.type.ip' },
  { value: 'domain', labelKey: 'osint.type.domain' },
  { value: 'email', labelKey: 'osint.type.email' },
  { value: 'phone', labelKey: 'osint.type.phone' },
  { value: 'vin', labelKey: 'osint.type.vin' },
  { value: 'subdomain', labelKey: 'osint.type.subdomain' },
  { value: 'port', labelKey: 'osint.type.port' },
];

const TYPE_ICONS: Record<LookupType, React.ComponentType<{ className?: string }>> = {
  ip: MapPin,
  domain: Globe,
  email: Mail,
  phone: Phone,
  vin: Car,
  subdomain: Network,
  port: Server,
};

function formatTimeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'agora';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  return `${days}d`;
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  if (value === undefined || value === null || value === '') return null;
  return (
    <div className="flex justify-between items-start py-1.5 border-b border-gray-100 dark:border-gray-700 last:border-0">
      <span className="text-xs text-gray-500 dark:text-gray-400 shrink-0 mr-4">{label}</span>
      <span className="text-sm text-gray-900 dark:text-white text-right break-all">{value}</span>
    </div>
  );
}

function Section({ title, icon: Icon, children }: { title: string; icon: React.ComponentType<{ className?: string }>; children: React.ReactNode }) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
      <div className="px-4 py-3 bg-gray-50 dark:bg-gray-750 border-b border-gray-200 dark:border-gray-700 flex items-center gap-2">
        <Icon className="w-4 h-4 text-blue-500" />
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">{title}</h3>
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

function EmptySection({ message }: { message: string }) {
  return <p className="text-sm text-gray-500 dark:text-gray-400 italic">{message}</p>;
}

export default function OsintPage() {
  const { hasPermission } = useAuth();
  const { t } = useI18n();
  const canManage = hasPermission('osint.manage');

  const [lookupType, setLookupType] = useState<LookupType>('ip');
  const [target, setTarget] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<OsintResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historySearch, setHistorySearch] = useState('');
  const [historyPage, setHistoryPage] = useState(1);
  const [historyTotal, setHistoryTotal] = useState(0);

  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<ApiSettings | null>(null);
  const [shodanKey, setShodanKey] = useState('');
  const [hibpKey, setHibpKey] = useState('');
  const [numverifyKey, setNumverifyKey] = useState('');
  const [savingSettings, setSavingSettings] = useState(false);

  const loadHistory = useCallback(async (page = 1, search = '') => {
    setHistoryLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: '20' });
      if (search) params.set('search', search);
      const res = await api.request<{ data: { lookups: HistoryItem[]; pagination: { total: number } } }>(`/osint/lookups?${params}`);
      setHistory(res.data.lookups);
      setHistoryTotal(res.data.pagination.total);
      setHistoryPage(page);
    } catch {
      // silent
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  React.useEffect(() => { loadHistory(); }, [loadHistory]);

  const handleLookup = async () => {
    if (!target.trim()) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await api.request<{ data: OsintResult }>(`/osint/lookup`, {
        method: 'POST',
        body: JSON.stringify({ type: lookupType, target: target.trim() }),
      });
      setResult(res.data);
      loadHistory();
    } catch (e: any) {
      setError(e?.message || 'Lookup failed');
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await api.request(`/osint/lookups/${id}`, { method: 'DELETE' });
      loadHistory(historyPage, historySearch);
      setToast({ type: 'success', message: 'Lookup eliminado' });
    } catch {
      setToast({ type: 'error', message: 'Erro ao eliminar' });
    }
  };

  const loadSettings = async () => {
    try {
      const res = await api.request<{ data: { settings: ApiSettings } }>('/osint/settings');
      setSettings(res.data.settings);
      setShodanKey('');
      setHibpKey('');
      setNumverifyKey('');
    } catch {
      // silent
    }
  };

  const openSettings = () => {
    loadSettings();
    setShowSettings(true);
  };

  const saveSettings = async () => {
    setSavingSettings(true);
    try {
      const payload: Record<string, string> = {};
      if (shodanKey.trim()) payload.shodan_api_key = shodanKey.trim();
      if (hibpKey.trim()) payload.hibp_api_key = hibpKey.trim();
      if (numverifyKey.trim()) payload.numverify_api_key = numverifyKey.trim();
      if (Object.keys(payload).length === 0) {
        setShowSettings(false);
        return;
      }
      await api.request('/osint/settings', { method: 'PUT', body: JSON.stringify(payload) });
      setToast({ type: 'success', message: 'Chaves guardadas' });
      setShowSettings(false);
    } catch {
      setToast({ type: 'error', message: 'Erro ao guardar chaves' });
    } finally {
      setSavingSettings(false);
    }
  };

  const renderResults = () => {
    if (!result?.result?.data) return <EmptySection message={t('osint.results.empty')} />;
    const data = result.result.data;
    const sections: React.ReactNode[] = [];

    if (data.ip) {
      sections.push(
        <Section key="geo" title={t('osint.section.geolocation')} icon={MapPin}>
          <Field label={t('osint.field.country')} value={data.ip.country ? `${data.ip.country}${data.ip.countryCode ? ` (${data.ip.countryCode})` : ''}` : ''} />
          <Field label={t('osint.field.region')} value={data.ip.regionName} />
          <Field label={t('osint.field.city')} value={data.ip.city} />
          <Field label={t('osint.field.zip')} value={data.ip.zip} />
          <Field label={t('osint.field.lat')} value={data.ip.lat} />
          <Field label={t('osint.field.lon')} value={data.ip.lon} />
          <Field label={t('osint.field.timezone')} value={data.ip.timezone} />
        </Section>
      );
      sections.push(
        <Section key="net" title={t('osint.section.network')} icon={Network}>
          <Field label={t('osint.field.isp')} value={data.ip.isp} />
          <Field label={t('osint.field.org')} value={data.ip.org} />
          <Field label={t('osint.field.as')} value={data.ip.as} />
          <Field label={t('osint.field.asname')} value={data.ip.asname} />
          <Field label={t('osint.field.reverse')} value={data.ip.reverse} />
        </Section>
      );
    }

    if (data.dns) {
      const dns = data.dns;
      sections.push(
        <Section key="dns" title={t('osint.section.dns')} icon={Server}>
          <Field label="A" value={dns.a?.join(', ')} />
          <Field label="AAAA" value={dns.aaaa?.join(', ')} />
          <Field label="MX" value={dns.mx?.join(', ')} />
          <Field label="NS" value={dns.ns?.join(', ')} />
          <Field label="CNAME" value={dns.cname?.join(', ')} />
          <Field label="TXT" value={dns.txt?.join(', ')?.slice(0, 200)} />
          <Field label="SOA" value={dns.soa?.join(', ')} />
        </Section>
      );
    }

    if (data.whois) {
      sections.push(
        <Section key="whois" title={t('osint.section.whois')} icon={Shield}>
          <Field label={t('osint.field.registrar')} value={data.whois.registrar} />
          <Field label={t('osint.field.creationDate')} value={data.whois.creationDate} />
          <Field label={t('osint.field.expiryDate')} value={data.whois.expiryDate} />
          <Field label={t('osint.field.nameServers')} value={data.whois.nameServers?.join(', ')} />
          <Field label={t('osint.field.status')} value={data.whois.status?.join(', ')} />
          <Field label={t('osint.field.registrantOrg')} value={data.whois.registrantOrg} />
          <Field label={t('osint.field.registrantCountry')} value={data.whois.registrantCountry} />
        </Section>
      );
    }

    if (data.subdomains) {
      sections.push(
        <Section key="subdomains" title={t('osint.section.subdomains')} icon={Network}>
          {data.subdomains.length === 0 ? (
            <EmptySection message="Nenhum subdomínio encontrado" />
          ) : (
            <div className="max-h-64 overflow-y-auto space-y-1">
              {data.subdomains.slice(0, 100).map((sub: any, i: number) => (
                <div key={i} className="flex items-center justify-between py-1 px-2 bg-gray-50 dark:bg-gray-750 rounded text-sm">
                  <span className="text-gray-900 dark:text-white font-mono text-xs">{sub.domain}</span>
                  <span className="text-[10px] text-gray-500 dark:text-gray-400">{sub.source}</span>
                </div>
              ))}
            </div>
          )}
        </Section>
      );
    }

    if (data.email) {
      sections.push(
        <Section key="email" title={t('osint.section.email')} icon={Mail}>
          <Field label={t('osint.field.provider')} value={data.email.provider} />
          <Field label={t('osint.field.mxRecords')} value={data.email.mxRecords?.join(', ')} />
          <Field label={t('osint.field.isDisposable')} value={
            data.email.isDisposable ? (
              <span className="inline-flex items-center gap-1 text-red-600 dark:text-red-400">
                <XCircle className="w-3 h-3" /> Sim
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-green-600 dark:text-green-400">
                <CheckCircle2 className="w-3 h-3" /> Não
              </span>
            )
          } />
          {data.email.breaches && data.email.breaches.length > 0 && (
            <div className="mt-2">
              <p className="text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">{t('osint.field.breaches')} ({data.email.breaches.length})</p>
              <div className="max-h-40 overflow-y-auto space-y-1">
                {data.email.breaches.map((b: any, i: number) => (
                  <div key={i} className="text-xs py-1 px-2 bg-red-50 dark:bg-red-900/20 rounded">
                    <span className="font-medium text-red-700 dark:text-red-300">{b.name}</span>
                    <span className="text-gray-500 dark:text-gray-400 ml-2">{b.breachDate}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Section>
      );
    }

    if (data.phone) {
      sections.push(
        <Section key="phone" title={t('osint.section.phone')} icon={Phone}>
          <Field label={t('osint.field.valid')} value={
            data.phone.valid ? (
              <span className="inline-flex items-center gap-1 text-green-600 dark:text-green-400">
                <CheckCircle2 className="w-3 h-3" /> Sim
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-red-600 dark:text-red-400">
                <XCircle className="w-3 h-3" /> Não
              </span>
            )
          } />
          <Field label={t('osint.field.country')} value={data.phone.country ? `${data.phone.country}${data.phone.countryCode ? ` (${data.phone.countryCode})` : ''}` : ''} />
          <Field label={t('osint.field.carrier')} value={data.phone.carrier} />
          <Field label={t('osint.field.lineType')} value={data.phone.lineType} />
          <Field label={t('osint.field.e164')} value={data.phone.e164} />
        </Section>
      );
    }

    if (data.vin) {
      sections.push(
        <Section key="vin" title={t('osint.section.vin')} icon={Car}>
          <Field label={t('osint.field.make')} value={data.vin.make} />
          <Field label={t('osint.field.model')} value={data.vin.model} />
          <Field label={t('osint.field.modelYear')} value={data.vin.modelYear} />
          <Field label={t('osint.field.bodyClass')} value={data.vin.bodyClass} />
          <Field label={t('osint.field.manufacturer')} value={data.vin.manufacturer} />
          <Field label={t('osint.field.plantCountry')} value={data.vin.plantCountry} />
          <Field label={t('osint.field.series')} value={data.vin.series} />
          <Field label={t('osint.field.trim')} value={data.vin.trim} />
        </Section>
      );
    }

    if (data.shodan) {
      sections.push(
        <Section key="shodan" title={t('osint.section.shodan')} icon={Shield}>
          <Field label={t('osint.field.ports')} value={data.shodan.ports?.join(', ')} />
          <Field label={t('osint.field.hostnames')} value={data.shodan.hostnames?.join(', ')} />
          <Field label={t('osint.field.org')} value={data.shodan.org} />
          <Field label={t('osint.field.os')} value={data.shodan.os} />
          <Field label={t('osint.field.vulns')} value={data.shodan.vulns?.join(', ')} />
        </Section>
      );
    }

    if (data.ports) {
      const openPorts = data.ports.filter((p: any) => p.state === 'open');
      sections.push(
        <Section key="ports" title={t('osint.section.ports')} icon={Server}>
          {openPorts.length === 0 ? (
            <EmptySection message="Nenhuma porta aberta encontrada" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
                    <th className="pb-2 pr-4">Porta</th>
                    <th className="pb-2 pr-4">Estado</th>
                    <th className="pb-2 pr-4">Serviço</th>
                    <th className="pb-2">Banner</th>
                  </tr>
                </thead>
                <tbody>
                  {openPorts.map((p: any) => (
                    <tr key={p.port} className="border-b border-gray-100 dark:border-gray-700 last:border-0">
                      <td className="py-2 pr-4 font-mono font-medium text-gray-900 dark:text-white">{p.port}</td>
                      <td className="py-2 pr-4">
                        <span className="inline-flex items-center gap-1 text-green-600 dark:text-green-400 text-xs">
                          <CheckCircle2 className="w-3 h-3" /> {t('osint.open')}
                        </span>
                      </td>
                      <td className="py-2 pr-4 text-gray-700 dark:text-gray-300">{p.service || '—'}</td>
                      <td className="py-2 text-xs text-gray-500 dark:text-gray-400 font-mono max-w-xs truncate">{p.banner || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      );
    }

    return sections.length > 0 ? <div className="space-y-4">{sections}</div> : <EmptySection message={t('osint.results.empty')} />;
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
            <Globe className="w-6 h-6 text-blue-500" />
            {t('page.osint.title')}
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{t('osint.subtitle')}</p>
        </div>
        {canManage && (
          <button
            onClick={openSettings}
            className="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
          >
            <Settings className="w-4 h-4" />
            {t('osint.settings.title')}
          </button>
        )}
      </div>

      {toast && <AlertBanner type={toast.type} message={toast.message} onClose={() => setToast(null)} />}
      {error && <AlertBanner type="error" message={error} onClose={() => setError(null)} />}

      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
        <div className="flex flex-col sm:flex-row gap-3">
          <select
            value={lookupType}
            onChange={(e) => setLookupType(e.target.value as LookupType)}
            className="px-3 py-2.5 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent min-w-[140px]"
          >
            {TYPE_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{t(opt.labelKey)}</option>
            ))}
          </select>
          <input
            type="text"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleLookup()}
            placeholder={t('osint.query.placeholder')}
            className="flex-1 px-3 py-2.5 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            disabled={!canManage}
          />
          <button
            onClick={handleLookup}
            disabled={loading || !target.trim() || !canManage}
            className="inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white font-medium rounded-lg transition-colors text-sm"
          >
            {loading ? <LoadingSpinner size="sm" /> : <Search className="w-4 h-4" />}
            {t('osint.query.lookup')}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-4">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">{t('osint.results.title')}</h2>
          {loading ? (
            <div className="flex justify-center py-12"><LoadingSpinner size="lg" /></div>
          ) : result ? (
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                <span className="font-medium text-gray-900 dark:text-white">{result.result.target}</span>
                <span>•</span>
                <span>{result.result.sources.join(', ')}</span>
                {result.result.errors && result.result.errors.length > 0 && (
                  <span className="text-amber-500">({result.result.errors.join('; ')})</span>
                )}
              </div>
              {renderResults()}
            </div>
          ) : (
            <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-12 text-center">
              <Globe className="w-12 h-12 text-gray-300 dark:text-gray-600 mx-auto mb-3" />
              <p className="text-sm text-gray-500 dark:text-gray-400">{t('osint.results.empty')}</p>
            </div>
          )}
        </div>

        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white flex items-center gap-2">
              <History className="w-5 h-5 text-gray-400" />
              {t('osint.history.title')}
            </h2>
            <button
              onClick={() => loadHistory()}
              className="p-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700"
              title="Refresh"
            >
              <RefreshCw className={`w-4 h-4 ${historyLoading ? 'animate-spin' : ''}`} />
            </button>
          </div>
          <SearchInput
            value={historySearch}
            onChange={(v) => { setHistorySearch(v); loadHistory(1, v); }}
          />
          <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-700 max-h-[600px] overflow-y-auto">
            {historyLoading && history.length === 0 ? (
              <div className="p-8 text-center"><LoadingSpinner size="sm" /></div>
            ) : history.length === 0 ? (
              <p className="p-4 text-sm text-gray-500 dark:text-gray-400 text-center">{t('osint.history.empty')}</p>
            ) : (
              history.map((item) => {
                const Icon = TYPE_ICONS[item.type] || Globe;
                return (
                  <div key={item.id} className="p-3 hover:bg-gray-50 dark:hover:bg-gray-750 group">
                    <div className="flex items-start justify-between gap-2">
                      <button
                        onClick={() => { setLookupType(item.type); setTarget(item.target); }}
                        className="flex-1 text-left min-w-0"
                        title={t('osint.history.load')}
                      >
                        <div className="flex items-center gap-2">
                          <Icon className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                          <span className="text-sm font-medium text-gray-900 dark:text-white truncate">{item.target}</span>
                        </div>
                        <div className="mt-0.5 flex items-center gap-2 text-[11px] text-gray-500 dark:text-gray-400">
                          <span>{t(`osint.type.${item.type}`)}</span>
                          <span>•</span>
                          <span>{formatTimeAgo(item.created_at)}</span>
                        </div>
                      </button>
                      {canManage && (
                        <button
                          onClick={() => handleDelete(item.id)}
                          className="opacity-0 group-hover:opacity-100 p-1 text-gray-400 hover:text-red-500 transition-opacity"
                          title={t('osint.history.delete')}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
          {historyTotal > 20 && (
            <div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
              <span>{historyTotal} total</span>
              {historyPage > 1 && (
                <button onClick={() => loadHistory(historyPage - 1, historySearch)} className="hover:text-blue-500">← Anterior</button>
              )}
              {historyPage * 20 < historyTotal && (
                <button onClick={() => loadHistory(historyPage + 1, historySearch)} className="hover:text-blue-500">Seguinte →</button>
              )}
            </div>
          )}
        </div>
      </div>

      {showSettings && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 w-full max-w-md p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white">{t('osint.settings.title')}</h2>
              <button onClick={() => setShowSettings(false)} className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
                <XCircle className="w-5 h-5" />
              </button>
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400">{t('osint.settings.optional')}</p>

            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{t('osint.settings.shodan')}</label>
                <input
                  type="password"
                  value={shodanKey}
                  onChange={(e) => setShodanKey(e.target.value)}
                  placeholder={settings?.shodan.configured ? settings.shodan.masked : 'API key...'}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm"
                />
                {settings?.shodan.configured && (
                  <p className="mt-1 text-xs text-green-600 dark:text-green-400 flex items-center gap-1">
                    <CheckCircle2 className="w-3 h-3" /> {t('osint.settings.masked')}
                  </p>
                )}
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{t('osint.settings.hibp')}</label>
                <input
                  type="password"
                  value={hibpKey}
                  onChange={(e) => setHibpKey(e.target.value)}
                  placeholder={settings?.hibp.configured ? settings.hibp.masked : 'API key...'}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm"
                />
                {settings?.hibp.configured && (
                  <p className="mt-1 text-xs text-green-600 dark:text-green-400 flex items-center gap-1">
                    <CheckCircle2 className="w-3 h-3" /> {t('osint.settings.masked')}
                  </p>
                )}
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{t('osint.settings.numverify')}</label>
                <input
                  type="password"
                  value={numverifyKey}
                  onChange={(e) => setNumverifyKey(e.target.value)}
                  placeholder={settings?.numverify.configured ? settings.numverify.masked : 'API key...'}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm"
                />
                {settings?.numverify.configured && (
                  <p className="mt-1 text-xs text-green-600 dark:text-green-400 flex items-center gap-1">
                    <CheckCircle2 className="w-3 h-3" /> {t('osint.settings.masked')}
                  </p>
                )}
              </div>
            </div>

            <div className="flex justify-end gap-3 pt-2">
              <button
                onClick={() => setShowSettings(false)}
                className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-600"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={saveSettings}
                disabled={savingSettings}
                className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 rounded-lg"
              >
                {savingSettings ? <LoadingSpinner size="sm" /> : t('osint.settings.save')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
