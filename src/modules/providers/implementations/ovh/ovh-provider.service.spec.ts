jest.mock('@flui-cloud/infra', () => ({
  OvhProviderService: jest.fn(),
  packRegionId: jest.fn(),
  parseRegionId: jest.fn(),
}));
jest.mock('./ovh-openstack-client.factory', () => ({
  buildOvhOpenStackClient: jest.fn().mockResolvedValue({}),
}));

import { OvhProviderService as InfraOvhProviderService } from '@flui-cloud/infra';
import {
  OvhProviderService,
  normalizeOvhServerStatus,
} from './ovh-provider.service';

describe('normalizeOvhServerStatus', () => {
  it('maps Nova ACTIVE to the common "running" ServersService.waitForServerReady polls for', () => {
    expect(normalizeOvhServerStatus('ACTIVE')).toBe('running');
  });

  it('maps Nova ERROR to the common "error"', () => {
    expect(normalizeOvhServerStatus('ERROR')).toBe('error');
  });

  it('lowercases any other Nova status rather than leaving it opaque uppercase', () => {
    expect(normalizeOvhServerStatus('BUILD')).toBe('build');
    expect(normalizeOvhServerStatus('SHUTOFF')).toBe('shutoff');
  });
});

describe('OvhProviderService.getServerStatus — not-found translation', () => {
  function build(getServerStatus: jest.Mock) {
    (InfraOvhProviderService as unknown as jest.Mock).mockImplementation(
      () => ({ getServerStatus }),
    );
    const credentialProvider = {
      getActiveAccessKeyPair: jest
        .fn()
        .mockResolvedValue({ accessKey: 'ak', secretKey: 'sk' }),
    };
    return new OvhProviderService({} as never, credentialProvider as never);
  }

  it('translates infra\'s "not found" throw into the "not-found" status string waitForDeletionComplete polls for', async () => {
    const service = build(
      jest.fn().mockRejectedValue(new Error('OVH server abc-123 not found.')),
    );

    await expect(service.getServerStatus('abc-123')).resolves.toBe('not-found');
  });

  it('re-throws any error that is not a "not found" — a transient failure must not look like a completed delete', async () => {
    const service = build(
      jest.fn().mockRejectedValue(new Error('OVH API unreachable')),
    );

    await expect(service.getServerStatus('abc-123')).rejects.toThrow(
      'OVH API unreachable',
    );
  });

  it('normalizes a real status when the call succeeds', async () => {
    const service = build(jest.fn().mockResolvedValue('ACTIVE'));

    await expect(service.getServerStatus('abc-123')).resolves.toBe('running');
  });
});
