jest.mock('@kubernetes/client-node', () => ({}));

import { CertificateSignerService } from './certificate-signer.service';
import { runAsActor } from '../../auth/utils/actor-context';

function signerWith(record: jest.Mock) {
  const signer = new CertificateSignerService(
    {
      generateKeyPair: async () => ({
        publicKey: 'ssh-ed25519 AAAA test',
        privateKey: 'PRIVATE',
        fingerprint: 'SHA256:abc',
      }),
    } as never,
    { getCAPrivateKey: async () => 'CA' } as never,
    { record } as never,
  );
  jest
    .spyOn(
      signer as unknown as { signPublicKeyWithCA: () => Promise<string> },
      'signPublicKeyWithCA',
    )
    .mockResolvedValue('CERT');
  return signer;
}

describe('CertificateSignerService audit', () => {
  it('records who received a certificate, for what and for how long', async () => {
    const record = jest.fn().mockResolvedValue(undefined);
    await runAsActor({ kind: 'user' }, () =>
      signerWith(record).generateEphemeralCertificate(undefined, 1800, {
        purpose: 'terminal',
        target: '10.0.0.1',
        userId: 'u1',
        email: 'op@support.example',
      }),
    );
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'ssh certificate issued',
        email: 'op@support.example',
        actorKind: 'user',
        dataAccess: true,
        target: expect.objectContaining({
          purpose: 'terminal',
          host: '10.0.0.1',
          ttlSeconds: '1800',
          principals: 'root,ubuntu,admin',
        }),
      }),
    );
    expect(JSON.stringify(record.mock.calls)).not.toContain('PRIVATE');
  });

  it('records an issuance made by the platform itself as the system', async () => {
    const record = jest.fn().mockResolvedValue(undefined);
    await signerWith(record).generateEphemeralCertificate(undefined, 60, {
      purpose: 'host command',
      target: '10.0.0.2',
    });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ actorKind: 'system', email: null }),
    );
  });
});
