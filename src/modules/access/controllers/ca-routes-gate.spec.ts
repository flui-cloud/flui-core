jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('@octokit/rest', () => ({ Octokit: jest.fn() }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));

import { CAController } from './ca.controller';
import { AdminGuard } from '../../auth/guards/admin.guard';
import {
  CertificateSignerService,
  MAX_CERTIFICATE_TTL_SECONDS,
} from '../services/certificate-signer.service';
import { CAManagerService } from '../services/ca-manager.service';

const guardsOn = (method: string): unknown[] =>
  (Reflect.getMetadata(
    '__guards__',
    CAController.prototype[method as keyof CAController],
  ) as unknown[]) ?? [];

/**
 * These routes hand out material that authenticates as `root` on every node
 * trusting the installation's CA, and a route with no permission decorator is
 * never consulted by the IAM layer at all.
 */
describe('the certificate authority routes', () => {
  // Every route on this controller, so a new one cannot be added without a
  // decision about its gate. `register` replaces the CA the whole fleet
  // trusts; `enrollment-script` is what teaches a host to trust one.
  it.each([
    'initializeCA',
    'registerCA',
    'getCAInfo',
    'getEnrollmentScript',
    'generateTestCertificate',
  ])('%s is admin-gated', (method) => {
    expect(guardsOn(method)).toContain(AdminGuard);
  });

  describe('the requested lifetime', () => {
    let signer: { generateEphemeralCertificate: jest.Mock };
    let controller: CAController;

    beforeEach(() => {
      signer = {
        generateEphemeralCertificate: jest.fn().mockResolvedValue({
          privateKey: 'key',
          certificate: 'cert',
        }),
      };
      controller = new CAController(
        {} as unknown as CAManagerService,
        signer as unknown as CertificateSignerService,
      );
    });

    const ttlUsed = (): number =>
      signer.generateEphemeralCertificate.mock.calls[0][1] as number;

    it('is capped, however large it is asked to be', async () => {
      await controller.generateTestCertificate(1_000_000_000);
      expect(ttlUsed()).toBe(MAX_CERTIFICATE_TTL_SECONDS);
    });

    it('is honoured when it sits under the ceiling', async () => {
      await controller.generateTestCertificate(300);
      expect(ttlUsed()).toBe(300);
    });

    it('falls back to the default when it is not a usable number', async () => {
      await controller.generateTestCertificate('abc' as unknown as number);
      expect(ttlUsed()).toBe(180);
    });

    it('falls back to the default when it is zero or negative', async () => {
      await controller.generateTestCertificate(-5);
      expect(ttlUsed()).toBe(180);
    });
  });
});
