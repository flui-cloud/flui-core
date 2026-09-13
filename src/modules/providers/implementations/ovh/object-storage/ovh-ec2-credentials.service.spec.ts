import { OvhEc2CredentialsService } from './ovh-ec2-credentials.service';

jest.mock('../ovh-openstack-client.factory', () => ({
  resolveOvhProjectId: jest.fn().mockResolvedValue('proj-1'),
}));

const AUTH = 'https://auth.cloud.ovh.net/v3';

/**
 * Keystone EC2 credentials carry no metadata, so Flui cannot tell one of its
 * own from one the customer made. That is why the service reuses rather than
 * mints, and never revokes: every mint would otherwise leave another live key
 * on the account, and every revoke could break something invisible to us.
 */
describe('OvhEc2CredentialsService', () => {
  const config = { get: (_k: string, d?: string) => d } as never;
  const credentialProvider = {
    getActiveAccessKeyPair: jest
      .fn()
      .mockResolvedValue({ accessKey: 'os-user', secretKey: 'os-pass' }),
  } as never;

  let fetchMock: jest.Mock;

  function scopedAuthResponse() {
    return {
      ok: true,
      headers: { get: (h: string) => (h === 'x-subject-token' ? 'tok' : null) },
      json: async () => ({ token: { user: { id: 'user-1' } } }),
    };
  }

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as never;
  });

  it('reuses an existing credential instead of minting another', async () => {
    fetchMock
      .mockResolvedValueOnce(scopedAuthResponse())
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          credentials: [
            { access: 'BBB', secret: 's2', tenant_id: 'proj-1' },
            { access: 'AAA', secret: 's1', tenant_id: 'proj-1' },
          ],
        }),
      });

    const service = new OvhEc2CredentialsService(config, credentialProvider);
    const result = await service.ensureS3KeyPair();

    expect(result).toEqual({ accessKey: 'AAA', secretKey: 's1', reused: true });
    // auth + list only — no POST.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('ignores credentials belonging to another project', async () => {
    fetchMock
      .mockResolvedValueOnce(scopedAuthResponse())
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          credentials: [{ access: 'X', secret: 's', tenant_id: 'other-proj' }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          credential: { access: 'NEW', secret: 'ns', tenant_id: 'proj-1' },
        }),
      });

    const service = new OvhEc2CredentialsService(config, credentialProvider);
    const result = await service.ensureS3KeyPair();

    expect(result).toEqual({
      accessKey: 'NEW',
      secretKey: 'ns',
      reused: false,
    });
    const [url, init] = fetchMock.mock.calls[2];
    expect(url).toBe(`${AUTH}/users/user-1/credentials/OS-EC2`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ tenant_id: 'proj-1' });
  });

  it('surfaces a refusal instead of returning an unusable pair', async () => {
    fetchMock
      .mockResolvedValueOnce(scopedAuthResponse())
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ credentials: [] }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => 'Forbidden',
      });

    const service = new OvhEc2CredentialsService(config, credentialProvider);

    await expect(service.ensureS3KeyPair()).rejects.toThrow(/HTTP 403/);
  });

  it('reports not-connected rather than throwing when OVH is absent', async () => {
    const missing = {
      getActiveAccessKeyPair: jest.fn().mockRejectedValue(new Error('none')),
    } as never;

    const service = new OvhEc2CredentialsService(config, missing);

    await expect(service.hasComputeCredential()).resolves.toBe(false);
  });
});
