jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jose', () => ({}));
jest.mock('ip-cidr', () => ({}));

import { ClusterOrchestrationService } from './cluster-orchestration.service';

/**
 * F-030 and F-031 of the September 2026 register.
 *
 * Provisioning is the part of the product that handles the most secret material
 * and is the part most often read through its logs, which is how both of these
 * got there. F-031 was a `DEBUG_LOG_BOOTSTRAP_KEYS` switch that printed the
 * private half of the key opening every node of the cluster; F-030 was
 * `JSON.stringify(operation.metadata)` in a failure line, over a blob declared
 * as an index signature and written from a hundred call sites.
 */

const PRIVATE_KEY =
  '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----';

function build(overrides: Record<string, unknown> = {}) {
  const logged: string[] = [];
  const record = (...args: unknown[]) =>
    logged.push(args.map((a) => String(a)).join(' '));
  const service = Object.create(
    ClusterOrchestrationService.prototype,
  ) as ClusterOrchestrationService;
  Object.assign(service, {
    logger: { log: record, warn: record, error: record, debug: record },
    sleep: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  });
  return { service, logged };
}

describe('what provisioning writes to the log', () => {
  describe('the bootstrap key (F-031)', () => {
    const mint = async (extra: Record<string, unknown> = {}) => {
      const generated = {
        publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample',
        privateKey: PRIVATE_KEY,
        fingerprint: 'SHA256:Y480mSMUabcdefghijklmnopqrstuvwxyz012345678=',
      };
      const { service, logged } = build({
        accessService: {
          getBootstrapKeyMaterialForCluster: jest.fn().mockResolvedValue(null),
          createSSHKey: jest.fn().mockResolvedValue({ id: 'key-1' }),
        },
        keyGenerator: {
          generateKeyPair: jest.fn().mockResolvedValue(generated),
        },
        clusterRepository: { update: jest.fn() },
        ...extra,
      });
      await (
        service as unknown as {
          ensureBootstrapKey: (c: unknown, n: string) => Promise<unknown>;
        }
      ).ensureBootstrapKey(
        { id: 'c1', name: 'workload-1', provider: 'hetzner' },
        'master',
      );
      return { logged: logged.join('\n'), generated };
    };

    it('never appears in it, however the run is configured', async () => {
      process.env.DEBUG_LOG_BOOTSTRAP_KEYS = 'true';
      try {
        const { logged } = await mint();
        expect(logged).not.toContain(PRIVATE_KEY);
        expect(logged).not.toContain('BEGIN OPENSSH PRIVATE KEY');
      } finally {
        delete process.env.DEBUG_LOG_BOOTSTRAP_KEYS;
      }
    });

    it('is identified by the fingerprint the key already carries', async () => {
      // Not a fresh digest of the public key's text: a value that looks like an
      // SSH fingerprint but matches neither `ssh-keygen -lf` on the node nor the
      // `ssh_keys.fingerprint` column cannot answer the only question the line
      // exists for.
      const { logged, generated } = await mint();
      expect(logged).toContain(generated.fingerprint);
    });
  });

  describe('a failed operation (F-030)', () => {
    const report = async (metadata: Record<string, unknown>) => {
      const { service, logged } = build({
        operationRepository: {
          findOne: jest.fn().mockResolvedValue({
            id: 'op-1',
            status: 'FAILED',
            progress: 40,
            errorMessage: 'provider refused',
            metadata,
            updatedAt: new Date(),
          }),
        },
      });
      await (
        service as unknown as {
          waitForOperation: (id: string, ms?: number) => Promise<void>;
        }
      )
        .waitForOperation('op-1', 60_000)
        .catch(() => undefined);
      return logged.join('\n');
    };

    it('does not print the blob it cannot vouch for', async () => {
      const logged = await report({
        stepDescription: 'attaching the volume',
        PROVIDER_TOKEN: 'a-secret-nobody-put-here-on-purpose',
      });

      expect(logged).toContain('FAILED');
      expect(logged).not.toContain('a-secret-nobody-put-here-on-purpose');
    });

    it('still says what went wrong', async () => {
      // The blob was being read for a reason. The fields the metadata type
      // actually declares are named, and the rest is listed by key, so a failed
      // provision is still diagnosable from the log.
      const logged = await report({
        stepDescription: 'attaching the volume',
        failedAt: 'volume-attach',
        PROVIDER_TOKEN: 'a-secret-nobody-put-here-on-purpose',
      });

      expect(logged).toContain('provider refused');
      expect(logged).toContain('attaching the volume');
      expect(logged).toContain('volume-attach');
      expect(logged).toContain('PROVIDER_TOKEN');
    });
  });
});
