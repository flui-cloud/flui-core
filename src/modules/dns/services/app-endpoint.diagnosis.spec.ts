// Pulled in transitively and ship ESM jest will not parse; unused on this path.
jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jose', () => ({}));

import { AppEndpointService } from './app-endpoint.service';
import { EndpointModeResolverService } from './endpoint-mode-resolver.service';
import { ApplicationExposure } from '../../applications/enums/application-exposure.enum';
import { ENDPOINT_FAILURE_METADATA_KEY } from '../../applications/utils/endpoint-failure.util';
import { CreateAppEndpointDto } from '../dto/create-app-endpoint.dto';

/**
 * Creating the endpoint is the repair the dashboard itself suggests to whoever
 * reads "Public application has no endpoint — nobody can reach it". Until this
 * call retracted the diagnosis, that critical line survived the repair: the
 * marker it was guarded on was gone, so no later deploy cleared it either, and
 * a reachable application kept a critical diagnosis for good.
 */

const CLUSTER = {
  id: 'c-1',
  name: 'workload-cluster-1',
  masterIpAddress: '10.0.0.1',
};

const ASSIGNMENT = {
  id: 'assignment-1',
  wildcardCertificate: true,
  dnsZone: { zoneName: 'example.dev' },
};

const dto = {
  applicationId: 'app-1',
  clusterDnsZoneId: 'assignment-1',
} as CreateAppEndpointDto;

function build(metadata: Record<string, unknown>) {
  const resolve = jest.fn(async () => undefined);
  const update = jest.fn(
    async (_id: string, _patch: { metadata?: Record<string, unknown> }) =>
      undefined,
  );
  const application = {
    id: 'app-1',
    clusterId: 'c-1',
    name: 'Probe',
    slug: 'probe-1',
    k8sNamespace: 'user-probe',
    port: 8080,
    exposure: ApplicationExposure.PUBLIC,
    metadata,
  };

  const service = new AppEndpointService(
    {
      findOne: jest.fn(async () => null),
      create: (entity: Record<string, unknown>) => entity,
      save: jest.fn(async (entity: Record<string, unknown>) => entity),
    } as never,
    { findOne: jest.fn(async () => CLUSTER) } as never,
    { findOne: jest.fn(async () => ASSIGNMENT) } as never,
    { findOne: jest.fn(async () => application), update } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    new EndpointModeResolverService(),
    {} as never,
    { assertClaimable: jest.fn() } as never,
    { activeSubdomain: jest.fn(async () => null) } as never,
    { activeSubdomain: jest.fn(async () => null) } as never,
    { resolve } as never,
  );

  return { service, resolve, update };
}

describe('AppEndpointService.createEndpoint — the diagnosis it retracts', () => {
  it('resolves the "no endpoint" diagnosis and clears the marker', async () => {
    const { service, resolve, update } = build({
      [ENDPOINT_FAILURE_METADATA_KEY]: 'from the failed deploy',
    });

    await service.createEndpoint('c-1', dto);

    expect(resolve).toHaveBeenCalledWith('app-1');
    expect(update.mock.calls[0][1].metadata).not.toHaveProperty(
      ENDPOINT_FAILURE_METADATA_KEY,
    );
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('resolves it even when the marker was already cleared by an earlier repair', async () => {
    const { service, resolve, update } = build({});

    await service.createEndpoint('c-1', dto);

    expect(resolve).toHaveBeenCalledWith('app-1');
    expect(update).not.toHaveBeenCalled();
  });

  it('does not fail the creation when the diagnosis cannot be retracted', async () => {
    const { service } = build({});
    (
      service as unknown as { endpointDiagnosisService: { resolve: unknown } }
    ).endpointDiagnosisService.resolve = async () => {
      throw new Error('diagnoses table unreachable');
    };

    await expect(service.createEndpoint('c-1', dto)).resolves.toBeDefined();
  });
});
