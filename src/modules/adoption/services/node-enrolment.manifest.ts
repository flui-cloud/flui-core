const NAMESPACE = 'flui-system';
const IMAGE = 'alpine:3.20';

/**
 * Rejected rather than escaped.
 *
 * The key ends up inside a shell heredoc on a host filesystem. Validating the
 * shape here means there is nothing to escape: an OpenSSH public key is one
 * line of a known alphabet, and anything else — a private key, a second line, a
 * shell metacharacter — is a mistake or an attack, and neither should be
 * written to `sshd_config`'s neighbourhood.
 */
export function assertPublicKey(value: string): void {
  const ok =
    /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp\d+) [A-Za-z0-9+/=]+( [^\s]*)?$/.test(
      value.trim(),
    );
  if (!ok) {
    throw new Error(
      'Not an OpenSSH public key. Enrolment writes this value to every node, so it is checked before anything is created.',
    );
  }
}

export function jobName(nodeName: string): string {
  // Kubernetes names are 63 characters of a restricted alphabet; node names are
  // neither guaranteed to be short nor to avoid dots.
  const safe = nodeName
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .slice(0, 40);
  const name = `flui-ca-enrol-${safe}`;
  let end = name.length;
  while (end > 0 && name[end - 1] === '-') end--;
  return name.slice(0, end);
}

export function enrolmentScript(caPublicKey: string): string {
  return [
    'set -eu',
    'CA_FILE=/host-etc-ssh/trusted_user_ca_keys',
    'CONFIG=/host-etc-ssh/sshd_config',
    '',
    '# Written whole through a temporary file: a half-written file here is a',
    '# node that trusts a truncated key, which fails closed but silently.',
    String.raw`printf '%s\n' "$FLUI_CA_PUBLIC_KEY" > "$CA_FILE.new"`,
    'chmod 644 "$CA_FILE.new"',
    'mv "$CA_FILE.new" "$CA_FILE"',
    '',
    '# Appended only if absent. Never rewrite this file: it is the only way in.',
    'if ! grep -q "^TrustedUserCAKeys /etc/ssh/trusted_user_ca_keys" "$CONFIG"; then',
    String.raw`  printf "\nTrustedUserCAKeys /etc/ssh/trusted_user_ca_keys\n" >> "$CONFIG"`,
    '  echo "sshd_config: TrustedUserCAKeys added"',
    'else',
    '  echo "sshd_config: TrustedUserCAKeys already present"',
    'fi',
    '',
    '# sshd re-reads its configuration for each new connection, so the reload is',
    '# a courtesy rather than a requirement. It is best-effort for that reason:',
    '# failing the enrolment over it would report a node as unenrolled when it is.',
    'if command -v nsenter >/dev/null 2>&1; then',
    "  nsenter -t 1 -m -u -i -n -p -- sh -c 'systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true' || true",
    'fi',
    'echo "enrolment complete"',
  ].join('\n');
}

export function buildEnrolmentJob(
  nodeName: string,
  caPublicKey: string,
): unknown {
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: jobName(nodeName),
      namespace: NAMESPACE,
      labels: {
        'app.kubernetes.io/managed-by': 'flui-cloud',
        'flui.cloud/purpose': 'ssh-ca-enrolment',
      },
    },
    spec: {
      backoffLimit: 1,
      ttlSecondsAfterFinished: 600,
      template: {
        metadata: { labels: { 'flui.cloud/purpose': 'ssh-ca-enrolment' } },
        spec: {
          restartPolicy: 'Never',
          nodeName,
          hostPID: true,
          tolerations: [{ operator: 'Exists' }],
          containers: [
            {
              name: 'enrol',
              image: IMAGE,
              command: ['sh', '-c', enrolmentScript(caPublicKey)],
              // Passed as an environment variable, not interpolated into the
              // script: the value never becomes shell source text.
              env: [{ name: 'FLUI_CA_PUBLIC_KEY', value: caPublicKey }],
              securityContext: { privileged: true },
              volumeMounts: [
                { name: 'host-etc-ssh', mountPath: '/host-etc-ssh' },
              ],
            },
          ],
          volumes: [
            {
              name: 'host-etc-ssh',
              hostPath: { path: '/etc/ssh', type: 'Directory' },
            },
          ],
        },
      },
    },
  };
}
