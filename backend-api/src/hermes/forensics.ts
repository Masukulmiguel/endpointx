import { query } from '../config/database';
import logger from '../utils/logger';

/**
 * HERMES forensic investigation engine.
 *
 * Principles enforced here:
 *  - An alert on its own never raises the risk of an endpoint. Only evidence
 *    that the agent actually collected does.
 *  - Every statement is labelled observation / evidence / indicator /
 *    correlation / hypothesis / conclusion.
 *  - Sections the agent did not return (skipped by policy, failed, not
 *    requested) are reported as gaps, never as negative findings.
 */

export type Classification =
  | 'observation'
  | 'evidence'
  | 'indicator'
  | 'correlation'
  | 'hypothesis'
  | 'conclusion';
export type Severity = 'info' | 'low' | 'medium' | 'high' | 'critical';
export type Confidence = 'low' | 'medium' | 'high';
export type InvestigationStatus =
  | 'queued'
  | 'collecting'
  | 'analyzing'
  | 'complete'
  | 'failed';

interface Focus {
  ips: string[];
  domains: string[];
  process_names: string[];
  file_paths: string[];
  since: string;
}

interface ArtifactDraft {
  kind: string;
  classification: Classification;
  title: string;
  detail: string;
  data: Record<string, unknown>;
  severity: Severity;
  confidence: Confidence;
  observedAt: string | null;
  source: string;
}

interface IocDraft {
  iocType: string;
  value: string;
  label: string;
  confidence: Confidence;
  source: string;
}

interface TimelineDraft {
  occurredAt: string | null;
  event: string;
  source: string;
  entity: string;
  evidence: string;
  severity: Severity;
}

interface RelationDraft {
  from: string;
  to: string;
  relation: string;
  basis: string;
}

interface Collector {
  artifacts: ArtifactDraft[];
  iocs: IocDraft[];
  timeline: TimelineDraft[];
  relations: RelationDraft[];
  facts: Record<string, unknown>;
  gaps: { section: string; reason: string }[];
  indicators: number;
  highIndicators: number;
  evidenceCount: number;
}

const FILE_EXTENSIONS = new Set([
  'exe', 'dll', 'sys', 'bat', 'cmd', 'com', 'cpl', 'msi', 'scr', 'ps1', 'psm1',
  'vbs', 'js', 'jse', 'wsf', 'hta', 'jar', 'py', 'rb', 'sh', 'lnk', 'dat', 'log',
  'txt', 'ini', 'cfg', 'json', 'xml', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt',
  'png', 'jpg', 'jpeg', 'gif', 'zip', '7z', 'rar', 'tmp', 'bak',
]);

const TINY_TLDS = new Set(['local', 'internal', 'lan', 'home', 'corp', 'intranet']);

const PRIVATE_PREFIXES = ['10.', '192.168.', '127.', '0.', '169.254.'];

const DROPPER_DIRS = [
  '\\appdata\\', '\\temp\\', '\\tmp\\', '\\downloads\\', '\\programdata\\',
  '/tmp/', '/var/tmp/', '/dev/shm/', '/home/',
];

const LOLBAS = new Set([
  'powershell.exe', 'pwsh.exe', 'cmd.exe', 'wscript.exe', 'cscript.exe',
  'mshta.exe', 'rundll32.exe', 'regsvr32.exe', 'msbuild.exe', 'certutil.exe',
  'bitsadmin.exe', 'wmic.exe', 'msiexec.exe', 'svchost.exe',
]);

const OFFICE_PARENTS = [
  'winword.exe', 'excel.exe', 'powerpnt.exe', 'outlook.exe', 'acrord32.exe',
  'visio.exe', 'msaccess.exe', 'eqnedt32.exe',
];

const NEW = (): Collector => ({
  artifacts: [],
  iocs: [],
  timeline: [],
  relations: [],
  facts: {},
  gaps: [],
  indicators: 0,
  highIndicators: 0,
  evidenceCount: 0,
});

function nowIso(): string {
  return new Date().toISOString();
}

function clampText(value: unknown, limit = 600): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  if (!text) return '';
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function isPrivateIp(ip: string): boolean {
  if (!ip) return true;
  if (PRIVATE_PREFIXES.some((prefix) => ip.startsWith(prefix))) return true;
  if (ip.startsWith('172.')) {
    const second = parseInt(ip.split('.')[1] || '0', 10);
    if (second >= 16 && second <= 31) return true;
  }
  if (ip.includes(':')) return true; // IPv6: treated as non-routable here
  return false;
}

function publicIp(ip: string): boolean {
  return Boolean(ip) && !isPrivateIp(ip);
}

function sectionOf(bundle: any, name: string): any {
  const section = bundle?.sections?.[name];
  if (!section || section.skipped) return null;
  return section;
}

function gapReason(section: any): string {
  if (!section) return 'not_collected';
  if (section.reason) return String(section.reason);
  if (section.error) return String(section.error);
  return 'empty';
}

// ---------------------------------------------------------------------------
// Focus: what the alert points at
// ---------------------------------------------------------------------------

const METADATA_IP_KEYS = ['ip', 'ip_address', 'remote_ip', 'src_ip', 'dst_ip', 'source_ip', 'destination_ip', 'ips'];
const METADATA_DOMAIN_KEYS = ['domain', 'host', 'hostname', 'url', 'domain_name', 'domains'];
const METADATA_PROCESS_KEYS = ['process', 'process_name', 'proc', 'processes'];
const METADATA_FILE_KEYS = ['file', 'file_path', 'path', 'filepath', 'files'];

function pushUnique(target: string[], value: string | undefined | null, limit = 25): void {
  const clean = (value || '').trim();
  if (!clean || target.length >= limit) return;
  if (!target.some((entry) => entry.toLowerCase() === clean.toLowerCase())) target.push(clean);
}

function looksLikeDomain(token: string): boolean {
  const candidate = token.toLowerCase().replace(/^[a-z]+:\/\//, '').split('/')[0].split(':')[0];
  if (!candidate.includes('.')) return false;
  const tld = candidate.split('.').pop() || '';
  if (FILE_EXTENSIONS.has(tld)) return false;
  if (TINY_TLDS.has(tld)) return false;
  if (/^\d+$/.test(tld)) return false;
  return tld.length >= 2 && tld.length <= 24;
}

export function buildFocus(alert: {
  alert_type?: string;
  description?: string | null;
  metadata?: any;
  created_at?: string | null;
}): Focus {
  const focus: Focus = { ips: [], domains: [], process_names: [], file_paths: [], since: '' };
  const meta = alert.metadata && typeof alert.metadata === 'object' ? alert.metadata : {};

  for (const key of METADATA_IP_KEYS) {
    const value = meta[key];
    if (Array.isArray(value)) value.forEach((entry) => pushUnique(focus.ips, String(entry)));
    else pushUnique(focus.ips, value ? String(value) : undefined);
  }
  for (const key of METADATA_DOMAIN_KEYS) {
    const value = meta[key];
    if (Array.isArray(value)) value.forEach((entry) => pushUnique(focus.domains, String(entry)));
    else pushUnique(focus.domains, value ? String(value) : undefined);
  }
  for (const key of METADATA_PROCESS_KEYS) {
    const value = meta[key];
    if (Array.isArray(value)) value.forEach((entry) => pushUnique(focus.process_names, String(entry)));
    else pushUnique(focus.process_names, value ? String(value) : undefined);
  }
  for (const key of METADATA_FILE_KEYS) {
    const value = meta[key];
    if (Array.isArray(value)) value.forEach((entry) => pushUnique(focus.file_paths, String(entry)));
    else pushUnique(focus.file_paths, value ? String(value) : undefined);
  }

  const text = `${alert.description || ''} ${alert.alert_type || ''}`;
  for (const token of text.split(/[\s,;'"()<>[\]{}|]+/)) {
    if (!token) continue;
    if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(token)) {
      pushUnique(focus.ips, token.split(':')[0]);
    } else if (looksLikeDomain(token)) {
      pushUnique(focus.domains, token);
    }
  }

  if (alert.created_at) {
    const created = new Date(alert.created_at);
    if (!Number.isNaN(created.getTime())) {
      created.setHours(created.getHours() - 6);
      focus.since = created.toISOString();
    }
  }
  if (!focus.since) focus.since = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
  return focus;
}

// ---------------------------------------------------------------------------
// Section analysis
// ---------------------------------------------------------------------------

function pushArtifact(col: Collector, draft: ArtifactDraft): void {
  col.artifacts.push(draft);
  if (draft.classification === 'evidence') col.evidenceCount += 1;
  if (draft.classification === 'indicator') {
    col.indicators += 1;
    if (draft.severity === 'critical' || draft.severity === 'high') col.highIndicators += 1;
  }
}

function analyzeProcesses(col: Collector, section: any, focus: Focus): void {
  const processes: any[] = Array.isArray(section?.processes) ? section.processes : [];
  col.facts.processes_total = section?.total_processes ?? processes.length;
  col.facts.processes_returned = processes.length;
  if (!processes.length) {
    col.gaps.push({ section: 'processes', reason: 'no_data_returned' });
    return;
  }

  for (const proc of processes) {
    const name = String(proc.name || '').toLowerCase();
    const exe = String(proc.exe || '');
    const cmdline = String(proc.cmdline || '');
    const isFocus = focus.process_names.some((entry) => entry.toLowerCase() === name);

    if (isFocus) {
      pushArtifact(col, {
        kind: 'process',
        classification: 'observation',
        title: `Focused process present: ${proc.name}`,
        detail: `PID ${proc.pid} running as ${proc.user || 'unknown'}, started ${proc.started_at || 'unknown'}.`,
        data: proc,
        severity: 'info',
        confidence: 'high',
        observedAt: proc.started_at || null,
        source: 'agent:processes',
      });
      col.timeline.push({
        occurredAt: proc.started_at || null,
        event: `Process started: ${proc.name}`,
        source: 'process',
        entity: `PID ${proc.pid}`,
        evidence: exe || cmdline || proc.name,
        severity: 'info',
      });
    }

    const parent = String(proc.parent_name || '').toLowerCase();
    const inDropperDir = DROPPER_DIRS.some((dir) => exe.toLowerCase().includes(dir));
    const officeChild = OFFICE_PARENTS.includes(parent) && LOLBAS.has(name);
    const encoded = /\s-(enc|en|e|ec|encodedcommand)\s|frombase64string|-nop\b|-windowstyle\s+hidden|-exec\s+bypass/i.test(cmdline);

    if (officeChild) {
      pushArtifact(col, {
        kind: 'process',
        classification: 'evidence',
        title: `${proc.parent_name} spawned ${proc.name}`,
        detail: `Process tree fact: parent ${proc.parent_name} (PID ${proc.ppid}) started ${proc.name} (PID ${proc.pid}).`,
        data: proc,
        severity: 'high',
        confidence: 'high',
        observedAt: proc.started_at || null,
        source: 'agent:processes',
      });
      col.relations.push({
        from: `${proc.parent_name}#${proc.ppid}`,
        to: `${proc.name}#${proc.pid}`,
        relation: 'spawned',
        basis: 'process parent pid recorded by the agent',
      });
      col.timeline.push({
        occurredAt: proc.started_at || null,
        event: `Child process created: ${proc.name}`,
        source: 'process',
        entity: `PID ${proc.pid} ← ${proc.parent_name}`,
        evidence: cmdline || exe,
        severity: 'high',
      });
    }

    if (encoded) {
      pushArtifact(col, {
        kind: 'process',
        classification: 'indicator',
        title: `Obfuscated command line on ${proc.name}`,
        detail: `Arguments suggest encoded or hidden execution: ${clampText(cmdline, 300)}`,
        data: { pid: proc.pid, name: proc.name, cmdline },
        severity: 'high',
        confidence: 'medium',
        observedAt: proc.started_at || null,
        source: 'agent:processes',
      });
    }

    if (inDropperDir && /\.(exe|dll|ps1|bat|cmd|vbs|js|hta|scr|msi)$/i.test(exe)) {
      pushArtifact(col, {
        kind: 'file',
        classification: 'indicator',
        title: `Executable running from a user-writable location`,
        detail: `${exe} is running from a folder commonly used for staged payloads (PID ${proc.pid}).`,
        data: { pid: proc.pid, exe, name: proc.name, user: proc.user },
        severity: 'high',
        confidence: 'medium',
        observedAt: proc.started_at || null,
        source: 'agent:processes',
      });
      col.iocs.push({
        iocType: 'file_path',
        value: exe,
        label: proc.name,
        confidence: 'medium',
        source: 'agent:processes',
      });
    }

    if (isFocus && exe) {
      col.iocs.push({
        iocType: 'process',
        value: `${name}#${proc.pid}`,
        label: exe,
        confidence: 'medium',
        source: 'agent:processes',
      });
    }
  }
}

function analyzeConnections(col: Collector, section: any, focus: Focus): void {
  const connections: any[] = Array.isArray(section?.connections) ? section.connections : [];
  col.facts.connections_total = section?.total_connections ?? connections.length;
  col.facts.connections_returned = connections.length;
  if (!connections.length) {
    col.gaps.push({ section: 'connections', reason: 'no_data_returned' });
    return;
  }

  const focusIps = new Set(focus.ips.map((ip) => ip.toLowerCase()));

  for (const conn of connections) {
    const remote = String(conn.remote_ip || '');
    const procName = String(conn.process || '').toLowerCase();
    const isFocusIp = focusIps.has(remote.toLowerCase());
    const external = publicIp(remote);

    if (isFocusIp) {
      pushArtifact(col, {
        kind: 'connection',
        classification: 'evidence',
        title: `Connection to a focused address: ${remote}:${conn.remote_port}`,
        detail: `${conn.process || 'unknown process'} (PID ${conn.pid}) holds ${conn.protocol} ${conn.local_ip}:${conn.local_port} → ${remote}:${conn.remote_port} [${conn.status}].`,
        data: conn,
        severity: 'high',
        confidence: 'high',
        observedAt: null,
        source: 'agent:connections',
      });
      col.relations.push({
        from: `${conn.process || 'unknown'}#${conn.pid}`,
        to: `${remote}:${conn.remote_port}`,
        relation: 'connected_to',
        basis: 'socket ownership recorded by the agent',
      });
      col.timeline.push({
        occurredAt: null,
        event: `Network connection: ${remote}:${conn.remote_port}`,
        source: 'network',
        entity: `${conn.process} (PID ${conn.pid})`,
        evidence: `${conn.protocol} ${conn.status}`,
        severity: 'high',
      });
    } else if (external && LOLBAS.has(procName) && conn.status === 'ESTABLISHED') {
      pushArtifact(col, {
        kind: 'connection',
        classification: 'indicator',
        title: `${conn.process} holds an outbound connection`,
        detail: `System interpreter or scripting host (${conn.process}) is connected to ${remote}:${conn.remote_port}.`,
        data: conn,
        severity: 'high',
        confidence: 'medium',
        observedAt: null,
        source: 'agent:connections',
      });
    }

    if (external && (isFocusIp || LOLBAS.has(procName))) {
      col.iocs.push({
        iocType: 'ip',
        value: remote,
        label: `${conn.process}:${conn.remote_port}`,
        confidence: isFocusIp ? 'high' : 'medium',
        source: 'agent:connections',
      });
    }
  }
}

function analyzeFiles(col: Collector, section: any, focus: Focus): void {
  const files: any[] = Array.isArray(section?.files) ? section.files : [];
  col.facts.files_returned = files.length;
  col.facts.files_focus = section?.focus_files ?? 0;
  if (!files.length) {
    col.gaps.push({ section: 'files', reason: 'no_data_returned' });
    return;
  }

  for (const file of files) {
    const path = String(file.path || '');
    const unsigned = file.signature_status && !/^Valid/i.test(String(file.signature_status));
    const suspiciousExt = /\.(exe|dll|scr|msi|ps1|bat|cmd|vbs|js|hta|jar)$/i.test(path);

    if (file.is_focus) {
      pushArtifact(col, {
        kind: 'file',
        classification: 'evidence',
        title: `File of interest: ${file.name}`,
        detail: `${path} — SHA-256 ${file.sha256 || 'unavailable'} (${file.size_bytes} bytes, created ${file.created_at || 'unknown'}).`,
        data: file,
        severity: 'high',
        confidence: 'high',
        observedAt: file.created_at || null,
        source: 'agent:files',
      });
      col.timeline.push({
        occurredAt: file.created_at || null,
        event: `File created: ${file.name}`,
        source: 'file',
        entity: path,
        evidence: file.sha256 ? `SHA-256 ${file.sha256}` : 'hash unavailable',
        severity: 'high',
      });
    }

    if (file.sha256) {
      col.iocs.push({
        iocType: 'hash_sha256',
        value: String(file.sha256),
        label: path,
        confidence: file.is_focus ? 'high' : 'medium',
        source: 'agent:files',
      });
    }

    if (suspiciousExt && unsigned && !file.is_focus) {
      pushArtifact(col, {
        kind: 'file',
        classification: 'indicator',
        title: `Unsigned executable staged on disk`,
        detail: `${path} is unsigned (${file.signature_status || 'no signature'}) and was modified ${file.modified_at || 'unknown'}.`,
        data: file,
        severity: 'medium',
        confidence: 'low',
        observedAt: file.modified_at || null,
        source: 'agent:files',
      });
    }
  }
}

function analyzePersistence(col: Collector, section: any, focus: Focus): void {
  const items: any[] = Array.isArray(section?.persistence) ? section.persistence : [];
  col.facts.persistence_returned = items.length;
  if (!items.length) {
    col.gaps.push({ section: 'persistence', reason: 'no_data_returned' });
    return;
  }

  const focusNames = focus.process_names.map((name) => name.toLowerCase());
  const valueLooksWritable = (value: string) => {
    const lower = value.toLowerCase();
    return DROPPER_DIRS.some((dir) => lower.includes(dir)) || /%temp%|%appdata%|%userprofile%/.test(lower);
  };

  for (const item of items) {
    const value = String(item.value || '');
    const name = String(item.name || '');
    const mechanism = String(item.mechanism || '');
    const focusHit = focusNames.some((entry) => entry && `${name} ${value}`.toLowerCase().includes(entry));

    if (focusHit) {
      pushArtifact(col, {
        kind: 'persistence',
        classification: 'evidence',
        title: `Persistence references the focused process: ${name}`,
        detail: `${mechanism}: ${name} → ${clampText(value, 300)}`,
        data: item,
        severity: 'high',
        confidence: 'high',
        observedAt: null,
        source: 'agent:persistence',
      });
    }

    if (valueLooksWritable(value) && /run|task|service|startup|launchd|cron|shell_profile/i.test(mechanism)) {
      pushArtifact(col, {
        kind: 'persistence',
        classification: 'indicator',
        title: `Autostart entry pointing at a user-writable path`,
        detail: `${mechanism} "${name}" launches ${clampText(value, 300)} from a location a standard user can modify.`,
        data: item,
        severity: 'high',
        confidence: 'medium',
        observedAt: null,
        source: 'agent:persistence',
      });
      col.iocs.push({
        iocType: mechanism.includes('registry') ? 'registry_key' : mechanism,
        value: `${name}=${value}`,
        label: mechanism,
        confidence: 'medium',
        source: 'agent:persistence',
      });
      col.timeline.push({
        occurredAt: null,
        event: `Persistence mechanism present: ${mechanism}`,
        source: 'persistence',
        entity: name,
        evidence: clampText(value, 300),
        severity: 'high',
      });
    } else if (focusHit) {
      col.iocs.push({
        iocType: mechanism.includes('registry') ? 'registry_key' : mechanism,
        value: `${name}=${value}`,
        label: mechanism,
        confidence: 'high',
        source: 'agent:persistence',
      });
    }
  }
}

function analyzeBrowser(col: Collector, section: any, focus: Focus): void {
  const browsers: any[] = Array.isArray(section?.browsers) ? section.browsers : [];
  col.facts.browsers_examined = browsers.length;
  if (!browsers.length) {
    col.gaps.push({ section: 'browser', reason: 'no_data_returned' });
    return;
  }

  const domains = focus.domains.map((domain) => domain.toLowerCase().replace(/^www\./, ''));
  const focusHits: any[] = [];

  for (const browser of browsers) {
    for (const entry of browser.history || []) {
      const url = String(entry.url || '');
      const hit = domains.some((domain) => url.toLowerCase().includes(domain));
      if (hit) {
        focusHits.push({ ...entry, browser: browser.browser, profile: browser.profile });
        col.timeline.push({
          occurredAt: entry.last_visit_at || null,
          event: `URL visited: ${url}`,
          source: 'browser',
          entity: `${browser.browser} (${browser.profile})`,
          evidence: `visit_count=${entry.visit_count}`,
          severity: 'medium',
        });
      }
    }
    for (const download of browser.downloads || []) {
      const target = String(download.target_path || download.destination_url || '');
      const source = String(download.source_url || '');
      const isExecutable = /\.(exe|msi|scr|bat|cmd|ps1|vbs|js|jar|zip|rar|7z)$/i.test(target);
      const focusHit = domains.some((domain) => `${target} ${source}`.toLowerCase().includes(domain));

      if (focusHit || isExecutable) {
        pushArtifact(col, {
          kind: 'browser',
          classification: 'evidence',
          detail: `${browser.browser} (${browser.profile}) recorded a download: ${target || source}.`,
          title: `Download recorded: ${target.split(/[\\/]/).pop() || source}`,
          data: { ...download, browser: browser.browser, profile: browser.profile },
          severity: focusHit ? 'high' : 'medium',
          confidence: 'high',
          observedAt: download.started_at || null,
          source: 'agent:browser',
        });
        col.timeline.push({
          occurredAt: download.started_at || null,
          event: `Download: ${target.split(/[\\/]/).pop() || source}`,
          source: 'browser',
          entity: `${browser.browser}`,
          evidence: source || target,
          severity: 'high',
        });
        if (source) {
          col.iocs.push({
            iocType: 'url',
            value: source,
            label: target,
            confidence: 'medium',
            source: 'agent:browser',
          });
        }
      }
    }
  }

  if (focusHits.length) {
    pushArtifact(col, {
      kind: 'browser',
      classification: 'evidence',
      title: `Focused address present in browser history (${focusHits.length} hit(s))`,
      detail:
        'The agent observed that these URLs were visited. This is evidence of access only — ' +
        'it does not establish that a link was clicked or that a download was started.',
      data: { hits: focusHits.slice(0, 50) },
      severity: 'medium',
      confidence: 'high',
      observedAt: focusHits[0]?.last_visit_at || null,
      source: 'agent:browser',
    });
    for (const hit of focusHits.slice(0, 25)) {
      col.iocs.push({
        iocType: 'url',
        value: String(hit.url),
        label: hit.title || '',
        confidence: 'medium',
        source: 'agent:browser',
      });
    }
  }
}

function analyzeEvents(col: Collector, section: any, focus: Focus): void {
  const events: any[] = Array.isArray(section?.events) ? section.events : [];
  col.facts.events_returned = events.length;
  if (!events.length) {
    col.gaps.push({ section: 'events', reason: 'no_data_returned' });
    return;
  }

  const focusNames = focus.process_names.map((name) => name.toLowerCase());
  const focusIps = focus.ips.map((ip) => ip.toLowerCase());

  for (const event of events) {
    const id = Number(event.id);
    const message = String(event.message || '');
    const lower = message.toLowerCase();
    const focusedProcess = focusNames.find((name) => name && lower.includes(name));
    const focusedIp = focusIps.find((ip) => ip && lower.includes(ip));

    if (id === 4688 && focusedProcess) {
      pushArtifact(col, {
        kind: 'event',
        classification: 'evidence',
        title: `Process creation logged: ${focusedProcess}`,
        detail: clampText(message, 600),
        data: event,
        severity: 'high',
        confidence: 'high',
        observedAt: event.time || null,
        source: 'eventlog:Security',
      });
      col.timeline.push({
        occurredAt: event.time || null,
        event: `Process creation logged (4688): ${focusedProcess}`,
        source: 'eventlog',
        entity: event.log,
        evidence: clampText(message, 400),
        severity: 'high',
      });
    } else if (id === 7045 || id === 4697) {
      pushArtifact(col, {
        kind: 'event',
        classification: 'evidence',
        title: `Service installation logged (Event ${id})`,
        detail: clampText(message, 600),
        data: event,
        severity: 'high',
        confidence: 'high',
        observedAt: event.time || null,
        source: `eventlog:${event.log}`,
      });
      col.timeline.push({
        occurredAt: event.time || null,
        event: `Service installed (Event ${id})`,
        source: 'eventlog',
        entity: event.log,
        evidence: clampText(message, 400),
        severity: 'high',
      });
    } else if (id === 4104) {
      const domainHit = focus.domains.find((domain) => lower.includes(domain.toLowerCase()));
      if (domainHit || focusedProcess) {
        pushArtifact(col, {
          kind: 'event',
          classification: 'evidence',
          title: `PowerShell script block references investigation focus`,
          detail: clampText(message, 600),
          data: event,
          severity: 'high',
          confidence: 'medium',
          observedAt: event.time || null,
          source: 'eventlog:PowerShell',
        });
      }
    } else if (id === 4625 && focusedIp) {
      pushArtifact(col, {
        kind: 'event',
        classification: 'indicator',
        title: `Failed logon involving a focused address`,
        detail: clampText(message, 600),
        data: event,
        severity: 'medium',
        confidence: 'medium',
        observedAt: event.time || null,
        source: 'eventlog:Security',
      });
    } else if (id === 1116 || id === 1117) {
      pushArtifact(col, {
        kind: 'event',
        classification: 'evidence',
        title: `Endpoint protection reported malware (Event ${id})`,
        detail: clampText(message, 600),
        data: event,
        severity: 'critical',
        confidence: 'high',
        observedAt: event.time || null,
        source: 'eventlog:Defender',
      });
    }
  }
}

function analyzeUsers(col: Collector, section: any): void {
  const users: any[] = Array.isArray(section?.users) ? section.users : [];
  col.facts.users_returned = users.length;
  if (!users.length) {
    col.gaps.push({ section: 'users', reason: 'no_data_returned' });
    return;
  }
  const admins = users.filter(
    (user) => /administrators|sudo|wheel|admin/i.test(String(user.detail || ''))
  );
  if (admins.length) {
    pushArtifact(col, {
      kind: 'user',
      classification: 'observation',
      title: `Privileged accounts present on the endpoint (${admins.length})`,
      detail: admins
        .slice(0, 10)
        .map((user) => `${user.user}: ${user.detail}`)
        .join(' | '),
      data: { users: admins.slice(0, 20) },
      severity: 'info',
      confidence: 'high',
      observedAt: null,
      source: 'agent:users',
    });
  }
}

// ---------------------------------------------------------------------------
// Correlation, scoring and report
// ---------------------------------------------------------------------------

function correlate(col: Collector): void {
  const processFiles = new Map<string, string>();
  const exeToPath = new Map<string, string>();
  for (const artifact of col.artifacts) {
    if (artifact.kind !== 'process' && artifact.kind !== 'file') continue;
    const data = artifact.data as any;
    if (data?.exe) exeToPath.set(String(data.exe).toLowerCase(), String(data.exe));
    if (data?.path) exeToPath.set(String(data.path).toLowerCase(), String(data.path));
  }

  for (const artifact of col.artifacts) {
    if (artifact.kind !== 'connection') continue;
    const conn = artifact.data as any;
    const exe = String(conn?.exe || '').toLowerCase();
    if (!exe) continue;
    const path = exeToPath.get(exe);
    if (path) {
      processFiles.set(path, `${conn.remote_ip}:${conn.remote_port}`);
      col.relations.push({
        from: path,
        to: `${conn.remote_ip}:${conn.remote_port}`,
        relation: 'communicates_with',
        basis: 'same executable path resolved on both the process and connection samples',
      });
    }
  }

  const unique: RelationDraft[] = [];
  const seen = new Set<string>();
  for (const relation of col.relations) {
    const key = `${relation.from}|${relation.to}|${relation.relation}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(relation);
  }
  col.relations = unique;
}

function score(col: Collector): { risk: Severity; confidence: Confidence; summary: string } {
  const processArtifacts = col.artifacts.filter((artifact) => artifact.kind === 'process').length;
  const connectionArtifacts = col.artifacts.filter((artifact) => artifact.kind === 'connection').length;
  const persistenceArtifacts = col.artifacts.filter((artifact) => artifact.kind === 'persistence').length;
  const eventArtifacts = col.artifacts.filter((artifact) => artifact.kind === 'event').length;

  let risk: Severity = 'info';
  if (col.highIndicators >= 2 || (col.highIndicators >= 1 && col.evidenceCount >= 2)) risk = 'critical';
  else if (col.highIndicators >= 1 || col.evidenceCount >= 3) risk = 'high';
  else if (col.indicators >= 2) risk = 'medium';
  else if (col.indicators >= 1) risk = 'low';

  let confidence: Confidence = 'low';
  const independentSections = [processArtifacts, connectionArtifacts, persistenceArtifacts, eventArtifacts].filter(
    (count) => count > 0
  ).length;
  if (independentSections >= 3) confidence = 'high';
  else if (independentSections >= 2) confidence = 'medium';

  if (col.indicators === 0 && col.evidenceCount === 0) {
    risk = 'info';
    confidence = col.gaps.length ? 'low' : 'medium';
  }

  const summary =
    `${col.evidenceCount} evidence item(s), ${col.indicators} indicator(s) ` +
    `across ${independentSections} independent section(s); ` +
    `${col.gaps.length} section(s) produced no usable data.`;

  return { risk, confidence, summary };
}

function buildReport(input: {
  investigation: any;
  device: any;
  alert: any;
  col: Collector;
  risk: Severity;
  confidence: Confidence;
  summary: string;
  lateral: { iocType: string; value: string; count: number; devices: any[] }[];
  durationSeconds: number;
}): Record<string, unknown> {
  const { investigation, device, alert, col, risk, confidence, summary, lateral, durationSeconds } = input;

  const byClassification = (classification: Classification) =>
    col.artifacts.filter((artifact) => artifact.classification === classification);

  const evidenceChain: string[] = [];
  const primaryProcess = col.artifacts.find(
    (artifact) => artifact.kind === 'process' && (artifact.classification === 'evidence' || artifact.classification === 'indicator')
  );
  const primaryFile = col.artifacts.find((artifact) => artifact.kind === 'file' && artifact.data && (artifact.data as any).is_focus);
  const primaryConnection = col.artifacts.find((artifact) => artifact.kind === 'connection');
  const primaryPersistence = col.artifacts.find((artifact) => artifact.kind === 'persistence' && artifact.classification !== 'observation');

  if (device) evidenceChain.push(String(device.hostname || device.name || 'endpoint'));
  if (primaryProcess) evidenceChain.push(String((primaryProcess.data as any).name || primaryProcess.title));
  if (primaryFile) evidenceChain.push(String((primaryFile.data as any).path || primaryFile.title));
  if (primaryConnection) evidenceChain.push(String((primaryConnection.data as any).remote_ip || primaryConnection.title));
  if (primaryPersistence) evidenceChain.push(String(primaryPersistence.title));
  for (const match of lateral.slice(0, 3)) {
    evidenceChain.push(`IOC ${match.value} present on ${match.count} endpoint(s)`);
  }

  const containmentOptions = [
    { action: 'isolate', label: 'Isolate endpoint (block all traffic except management)', available: true },
    { action: 'quarantine', label: 'Quarantine endpoint', available: true },
    { action: 'scan', label: 'Run a fresh agent security scan', available: true },
    { action: 'inventory', label: 'Refresh software/service inventory', available: true },
  ];

  return {
    generated_at: nowIso(),
    duration_seconds: durationSeconds,
    executive_summary: summary,
    endpoint: device
      ? {
          id: device.id,
          hostname: device.hostname,
          os: device.os_type,
          ip: device.ip_address,
          status: device.status,
          last_heartbeat: device.last_heartbeat,
        }
      : null,
    original_alert: alert
      ? {
          id: alert.id,
          alert_type: alert.alert_type,
          severity: alert.severity,
          title: alert.title,
          description: alert.description,
          created_at: alert.created_at,
        }
      : null,
    risk,
    confidence,
    read_only: true,
    facts: col.facts,
    gaps: col.gaps,
    processes: col.artifacts
      .filter((artifact) => artifact.kind === 'process')
      .slice(0, 50)
      .map((artifact) => artifact.data),
    files: col.artifacts
      .filter((artifact) => artifact.kind === 'file')
      .slice(0, 50)
      .map((artifact) => artifact.data),
    connections: col.artifacts
      .filter((artifact) => artifact.kind === 'connection')
      .slice(0, 50)
      .map((artifact) => artifact.data),
    persistence: col.artifacts
      .filter((artifact) => artifact.kind === 'persistence')
      .slice(0, 50)
      .map((artifact) => artifact.data),
    downloads: col.artifacts
      .filter((artifact) => artifact.kind === 'browser' && String(artifact.title).startsWith('Download'))
      .slice(0, 30)
      .map((artifact) => artifact.data),
    hashes: col.iocs
      .filter((ioc) => ioc.iocType === 'hash_sha256')
      .slice(0, 30)
      .map((ioc) => ({ sha256: ioc.value, file: ioc.label })),
    ips: col.iocs.filter((ioc) => ioc.iocType === 'ip').map((ioc) => ioc.value),
    domains: col.iocs.filter((ioc) => ioc.iocType === 'domain').map((ioc) => ioc.value),
    urls: col.iocs.filter((ioc) => ioc.iocType === 'url').map((ioc) => ioc.value),
    users: col.artifacts.filter((artifact) => artifact.kind === 'user').map((artifact) => artifact.data),
    iocs: col.iocs.map((ioc) => ({ type: ioc.iocType, value: ioc.value, label: ioc.label, confidence: ioc.confidence })),
    evidence: byClassification('evidence').map((artifact) => ({
      title: artifact.title,
      detail: artifact.detail,
      source: artifact.source,
      confidence: artifact.confidence,
    })),
    indicators: byClassification('indicator').map((artifact) => ({
      title: artifact.title,
      detail: artifact.detail,
      source: artifact.source,
      severity: artifact.severity,
      confidence: artifact.confidence,
    })),
    correlations: col.relations.map((relation) => ({ ...relation })),
    hypotheses: byClassification('hypothesis').map((artifact) => ({
      title: artifact.title,
      detail: artifact.detail,
      confidence: artifact.confidence,
    })),
    lateral_movement: lateral.map((match) => ({
      ioc_type: match.iocType,
      value: match.value,
      endpoint_count: match.count,
      devices: match.devices,
    })),
    evidence_chain: evidenceChain,
    timeline: [...col.timeline]
      .sort((a, b) => String(a.occurredAt || '').localeCompare(String(b.occurredAt || '')))
      .map((entry, index) => ({
        seq: index,
        occurred_at: entry.occurredAt,
        event: entry.event,
        source: entry.source,
        entity: entry.entity,
        evidence: entry.evidence,
        severity: entry.severity,
      })),
    recommendations: buildRecommendations(risk, col, lateral),
    containment_options: containmentOptions,
    chain_of_custody: {
      collected_by: 'endpoint-agent forensic collectors (read-only)',
      collected_at: investigation.collected_at,
      analyzed_at: nowIso(),
      initiated_by: investigation.started_by,
      investigation_id: investigation.id,
      notes: 'No files, logs, registry keys or processes were modified during collection.',
    },
  };
}

function buildRecommendations(risk: Severity, col: Collector, lateral: any[]): string[] {
  const recommendations: string[] = [];
  if (col.artifacts.some((artifact) => artifact.kind === 'file' && (artifact.data as any).sha256)) {
    recommendations.push('Hunt the recorded SHA-256 hashes across the fleet and in the EDR blocklist.');
  }
  if (col.artifacts.some((artifact) => artifact.kind === 'persistence')) {
    recommendations.push(
      'Review the listed persistence entries with the owner before removing: removal is a containment action and must be approved separately.'
    );
  }
  if (lateral.length) {
    recommendations.push(
      `At least one IOC appears on ${lateral.reduce((max, entry) => Math.max(max, entry.count), 0)} endpoint(s) — open investigations there before closing this one.`
    );
  }
  if (col.gaps.length) {
    recommendations.push(
      `Data gaps remain (${col.gaps.map((gap) => gap.section).join(', ')}) — re-run the investigation after enabling the missing collection or correcting agent permissions.`
    );
  }
  if (risk === 'critical' || risk === 'high') {
    recommendations.push('Consider isolating the endpoint while the evidence is reviewed (explicit administrator approval required).');
  }
  if (!recommendations.length) {
    recommendations.push('No action required beyond recording the observation; re-investigate if the alert recurs.');
  }
  return recommendations;
}

async function lateralSearch(
  iocs: IocDraft[],
  excludeDeviceId: string | null
): Promise<{ iocType: string; value: string; count: number; devices: any[] }[]> {
  const unique = new Map<string, IocDraft>();
  for (const ioc of iocs) {
    if (!ioc.value || ioc.value.length > 500) continue;
    const key = `${ioc.iocType}|${ioc.value}`;
    if (!unique.has(key)) unique.set(key, ioc);
  }

  const results: { iocType: string; value: string; count: number; devices: any[] }[] = [];
  for (const ioc of Array.from(unique.values()).slice(0, 60)) {
    try {
      const matches = await query(
        `SELECT DISTINCT i.device_id, d.hostname, d.ip_address, i.investigation_id
           FROM forensic_iocs i
           LEFT JOIN devices d ON d.id = i.device_id
          WHERE i.ioc_type = $1 AND i.value = $2
            AND ($3::uuid IS NULL OR i.device_id IS DISTINCT FROM $3)
          LIMIT 25`,
        [ioc.iocType, ioc.value, excludeDeviceId]
      );
      if (!matches.rows.length) continue;
      results.push({
        iocType: ioc.iocType,
        value: ioc.value,
        count: matches.rows.length,
        devices: matches.rows.map((row: any) => ({
          device_id: row.device_id,
          hostname: row.hostname,
          ip: row.ip_address,
          investigation_id: row.investigation_id,
        })),
      });
    } catch (error) {
      logger.warn('Lateral IOC search failed', { ioc: ioc.value, error: (error as Error).message });
    }
  }
  results.sort((a, b) => b.count - a.count);
  return results;
}

// ---------------------------------------------------------------------------
// Public API used by the routes and by the command-result hook
// ---------------------------------------------------------------------------

export async function startInvestigation(input: {
  alertId: string;
  userId: string | null;
  sections?: string[];
}): Promise<any> {
  const alertResult = await query(
    `SELECT a.id, a.device_id, a.alert_type, a.severity, a.title, a.description,
            a.metadata, a.created_at, d.hostname, d.ip_address, d.status AS device_status,
            d.is_authorized, d.agent_id
       FROM alerts a
       LEFT JOIN devices d ON d.id = a.device_id
      WHERE a.id = $1`,
    [input.alertId]
  );

  const alert = alertResult.rows[0];
  if (!alert) {
    throw Object.assign(new Error('Alert not found'), { status: 404 });
  }
  if (!alert.device_id) {
    throw Object.assign(new Error('This alert is not attached to an endpoint, so it cannot be investigated'), {
      status: 400,
    });
  }
  if (alert.device_status !== 'online') {
    throw Object.assign(new Error('The endpoint is offline; the investigation needs a live agent'), { status: 409 });
  }

  const existing = await query(
    `SELECT id, status FROM forensic_investigations
      WHERE alert_id = $1 AND status IN ('queued','collecting','analyzing')
      LIMIT 1`,
    [input.alertId]
  );
  if (existing.rows.length) {
    throw Object.assign(new Error('An investigation is already running for this alert'), {
      status: 409,
      investigationId: existing.rows[0].id,
    });
  }

  const focus = buildFocus(alert);

  const settings = await query(
    `SELECT key, value FROM app_settings WHERE key IN ('hermes_collect_browser','hermes_collect_eventlog','hermes_forensic_retention_days')`
  );
  const settingMap: Record<string, string> = {};
  for (const row of settings.rows) settingMap[row.key] = row.value;

  await purgeExpiredInvestigations(settingMap.hermes_forensic_retention_days);

  const policy = {
    browser: settingMap.hermes_collect_browser !== 'false',
    eventlog: settingMap.hermes_collect_eventlog !== 'false',
  };
  const sections = input.sections && input.sections.length ? input.sections : undefined;

  const created = await query(
    `INSERT INTO forensic_investigations
       (alert_id, device_id, alert_snapshot, status, focus, started_by, started_at)
     VALUES ($1, $2, $3, 'queued', $4, $5, NOW())
     RETURNING *`,
    [
      alert.id,
      alert.device_id,
      JSON.stringify({
        alert_type: alert.alert_type,
        severity: alert.severity,
        title: alert.title,
        description: alert.description,
        created_at: alert.created_at,
      }),
      JSON.stringify(focus),
      input.userId,
    ]
  );
  const investigation = created.rows[0];

  const command = await query(
    `INSERT INTO agent_commands (device_id, command_type, parameters, status, issued_by)
     VALUES ($1, 'forensic_collect', $2, 'pending', $3)
     RETURNING id`,
    [
      alert.device_id,
      JSON.stringify({ investigation_id: investigation.id, focus, policy, sections }),
      input.userId,
    ]
  );

  await query(`UPDATE forensic_investigations SET command_id = $1, status = 'collecting' WHERE id = $2`, [
    command.rows[0].id,
    investigation.id,
  ]);

  logger.info('Forensic investigation started', {
    investigationId: investigation.id,
    alertId: alert.id,
    deviceId: alert.device_id,
  });

  return { ...investigation, command_id: command.rows[0].id, status: 'collecting' };
}

async function purgeExpiredInvestigations(retentionDays: string | undefined): Promise<void> {
  const days = parseInt(retentionDays || '90', 10);
  if (!Number.isFinite(days) || days <= 0) return;
  try {
    await query(
      `DELETE FROM forensic_investigations WHERE started_at < NOW() - ($1 || ' days')::interval`,
      [String(days)]
    );
  } catch (error) {
    logger.warn('Forensic retention purge failed', { error: (error as Error).message });
  }
}

/**
 * Called by the agent command-result endpoint once a forensic_collect command
 * reaches a terminal state (completed or failed).
 */
export async function onForensicCommandResult(input: {
  commandId: string;
  status: string;
  result?: unknown;
  errorMessage?: string | null;
}): Promise<void> {
  const investigationResult = await query(
    `SELECT * FROM forensic_investigations WHERE command_id = $1 LIMIT 1`,
    [input.commandId]
  );
  const investigation = investigationResult.rows[0];
  if (!investigation) return;

  // Agent endpoints retry: a second result for the same command must not
  // re-run the analysis over already persisted artifacts.
  if (investigation.status !== 'collecting') {
    logger.info('Forensic command result ignored', {
      investigationId: investigation.id,
      status: investigation.status,
    });
    return;
  }

  if (input.status !== 'completed') {
    const message =
      input.errorMessage ||
      'The agent could not complete the collection. Older agents do not support forensic_collect — update the agent.';
    await query(
      `UPDATE forensic_investigations
          SET status = 'failed', error_message = $1, completed_at = NOW()
        WHERE id = $2`,
      [message, investigation.id]
    );
    logger.warn('Forensic investigation failed', { investigationId: investigation.id, message });
    return;
  }

  let bundle: any;
  try {
    bundle =
      typeof input.result === 'string' ? JSON.parse(input.result) : (input.result as any);
  } catch {
    await query(
      `UPDATE forensic_investigations SET status = 'failed', error_message = $1, completed_at = NOW() WHERE id = $2`,
      ['The agent returned a payload that could not be parsed', investigation.id]
    );
    return;
  }

  await query(`UPDATE forensic_investigations SET status = 'analyzing', collected_at = NOW() WHERE id = $1`, [
    investigation.id,
  ]);

  try {
    const finished = await analyzeInvestigation(investigation, bundle);
    logger.info('Forensic investigation analyzed', {
      investigationId: investigation.id,
      risk: finished.risk,
      artifacts: finished.artifactCount,
    });
  } catch (error) {
    const message = (error as Error).message || 'analysis failed';
    await query(
      `UPDATE forensic_investigations SET status = 'failed', error_message = $1, completed_at = NOW() WHERE id = $2`,
      [message, investigation.id]
    );
    logger.error('Forensic analysis failed', { investigationId: investigation.id, error: message });
  }
}

/**
 * Pure analysis pass over a bundle returned by the agent. It touches no
 * database and no endpoint, so the correlation/scoring logic can be exercised
 * offline (see forensics.test.ts).
 */
export function analyzeBundle(
  focusRaw: unknown,
  bundle: any
): { focus: Focus; col: Collector; risk: Severity; confidence: Confidence; summary: string } {
  const focus: Focus = {
    ips: [],
    domains: [],
    process_names: [],
    file_paths: [],
    since: nowIso(),
    ...(typeof focusRaw === 'string' ? JSON.parse(focusRaw) : (focusRaw as object) || {}),
  };

  const col = NEW();

  for (const name of ['processes', 'connections', 'files', 'persistence', 'browser', 'events', 'users']) {
    const section = bundle?.sections?.[name];
    if (!section || section.skipped) {
      col.gaps.push({ section: name, reason: gapReason(section) });
    }
  }

  analyzeProcesses(col, sectionOf(bundle, 'processes'), focus);
  analyzeConnections(col, sectionOf(bundle, 'connections'), focus);
  analyzeFiles(col, sectionOf(bundle, 'files'), focus);
  analyzePersistence(col, sectionOf(bundle, 'persistence'), focus);
  analyzeBrowser(col, sectionOf(bundle, 'browser'), focus);
  analyzeEvents(col, sectionOf(bundle, 'events'), focus);
  analyzeUsers(col, sectionOf(bundle, 'users'));

  // One gap entry per section: the reason recorded before analysis (missing /
  // policy-disabled / error) wins over the generic "no_data_returned".
  const seenGaps = new Set<string>();
  col.gaps = col.gaps.filter((gap) => {
    if (seenGaps.has(gap.section)) return false;
    seenGaps.add(gap.section);
    return true;
  });

  correlate(col);
  const { risk, confidence, summary } = score(col);

  return { focus, col, risk, confidence, summary };
}

async function analyzeInvestigation(investigation: any, bundle: any): Promise<{
  risk: Severity;
  artifactCount: number;
}> {
  const started = Date.now();
  const { col, risk, confidence, summary } = analyzeBundle(investigation.focus, bundle);

  const deviceResult = await query(`SELECT * FROM devices WHERE id = $1`, [investigation.device_id]);
  const device = deviceResult.rows[0] || null;
  const alertResult = await query(`SELECT * FROM alerts WHERE id = $1`, [investigation.alert_id]);
  const alert = alertResult.rows[0] || null;

  const lateral = await lateralSearch(col.iocs, investigation.device_id);

  const report = buildReport({
    investigation,
    device,
    alert,
    col,
    risk,
    confidence,
    summary,
    lateral,
    durationSeconds: Math.round((Date.now() - started) / 100) / 10,
  });

  await query(`UPDATE forensic_investigations SET report = $1 WHERE id = $2`, [
    JSON.stringify(report),
    investigation.id,
  ]);

  await persistArtifacts(investigation, device?.id ?? null, col);
  await persistIocs(investigation, device?.id ?? null, col, lateral);
  await persistTimeline(investigation, col);

  await query(
    `UPDATE forensic_investigations
        SET status = 'complete', risk = $1, confidence = $2, summary = $3,
            stats = $4, completed_at = NOW(), error_message = NULL
      WHERE id = $5`,
    [
      risk,
      confidence,
      summary,
      JSON.stringify({
        artifacts: col.artifacts.length,
        iocs: col.iocs.length,
        timeline: col.timeline.length,
        relations: col.relations.length,
        evidence: col.evidenceCount,
        indicators: col.indicators,
        gaps: col.gaps.length,
        lateral_matches: lateral.length,
        collection_errors: (bundle && bundle.errors) || [],
        collected_at: bundle?.collected_at || null,
        platform: bundle?.platform || null,
        partial: Boolean(bundle?.partial),
      }),
      investigation.id,
    ]
  );

  return { risk, artifactCount: col.artifacts.length };
}

async function persistArtifacts(investigation: any, deviceId: string | null, col: Collector): Promise<void> {
  for (const artifact of col.artifacts.slice(0, 400)) {
    await query(
      `INSERT INTO forensic_artifacts
         (investigation_id, device_id, kind, classification, title, detail, data,
          severity, confidence, observed_at, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        investigation.id,
        deviceId,
        artifact.kind,
        artifact.classification,
        artifact.title.slice(0, 255),
        artifact.detail,
        JSON.stringify(artifact.data ?? {}),
        artifact.severity,
        artifact.confidence,
        artifact.observedAt ? new Date(artifact.observedAt).toISOString() : null,
        artifact.source,
      ]
    );
  }
}

async function persistIocs(
  investigation: any,
  deviceId: string | null,
  col: Collector,
  lateral: { iocType: string; value: string }[]
): Promise<void> {
  const merged = new Map<string, IocDraft>();
  for (const ioc of col.iocs.slice(0, 300)) {
    const key = `${ioc.iocType}|${ioc.value}`;
    const existing = merged.get(key);
    if (existing) {
      if (ioc.confidence === 'high') existing.confidence = 'high';
      continue;
    }
    merged.set(key, ioc);
  }
  for (const match of lateral) {
    const key = `${match.iocType}|${match.value}`;
    if (!merged.has(key)) {
      merged.set(key, {
        iocType: match.iocType,
        value: match.value,
        label: 'also observed on other endpoints',
        confidence: 'high',
        source: 'fleet',
      });
    }
  }

  for (const ioc of merged.values()) {
    await query(
      `INSERT INTO forensic_iocs
         (investigation_id, device_id, ioc_type, value, label, confidence, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [investigation.id, deviceId, ioc.iocType, ioc.value, ioc.label, ioc.confidence, ioc.source]
    );
  }
}

async function persistTimeline(investigation: any, col: Collector): Promise<void> {
  const sorted = [...col.timeline].sort((a, b) =>
    String(a.occurredAt || '').localeCompare(String(b.occurredAt || ''))
  );
  for (const [index, entry] of sorted.slice(0, 500).entries()) {
    await query(
      `INSERT INTO forensic_timeline
         (investigation_id, occurred_at, event, source, entity, evidence, severity, seq)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        investigation.id,
        entry.occurredAt ? new Date(entry.occurredAt).toISOString() : null,
        entry.event.slice(0, 255),
        entry.source,
        clampText(entry.entity, 500),
        clampText(entry.evidence, 1000),
        entry.severity,
        index,
      ]
    );
  }
}

export async function listInvestigations(options: {
  deviceId?: string | null;
  limit?: number;
  scopeSql?: string;
  scopeParams?: any[];
}): Promise<any[]> {
  const limit = Math.min(Math.max(options.limit || 50, 1), 200);
  const params: any[] = [...(options.scopeParams || [])];
  const clauses: string[] = [];
  if (options.scopeSql) clauses.push(options.scopeSql);
  if (options.deviceId) {
    params.push(options.deviceId);
    clauses.push(`i.device_id = $${params.length}`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(limit);
  const result = await query(
    `SELECT i.id, i.alert_id, i.device_id, i.status, i.risk, i.confidence, i.summary,
            i.started_at, i.completed_at, i.error_message, i.stats,
            d.hostname, a.title AS alert_title, a.severity AS alert_severity, a.alert_type
       FROM forensic_investigations i
       LEFT JOIN devices d ON d.id = i.device_id
       LEFT JOIN alerts a ON a.id = i.alert_id
       ${where}
      ORDER BY i.started_at DESC
      LIMIT $${params.length}`,
    params
  );
  return result.rows;
}

export async function getInvestigation(id: string): Promise<any | null> {
  const investigationResult = await query(
    `SELECT i.*, d.hostname, d.ip_address, d.status AS device_status,
            a.title AS alert_title, a.severity AS alert_severity, a.alert_type, a.description AS alert_description
       FROM forensic_investigations i
       LEFT JOIN devices d ON d.id = i.device_id
       LEFT JOIN alerts a ON a.id = i.alert_id
      WHERE i.id = $1`,
    [id]
  );
  const investigation = investigationResult.rows[0];
  if (!investigation) return null;

  const [artifacts, timeline, iocs] = await Promise.all([
    query(
      `SELECT id, kind, classification, title, detail, data, severity, confidence, observed_at, source
         FROM forensic_artifacts WHERE investigation_id = $1
        ORDER BY CASE classification
                   WHEN 'conclusion' THEN 0 WHEN 'hypothesis' THEN 1 WHEN 'correlation' THEN 2
                   WHEN 'indicator' THEN 3 WHEN 'evidence' THEN 4 ELSE 5 END,
                 observed_at NULLS LAST
        LIMIT 500`,
      [id]
    ),
    query(
      `SELECT occurred_at, event, source, entity, evidence, severity, seq
         FROM forensic_timeline WHERE investigation_id = $1
        ORDER BY seq ASC LIMIT 500`,
      [id]
    ),
    query(
      `SELECT ioc_type, value, label, confidence, source, first_seen, last_seen
         FROM forensic_iocs WHERE investigation_id = $1
        ORDER BY confidence DESC, ioc_type LIMIT 300`,
      [id]
    ),
  ]);

  return {
    ...investigation,
    artifacts: artifacts.rows,
    timeline: timeline.rows,
    iocs: iocs.rows,
  };
}
