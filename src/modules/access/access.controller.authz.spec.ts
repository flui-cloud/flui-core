jest.mock('@kubernetes/client-node', () => ({}));

import { AccessController } from './access.controller';
import { REQUIRED_PERMISSION_KEY } from '../iam/decorators/require-permission.decorator';
import { REQUIRED_SECTION_KEY } from '../iam/decorators/require-section.decorator';
import { IAM_PERMISSION } from '../iam/constants/iam-permissions';
import { SECTION } from '../iam/constants/iam-sections';

const proto = AccessController.prototype as unknown as Record<
  string,
  (...args: unknown[]) => unknown
>;

describe('AccessController authorization', () => {
  it('sits in the infrastructure section as a whole', () => {
    expect(Reflect.getMetadata(REQUIRED_SECTION_KEY, AccessController)).toBe(
      SECTION.INFRASTRUCTURE,
    );
  });

  it.each([
    'addSSHKey',
    'updateSSHKey',
    'generateBearerToken',
    'refreshToken',
    'listBearerTokens',
    'removeBearerToken',
    'listApiTokens',
    'createApiToken',
    'getApiToken',
  ])('%s asks for cluster:manage', (method) => {
    expect(proto[method]).toBeDefined();
    expect(Reflect.getMetadata(REQUIRED_PERMISSION_KEY, proto[method])).toBe(
      IAM_PERMISSION.CLUSTER_MANAGE,
    );
  });

  it('never returns a stored secret or token when listing provider credentials', async () => {
    const row = {
      id: 'c1',
      provider: 'contabo',
      purpose: 'compute',
      isActive: true,
      client_id: 'id',
      client_secret: 'SECRET',
      username: 'me',
      password: 'PASSWORD',
      access_token: 'ACCESS',
      refresh_token: 'REFRESH',
      token_expires_at: new Date('2026-10-01T00:00:00Z'),
      createdAt: new Date('2026-09-01T00:00:00Z'),
    };
    const controller = new AccessController({
      listBearerTokens: async () => [row],
    } as never);
    const listed = await controller.listBearerTokens();
    const text = JSON.stringify(listed);
    for (const secret of ['SECRET', 'PASSWORD', 'ACCESS', 'REFRESH']) {
      expect(text).not.toContain(secret);
    }
    expect(listed[0]).toMatchObject({ id: 'c1', provider: 'contabo' });
  });
});
