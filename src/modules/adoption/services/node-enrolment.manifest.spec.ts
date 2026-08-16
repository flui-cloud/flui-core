import {
  assertPublicKey,
  buildEnrolmentJob,
  enrolmentScript,
  jobName,
} from './node-enrolment.manifest';

const A_KEY =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIN4HUbEWWOqQ2/kh41HZYcZd9F9BN1sKmXGxcDQwfjEI flui-ca';

describe('assertPublicKey', () => {
  it('accepts the OpenSSH public key formats a CA can use', () => {
    expect(() => assertPublicKey(A_KEY)).not.toThrow();
    expect(() => assertPublicKey('ssh-rsa AAAAB3NzaC1yc2E= x')).not.toThrow();
    expect(() =>
      assertPublicKey('ecdsa-sha2-nistp256 AAAAE2VjZHNh'),
    ).not.toThrow();
  });

  it('refuses a private key', () => {
    // The likeliest mistake: pasting ca_key instead of ca_key.pub. It must not
    // reach a file next to sshd_config on every node.
    expect(() =>
      assertPublicKey('-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END'),
    ).toThrow(/Not an OpenSSH public key/);
  });

  it('refuses anything carrying shell metacharacters or a second line', () => {
    for (const value of [
      `${A_KEY}\nssh-ed25519 AAAA second-key`,
      'ssh-ed25519 AAAA$(id)',
      'ssh-ed25519 AAAA`id`',
      'ssh-ed25519 AAAA; rm -rf /',
      '',
      'not-a-key-at-all',
    ]) {
      expect(() => assertPublicKey(value)).toThrow();
    }
  });
});

describe('jobName', () => {
  it('produces a valid Kubernetes name from any node name', () => {
    const valid = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
    for (const node of [
      'control-cluster-master',
      'Node.With.Dots',
      'UPPER_CASE_NODE',
      'a'.repeat(120),
      'trailing---',
    ]) {
      const name = jobName(node);
      expect(name.length).toBeLessThanOrEqual(63);
      expect(name).toMatch(valid);
    }
  });
});

describe('enrolmentScript', () => {
  it('never interpolates the key into the script body', () => {
    // It travels as an environment variable; the script only ever references
    // the variable, so the key cannot become shell source text.
    const script = enrolmentScript(A_KEY);
    expect(script).not.toContain('AAAAC3NzaC1lZDI1NTE5');
    expect(script).toContain('$FLUI_CA_PUBLIC_KEY');
  });

  it('writes the CA file through a temporary and moves it into place', () => {
    const script = enrolmentScript(A_KEY);
    expect(script).toContain('CA_FILE=/host-etc-ssh/trusted_user_ca_keys');
    expect(script).toContain('> "$CA_FILE.new"');
    expect(script).toContain('mv "$CA_FILE.new" "$CA_FILE"');
  });

  it('only ever appends to sshd_config, guarded on absence', () => {
    // On a host reached only over SSH, rewriting this file is unrecoverable.
    const script = enrolmentScript(A_KEY);
    expect(script).toContain('>> "$CONFIG"');
    // A truncating redirect, as opposed to the appending one above.
    expect(script).not.toMatch(/[^>]> "\$CONFIG"/);
    expect(script).not.toMatch(/sed -i.*\$CONFIG/);
    expect(script).toContain('if ! grep -q "^TrustedUserCAKeys');
  });

  it('does not fail the enrolment when the reload does', () => {
    expect(enrolmentScript(A_KEY)).toMatch(/systemctl reload.*\|\| true/s);
  });
});

describe('buildEnrolmentJob', () => {
  const job = buildEnrolmentJob('control-cluster-master', A_KEY) as any;

  it('pins the job to the node it is enrolling', () => {
    expect(job.spec.template.spec.nodeName).toBe('control-cluster-master');
  });

  it('tolerates every taint, so a control-plane node is not skipped', () => {
    expect(job.spec.template.spec.tolerations).toEqual([
      { operator: 'Exists' },
    ]);
  });

  it('mounts only /etc/ssh from the host', () => {
    const volumes = job.spec.template.spec.volumes;
    expect(volumes).toHaveLength(1);
    expect(volumes[0].hostPath).toEqual({
      path: '/etc/ssh',
      type: 'Directory',
    });
  });

  it('does not restart on failure, so a broken attempt is not retried forever', () => {
    expect(job.spec.template.spec.restartPolicy).toBe('Never');
    expect(job.spec.backoffLimit).toBe(1);
  });

  it('cleans itself up', () => {
    expect(job.spec.ttlSecondsAfterFinished).toBeGreaterThan(0);
  });
});
