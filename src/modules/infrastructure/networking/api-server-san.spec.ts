import {
  buildSanEnrolmentScript,
  buildSanReadScript,
  isPlainIpv4,
  parseCertificateIps,
  SAN_APPLIED_MARKER,
  SAN_PRESENT_MARKER,
  SAN_ROLLED_BACK_MARKER,
} from './api-server-san';

describe('isPlainIpv4', () => {
  it('accepts an address', () => {
    expect(isPlainIpv4('10.250.0.9')).toBe(true);
  });

  it('refuses anything that could carry a shell command', () => {
    // This string is interpolated into a script that runs as root.
    expect(isPlainIpv4('10.250.0.9; rm -rf /')).toBe(false);
    expect(isPlainIpv4('$(whoami)')).toBe(false);
    expect(isPlainIpv4('10.250.0.999')).toBe(false);
    expect(isPlainIpv4('')).toBe(false);
  });
});

describe('buildSanEnrolmentScript', () => {
  const script = (addr = '10.250.0.9', opts = {}) =>
    buildSanEnrolmentScript(addr, opts);

  it('refuses to build anything for a non-address', () => {
    expect(() => script('not-an-ip')).toThrow(/Not an IPv4 address/);
  });

  it('does nothing when the certificate already covers the address', () => {
    expect(script()).toContain(SAN_PRESENT_MARKER);
    // The check comes before anything is written or deleted.
    const s = script();
    expect(s.indexOf(SAN_PRESENT_MARKER)).toBeLessThan(s.indexOf('rm -f'));
  });

  it('matches the address exactly, so .9 is not found inside .90', () => {
    // A certificate comparison decides whether to restart a live master.
    expect(script()).toContain('IP Address:10\\.250\\.0\\.9([^0-9.]|$)');
  });

  it('writes a drop-in instead of the operator’s own config', () => {
    const s = script();
    expect(s).toContain('/etc/rancher/k3s/config.yaml.d/10-flui-tls-san.yaml');
    expect(s).not.toContain('> /etc/rancher/k3s/config.yaml\n');
  });

  it('keeps a copy of the certificate before deleting it', () => {
    const s = script();
    expect(s.indexOf('.flui-backup')).toBeLessThan(
      s.indexOf(
        'rm -f /var/lib/rancher/k3s/server/tls/serving-kube-apiserver.crt /var',
      ),
    );
  });

  it('does not let a failed restart escape the rollback', () => {
    // With `set -e` and a bare restart, a master could be left with no
    // certificate and a drop-in nobody removed.
    expect(script()).toContain('systemctl restart k3s >/dev/null 2>&1 || true');
  });

  it('demands proof the certificate was regenerated, not just readiness', () => {
    // A readiness probe alone says an API is answering — and the process
    // already in memory answers happily with the old certificate.
    const s = script();
    const wait = s.slice(s.indexOf('while'));
    expect(wait).toContain('subjectAltName');
    expect(wait).toContain('/readyz');
    expect(wait).toContain(SAN_APPLIED_MARKER);
  });

  it('restores the master when it does not come back', () => {
    const s = script();
    const rollback = s.slice(s.indexOf('done'));
    expect(rollback).toContain('rm -f /etc/rancher/k3s/config.yaml.d');
    expect(rollback).toContain('.flui-backup /var/lib/rancher/k3s');
    expect(rollback).toContain(SAN_ROLLED_BACK_MARKER);
  });

  it('exits zero even on the rollback, so the marker survives', () => {
    // The transport rejects a non-zero exit with stderr alone, and the marker
    // is on stdout.
    expect(script().trimEnd().endsWith('exit 0')).toBe(true);
  });

  it('turns the wait into whole five-second attempts', () => {
    expect(script('10.250.0.9', { waitSeconds: 20 })).toContain('-lt 4');
    expect(script('10.250.0.9', { waitSeconds: 300 })).toContain('-lt 60');
  });
});

describe('parseCertificateIps', () => {
  // Shaped like the openssl output a K3s master really produces.
  const REAL =
    '    DNS:kubernetes, DNS:kubernetes.default, DNS:localhost, DNS:master-1, ' +
    'IP Address:10.250.0.9, IP Address:203.0.113.10, IP Address:127.0.0.1, ' +
    'IP Address:0:0:0:0:0:0:0:1, IP Address:203.0.113.10, IP Address:10.43.0.1';

  it('reads every address the certificate covers, once each', () => {
    const ips = parseCertificateIps(REAL);
    expect(ips).toContain('10.250.0.9');
    expect(ips).toContain('203.0.113.10');
    expect(ips).toContain('10.43.0.1');
    // 203.0.113.10 appears twice in the certificate.
    expect(ips.filter((i) => i === '203.0.113.10')).toHaveLength(1);
  });

  it('ignores the DNS names', () => {
    expect(parseCertificateIps(REAL)).not.toContain('kubernetes');
  });

  it('says nothing about a certificate it could not read', () => {
    expect(parseCertificateIps('')).toEqual([]);
  });
});

describe('buildSanReadScript', () => {
  it('reads rather than writes', () => {
    const s = buildSanReadScript();
    expect(s).toContain('openssl x509');
    expect(s).not.toContain('rm ');
    expect(s).not.toContain('systemctl');
  });
});
