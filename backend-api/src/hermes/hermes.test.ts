import { ipInCidr, parsePortList, detectService, portRisk } from '../routes/hermes';

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

function run() {
  // CIDR scope enforcement
  assert(ipInCidr('192.168.1.10', '192.168.0.0/16') === true, 'IP in range should match');
  assert(ipInCidr('10.1.2.3', '10.0.0.0/8') === true, '10/8 should match');
  assert(ipInCidr('8.8.8.8', '10.0.0.0/8') === false, 'Public IP should not match private CIDR');
  assert(ipInCidr('172.16.0.1', '172.16.0.0/12') === true, '172.16/12 should match');
  assert(ipInCidr('192.168.1.10', '192.168.1.0/24') === true, '/24 match');
  assert(ipInCidr('192.168.2.10', '192.168.1.0/24') === false, '/24 reject');
  assert(ipInCidr('not-an-ip', '10.0.0.0/8') === false, 'invalid IP rejected');

  // Port list parsing
  const ports = parsePortList('22,80,443,8000-8005');
  assert(ports.includes(22) && ports.includes(443), 'simple ports parsed');
  assert(ports.includes(8000) && ports.includes(8005), 'range expanded');
  assert(parsePortList('').length === 0, 'empty list');
  assert(parsePortList('99999').length === 0, 'invalid port ignored');

  // Service identification
  const ssh = detectService(22, 'SSH-2.0-OpenSSH_8.9');
  assert(ssh.service === 'SSH', 'SSH detected from banner');
  assert(ssh.product === 'OpenSSH', 'OpenSSH product');
  assert(ssh.version === '8.9', 'OpenSSH version');
  assert(ssh.confidence >= 80, 'high confidence for banner');

  const mapped = detectService(3306, null);
  assert(mapped.service === 'MySQL', 'port map for MySQL');
  assert(mapped.confidence === 60, 'lower confidence without banner');

  // Risk classification
  assert(portRisk(3389) === 'high', 'RDP high risk');
  assert(portRisk(22) === 'low', 'SSH low risk');
  assert(portRisk(8080) === 'info', 'alt http info');

  console.log('HERMES unit tests passed');
}

run();
