// The service's import graph reaches ESM-only packages (Kubernetes client, jose
// via jwks-rsa) that ts-jest cannot transform; stub them — this suite touches
// none of them.
jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));
jest.mock('@octokit/rest', () => ({ Octokit: class {} }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));

import { ApplicationSourceDeployService } from './application-source-deploy.service';
import { ENDPOINT_FAILURE_METADATA_KEY } from '../utils/endpoint-failure.util';
import { CertificateProvider } from '../../providers/enums/certificate-provider.enum';

/**
 * The first real deploy of a minimal manifest — `port`, a healthcheck, nothing
 * else — produced a green build, a published image, a pod logging "listening on
 * 8080", and no endpoint: no ingress, no certificate, no DNS record, and not one
 * line anywhere saying so. The application was `exposure: public` by default and
 * unreachable on every host.
 *
 * The cause was that the endpoint hung off `deploy.domain`: the metadata key
 * that triggered it is written only when a manifest declares a domain, so the
 * one manifest shape everybody writes first — and the one the repo-to-deploy
 * engine generates on its own — was the shape that silently got nothing.
 *
 * These are the two halves of the repair: the endpoint follows the exposure,
 * and a public application that cannot be given a hostname fails loudly instead
 * of running unreachable.
 */
describe('ApplicationSourceDeployService.ensurePublicEndpoint', () => {
  const APP_ID = 'app-1';

  type Harness = ReturnType<typeof build>;

  const build = (
    app: Record<string, unknown> | null,
    opts: {
      endpoints?: Array<{ id: string; endpointType?: string }>;
      createEndpoint?: (...args: unknown[]) => Promise<unknown>;
      zoneAssignment?: unknown;
    } = {},
  ) => {
    const updates: Array<Record<string, unknown>> = [];
    const createCalls: unknown[][] = [];
    const reconciled: string[] = [];
    let current = app;

    const applicationsRepository = {
      findById: async () => current,
      update: async (_id: string, patch: Record<string, unknown>) => {
        updates.push(patch);
        current = current ? { ...current, ...patch } : current;
        return current;
      },
    };
    const appEndpointService = {
      listByApplicationId: async () => opts.endpoints ?? [],
      createEndpoint: async (...args: unknown[]) => {
        createCalls.push(args);
        if (opts.createEndpoint) return opts.createEndpoint(...args);
        return {
          id: 'ep-1',
          fqdn: 'probe.workload-4.example.dev',
          hostnameMode: 'domain',
          certChallenge: 'dns-01',
        };
      },
    };
    const appEndpointReconciliationService = {
      reconcile: async (id: string) => {
        reconciled.push(id);
      },
    };
    const clusterDnsZoneService = {
      getZoneAssignment: async () => opts.zoneAssignment ?? null,
      getZoneForFqdn: async () => opts.zoneAssignment ?? null,
      resolveWildcardIssuer: async () => null,
    };
    const diagnosisRecorded: unknown[][] = [];
    const diagnosisResolved: unknown[][] = [];
    const endpointDiagnosisService = {
      record: async (...args: unknown[]) => {
        diagnosisRecorded.push(args);
      },
      resolve: async (...args: unknown[]) => {
        diagnosisResolved.push(args);
      },
    };

    const service = new (ApplicationSourceDeployService as unknown as new (
      ...args: unknown[]
    ) => ApplicationSourceDeployService)(
      applicationsRepository,
      ...new Array(9).fill(undefined),
      appEndpointService,
      appEndpointReconciliationService,
      clusterDnsZoneService,
      undefined,
      undefined,
      endpointDiagnosisService,
    );

    return {
      service,
      updates,
      createCalls,
      reconciled,
      diagnosisRecorded,
      diagnosisResolved,
    };
  };

  const publicApp = (metadata: Record<string, unknown> = {}) => ({
    id: APP_ID,
    slug: 'flui-apply-probe-883q7r',
    clusterId: 'cluster-4',
    exposure: 'public',
    category: 'user',
    systemProtected: false,
    metadata,
  });

  const failureOf = (h: Harness): string | undefined =>
    h.updates
      .map(
        (u) =>
          (u.metadata as Record<string, string> | undefined)?.[
            ENDPOINT_FAILURE_METADATA_KEY
          ],
      )
      .filter(Boolean)
      .pop();

  /** The defect itself: no `deploy.domain`, and therefore no endpoint. */
  it('creates the endpoint for a manifest that declares no domain at all', async () => {
    const h = build(publicApp());

    await h.service.ensurePublicEndpoint(APP_ID);

    expect(h.createCalls).toHaveLength(1);
    const [clusterId, dto] = h.createCalls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(clusterId).toBe('cluster-4');
    expect(dto.applicationId).toBe(APP_ID);
    expect(dto.certificateRequired).toBe(true);
    // Nothing was declared, so nothing is imposed: the hostname is left to the
    // resolver that already mints one for the catalog.
    expect(dto.fqdn).toBeUndefined();
    expect(h.reconciled).toEqual(['ep-1']);
  });

  it('still treats deploy.domain as the override it always was', async () => {
    const h = build(
      publicApp({
        'flui.endpoint.spec': JSON.stringify({
          fqdn: 'probe.acme.dev',
          tls: false,
          hostnameMode: 'domain',
          certChallenge: 'dns-01',
          certificateProvider: 'lets-encrypt-staging',
        }),
      }),
    );

    await h.service.ensurePublicEndpoint(APP_ID);

    const [, dto] = h.createCalls[0] as [string, Record<string, unknown>];
    expect(dto.fqdn).toBe('probe.acme.dev');
    expect(dto.certificateRequired).toBe(false);
    expect(dto.hostnameMode).toBe('domain');
    expect(dto.certChallenge).toBe('dns-01');
    expect(dto.certificateProvider).toBe(
      CertificateProvider.LETS_ENCRYPT_STAGING,
    );
  });

  /**
   * The deliberately controversial half. A public application with no hostname
   * is unreachable whatever its pods say, so the deploy is not allowed to end
   * green: it throws, which is how the deploy processor fails an operation, and
   * the reason is written on the application so the reconciler — which reads
   * status off healthy pods — cannot quietly call it running again.
   */
  it('fails the deploy, with the cause, when no hostname can be minted', async () => {
    const h = build(publicApp(), {
      createEndpoint: async () => {
        throw new Error(
          'Cluster cluster-4 has no master IP yet — cannot derive nip.io hostname',
        );
      },
    });

    await expect(h.service.ensurePublicEndpoint(APP_ID)).rejects.toThrow(
      /no master IP yet/,
    );
    expect(failureOf(h)).toContain('exposure: public');
    expect(failureOf(h)).toContain('no master IP yet');

    // The same fact lands where a person looks for it on the dashboard, not
    // only in the metadata the reconciler reads.
    expect(h.diagnosisRecorded).toHaveLength(1);
    const [recordedApp, recordedCause] = h.diagnosisRecorded[0];
    expect((recordedApp as { id: string }).id).toBe(APP_ID);
    expect(recordedCause).toContain('no master IP yet');
  });

  it('leaves nothing behind once the endpoint exists', async () => {
    const h = build(
      publicApp({ [ENDPOINT_FAILURE_METADATA_KEY]: 'from the last deploy' }),
      { endpoints: [{ id: 'ep-old' }] },
    );

    await h.service.ensurePublicEndpoint(APP_ID);

    expect(h.createCalls).toHaveLength(0);
    expect(h.reconciled).toEqual(['ep-old']);
    expect(failureOf(h)).toBeUndefined();
    expect(h.updates[0].metadata).not.toHaveProperty(
      ENDPOINT_FAILURE_METADATA_KEY,
    );
    // A stale diagnosis from a previous failed deploy is resolved too, not
    // just the metadata marker.
    expect(h.diagnosisResolved).toEqual([[APP_ID]]);
  });

  /**
   * An application moved from `internal` to `public` keeps the internal
   * endpoint it already had. Counting that one as "already exposed" is the
   * same defect wearing a different coat: nothing is created, nothing is
   * written, nothing is said, and no host answers.
   */
  it('gives a public endpoint to an application whose only endpoint is internal', async () => {
    const h = build(publicApp(), {
      endpoints: [{ id: 'ep-internal', endpointType: 'internal' }],
    });

    await h.service.ensurePublicEndpoint(APP_ID);

    expect(h.createCalls).toHaveLength(1);
    expect(h.reconciled).toEqual(['ep-1']);
  });

  /**
   * The repair the interface itself suggests — create the endpoint by hand —
   * clears the marker, so a resolve guarded on the marker never fired again
   * and the critical diagnosis kept claiming nobody could reach an application
   * anybody could reach.
   */
  it('retracts a stale diagnosis even when no marker is left to find', async () => {
    const h = build(publicApp(), { endpoints: [{ id: 'ep-old' }] });

    await h.service.ensurePublicEndpoint(APP_ID);

    expect(h.updates).toHaveLength(0);
    expect(h.diagnosisResolved).toEqual([[APP_ID]]);
  });

  it('owes nothing to an application that is not public, and clears a stale verdict', async () => {
    const h = build({
      ...publicApp({ [ENDPOINT_FAILURE_METADATA_KEY]: 'from the last deploy' }),
      exposure: 'internal',
    });

    await h.service.ensurePublicEndpoint(APP_ID);

    expect(h.createCalls).toHaveLength(0);
    expect(h.updates[0].metadata).not.toHaveProperty(
      ENDPOINT_FAILURE_METADATA_KEY,
    );
    expect(h.diagnosisResolved).toEqual([[APP_ID]]);
  });

  /** A catalog install mints its own hostname, with the domain the installer asked for. */
  it('leaves a catalog install to its own endpoint', async () => {
    const h = build(publicApp({ catalogInstallId: 'install-9' }));

    await h.service.ensurePublicEndpoint(APP_ID);

    expect(h.createCalls).toHaveLength(0);
  });

  it('does not overwrite a name it cannot read with one of its own', async () => {
    const h = build(publicApp({ 'flui.endpoint.spec': '{not json' }));

    await expect(h.service.ensurePublicEndpoint(APP_ID)).rejects.toThrow(
      /flui\.endpoint\.spec/,
    );
    expect(h.createCalls).toHaveLength(0);
    expect(h.diagnosisRecorded).toHaveLength(1);
  });

  /** An author who opted out keeps the opt-out — but no longer in silence. */
  it('honours domain.auto=false without creating anything', async () => {
    const h = build(
      publicApp({ 'flui.endpoint.spec': JSON.stringify({ auto: false }) }),
    );

    await h.service.ensurePublicEndpoint(APP_ID);

    expect(h.createCalls).toHaveLength(0);
  });
});
