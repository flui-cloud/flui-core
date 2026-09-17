import { redactBootstrapSecrets } from './redact-bootstrap-secrets';

/**
 * The debug copy is now off unless asked for. These cover the second half:
 * that asking for it still does not put a secret on disk.
 */
describe('what a debug copy of a bootstrap script may contain', () => {
  const script = [
    "export CLUSTER_NAME='wl-ovh3'",
    "export PROVIDER_HETZNER_API_KEY='hetzner-live-value'",
    "export PROVIDER_SCALEWAY_SECRET_KEY='scaleway-live-value'",
    "export ENCRYPTION_KEY='encryption-value'",
    "export JWT_SECRET='jwt-value'",
    "export ZITADEL_MASTERKEY='masterkey-value'",
    "export POSTGRES_PASSWORD='postgres-value'",
    "export K3S_TOKEN='k3s-value'",
    "export FLUI_CA_PUBLIC_KEY='ssh-ed25519 AAAAC3Nz public'",
    "export GRAFANA_PASSWORD=''",
    '',
  ].join('\n');

  const redacted = redactBootstrapSecrets(script);

  it.each([
    'hetzner-live-value',
    'scaleway-live-value',
    'encryption-value',
    'jwt-value',
    'masterkey-value',
    'postgres-value',
    'k3s-value',
  ])('does not carry %s', (secret) => {
    expect(redacted).not.toContain(secret);
  });

  it('keeps the names, so a reader can still see what was set', () => {
    expect(redacted).toContain("export PROVIDER_HETZNER_API_KEY='<redacted>'");
    expect(redacted).toContain("export ZITADEL_MASTERKEY='<redacted>'");
  });

  it('distinguishes a secret that was empty from one that was set', () => {
    expect(redacted).toContain("export GRAFANA_PASSWORD=''");
  });

  it('leaves a public key readable — it is published by design', () => {
    expect(redacted).toContain(
      "export FLUI_CA_PUBLIC_KEY='ssh-ed25519 AAAAC3Nz public'",
    );
  });

  it('leaves everything that is not a secret alone', () => {
    expect(redacted).toContain("export CLUSTER_NAME='wl-ovh3'");
  });

  it('redacts a multi-line value, such as a private key', () => {
    const withKey =
      "export SSH_CA_PRIVATE_KEY='-----BEGIN OPENSSH PRIVATE KEY-----\nbody\n-----END OPENSSH PRIVATE KEY-----'\n";
    const out = redactBootstrapSecrets(withKey);
    expect(out).not.toContain('BEGIN OPENSSH PRIVATE KEY');
    expect(out).toBe("export SSH_CA_PRIVATE_KEY='<redacted>'\n");
  });
});
