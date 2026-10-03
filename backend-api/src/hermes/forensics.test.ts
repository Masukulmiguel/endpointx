import { analyzeBundle, buildFocus } from './forensics';

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

const CLASSIFICATIONS = new Set(['observation', 'evidence', 'indicator', 'correlation', 'hypothesis', 'conclusion']);

const FOCUS = {
  ips: ['203.0.113.45'],
  domains: ['evil-cdn.example'],
  process_names: ['invoice_viewer.exe'],
  file_paths: [],
  since: '2026-10-01T00:00:00.000Z',
};

function infectionBundle() {
  return {
    collected_at: '2026-10-02T09:10:00.000Z',
    platform: 'Windows',
    sections: {
      processes: {
        total_processes: 4,
        processes: [
          { pid: 4000, ppid: 3000, name: 'WINWORD.EXE', exe: 'C:\\Program Files\\Microsoft Office\\root\\Office16\\WINWORD.EXE', cmdline: 'WINWORD.EXE /n invoice.docm', user: 'alice', started_at: '2026-10-02T09:00:00Z', parent_name: 'explorer.exe' },
          { pid: 4100, ppid: 4000, name: 'powershell.exe', exe: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', cmdline: 'powershell.exe -nop -w hidden -enc SQBFAFgA', user: 'alice', started_at: '2026-10-02T09:00:05Z', parent_name: 'WINWORD.EXE' },
          { pid: 4200, ppid: 4100, name: 'invoice_viewer.exe', exe: 'C:\\Users\\alice\\AppData\\Roaming\\invoice_viewer.exe', cmdline: 'invoice_viewer.exe --silent', user: 'alice', started_at: '2026-10-02T09:00:07Z', parent_name: 'powershell.exe' },
        ],
      },
      connections: {
        total_connections: 2,
        connections: [
          { pid: 4100, process: 'powershell.exe', exe: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', local_ip: '10.0.0.5', local_port: 50012, remote_ip: '203.0.113.45', remote_port: 443, protocol: 'tcp', status: 'ESTABLISHED' },
          { pid: 900, process: 'chrome.exe', exe: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', local_ip: '10.0.0.5', local_port: 50100, remote_ip: '142.250.0.0', remote_port: 443, protocol: 'tcp', status: 'ESTABLISHED' },
        ],
      },
      files: {
        files: [
          { name: 'invoice_viewer.exe', path: 'C:\\Users\\alice\\AppData\\Roaming\\invoice_viewer.exe', sha256: 'a'.repeat(64), sha1: 'b'.repeat(40), md5: 'c'.repeat(32), size_bytes: 123456, created_at: '2026-10-02T09:00:06Z', modified_at: '2026-10-02T09:00:06Z', signature_status: 'NotSigned', is_focus: true },
        ],
        focus_files: 1,
      },
      persistence: {
        persistence: [
          { mechanism: 'registry:run', name: 'InvoiceStub', value: '%appdata%\\invoice_viewer.exe', detail: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' },
        ],
      },
      browser: {
        browsers: [
          {
            browser: 'chrome',
            profile: 'Default',
            history: [{ url: 'https://evil-cdn.example/payload', title: 'Invoice', visit_count: 1, last_visit_at: '2026-10-02T08:55:00Z' }],
            downloads: [{ target_path: 'C:\\Users\\alice\\Downloads\\invoice_viewer.exe', source_url: 'https://evil-cdn.example/invoice_viewer.exe', started_at: '2026-10-02T08:56:00Z' }],
          },
        ],
      },
      events: {
        events: [
          { id: 4688, log: 'Security', time: '2026-10-02T09:00:05Z', message: 'A new process was created: invoice_viewer.exe created by powershell.exe' },
          { id: 7045, log: 'System', time: '2026-10-02T09:00:09Z', message: 'A new service was installed in the system: invoice_viewer' },
        ],
      },
      users: {
        users: [{ user: 'alice', detail: 'Administrators group member' }],
      },
    },
  };
}

function cleanBundle() {
  return {
    sections: {
      processes: { total_processes: 1, processes: [{ pid: 900, ppid: 500, name: 'chrome.exe', exe: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', cmdline: 'chrome.exe', user: 'bob', started_at: '2026-10-02T08:00:00Z', parent_name: 'explorer.exe' }] },
      connections: { total_connections: 1, connections: [{ pid: 900, process: 'chrome.exe', exe: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', local_ip: '10.0.0.5', local_port: 51000, remote_ip: '127.0.0.1', remote_port: 443, protocol: 'tcp', status: 'LISTEN' }] },
      files: { files: [{ name: 'notes.txt', path: 'C:\\Users\\bob\\Documents\\notes.txt', sha256: 'd'.repeat(64), size_bytes: 20, created_at: '2026-10-01T10:00:00Z', signature_status: 'Valid', is_focus: false }], focus_files: 0 },
      persistence: { persistence: [{ mechanism: 'registry:run', name: 'SecurityHealth', value: 'C:\\Windows\\System32\\SecurityHealthSystray.exe', detail: 'HKLM run key' }] },
      browser: { browsers: [{ browser: 'chrome', profile: 'Default', history: [{ url: 'https://example.com/news', title: 'News', visit_count: 3, last_visit_at: '2026-10-02T07:00:00Z' }], downloads: [] }] },
      events: { events: [{ id: 4624, log: 'Security', time: '2026-10-02T07:00:00Z', message: 'An account was successfully logged on.' }] },
      users: { users: [{ user: 'bob', detail: 'Users group member' }] },
    },
  };
}

function run() {
  // --- focus extraction -----------------------------------------------------
  const focus = buildFocus({
    alert_type: 'suspicious_process',
    description: 'Process invoice_viewer.exe connected to 203.0.113.45 and resolved evil-cdn.example',
    metadata: { process_name: 'invoice_viewer.exe' },
    created_at: '2026-10-02T09:00:00.000Z',
  });
  assert(focus.ips.includes('203.0.113.45'), 'focus should extract the IP from the description');
  assert(focus.domains.includes('evil-cdn.example'), 'focus should extract the domain from the description');
  assert(focus.process_names.includes('invoice_viewer.exe'), 'focus should take the process from metadata');
  assert(focus.since === '2026-10-02T03:00:00.000Z', 'since = alert time minus 6h');

  // --- infection bundle -----------------------------------------------------
  const hit = analyzeBundle(FOCUS, infectionBundle());

  assert(hit.col.gaps.length === 0, `no gaps expected on a complete bundle, got ${JSON.stringify(hit.col.gaps)}`);
  assert(hit.col.evidenceCount >= 4, `expected several evidence items, got ${hit.col.evidenceCount}`);
  assert(hit.col.highIndicators >= 2, `expected high severity indicators, got ${hit.col.highIndicators}`);
  assert(hit.risk === 'critical', `expected critical risk, got ${hit.risk}`);
  assert(hit.confidence === 'high', `expected high confidence from 4 independent sections, got ${hit.confidence}`);
  assert(hit.summary.includes('evidence item'), 'summary must count evidence');

  const relations = hit.col.relations;
  assert(relations.some((r) => r.relation === 'spawned'), 'process tree relation expected');
  assert(relations.some((r) => r.relation === 'connected_to'), 'socket relation expected');
  assert(relations.some((r) => r.relation === 'communicates_with'), 'cross-section correlation expected');

  const iocValues = hit.col.iocs.map((ioc) => ioc.value);
  assert(iocValues.includes('203.0.113.45'), 'focused IP should become an IOC');
  assert(iocValues.includes('a'.repeat(64)), 'SHA-256 of the focused file should become an IOC');
  assert(iocValues.some((value) => String(value).includes('evil-cdn.example')), 'visited URL should become an IOC');

  assert(
    hit.col.artifacts.every((artifact) => CLASSIFICATIONS.has(artifact.classification)),
    'every statement must carry a supported classification label'
  );
  assert(hit.col.artifacts.every((artifact) => Boolean(artifact.detail)), 'every artifact must state its evidence');
  assert(hit.col.timeline.length >= 5, `timeline expected, got ${hit.col.timeline.length}`);

  const browserEvidence = hit.col.artifacts.find((a) => a.title.startsWith('Focused address present'));
  assert(Boolean(browserEvidence), 'browser focus hit must be reported');
  assert(
    String(browserEvidence?.detail).includes('does not establish that a link was clicked'),
    'browser wording must limit itself to what was observed'
  );

  // --- clean endpoint -------------------------------------------------------
  const clean = analyzeBundle(FOCUS, cleanBundle());
  assert(clean.risk === 'info', `benign bundle must stay info, got ${clean.risk}`);
  assert(clean.col.evidenceCount === 0, 'benign bundle must not invent evidence');
  assert(clean.col.indicators === 0, 'benign bundle must not invent indicators');
  assert(clean.col.gaps.length === 0, `complete benign bundle has no gaps, got ${JSON.stringify(clean.col.gaps)}`);

  // --- gaps are reported, never as negative findings ------------------------
  const infection = infectionBundle();
  const partial = analyzeBundle(FOCUS, {
    sections: {
      processes: { skipped: true, reason: 'policy_disabled' },
      connections: infection.sections.connections,
      files: infection.sections.files,
      persistence: infection.sections.persistence,
    },
  });
  const gapSections = partial.col.gaps.map((gap) => gap.section);
  assert(gapSections.includes('processes'), 'disabled section must be reported as a gap');
  assert(
    partial.col.gaps.find((gap) => gap.section === 'processes')?.reason === 'policy_disabled',
    'gap must keep the agent reason'
  );
  assert(gapSections.length === new Set(gapSections).size, 'one gap entry per section');
  assert(!partial.col.artifacts.some((a) => a.title.includes('Process')), 'a skipped section must yield no process findings');
  assert(partial.col.evidenceCount >= 2, 'findings from collected sections still count');
  assert(partial.risk === 'critical', `expected critical risk (high indicator + 2 evidence), got ${partial.risk}`);

  // --- nothing collected ----------------------------------------------------
  const empty = analyzeBundle(FOCUS, {});
  assert(empty.col.evidenceCount === 0, 'no data means no evidence');
  assert(empty.risk === 'info', 'no data must not raise risk');
  assert(empty.col.gaps.length === 7, `every missing section is a gap, got ${empty.col.gaps.length}`);

  console.log('HERMES forensics tests passed');
}

run();
