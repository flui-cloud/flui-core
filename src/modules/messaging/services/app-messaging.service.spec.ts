jest.mock('@kubernetes/client-node', () => ({}));

import { AppMessagingService } from './app-messaging.service';
import { newAccountKey, newOperatorKey, seedOf } from '../nats/nats-jwt';

const USER = { userId: 'u1', email: 'u1@example.com' } as never;
const claims = (jwt: string) =>
  JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());

function build(denied = false) {
  const operator = newOperatorKey();
  const rows: Record<string, any>[] = [];
  const accounts = {
    findOne: jest.fn(
      async ({ where }: { where: { applicationId: string } }) =>
        rows.find((r) => r.applicationId === where.applicationId) ?? null,
    ),
    create: (v: object) => v,
    insert: jest.fn(async (v: Record<string, any>) => {
      rows.push(v);
    }),
    delete: jest.fn(async ({ publicKey }: { publicKey: string }) => {
      rows.splice(
        rows.findIndex((r) => r.publicKey === publicKey),
        1,
      );
    }),
  };
  const app = {
    id: 'app1',
    slug: 'shop',
    clusterId: 'c1',
    imageRef: 'img:1',
    env: [{ name: 'KEEP', value: 'x' }],
  };
  const applications = {
    findById: jest.fn(async () => app),
    update: jest.fn(async (_id: string, data: Record<string, unknown>) => ({
      ...app,
      ...data,
    })),
  };
  const clusterNats = {
    operatorFor: jest.fn(async () => ({
      operatorSeed: `enc:${seedOf(operator)}`,
      systemAccount: newAccountKey().getPublicKey(),
    })),
    deploy: jest.fn(async () => undefined),
    ensureKeda: jest.fn(async () => undefined),
  };
  const autoscaling = { reconcile: jest.fn(async () => undefined) };
  const deploy = { deploy: jest.fn(async () => undefined) };
  const service = new AppMessagingService(
    accounts as never,
    applications as never,
    {
      assertCan: jest.fn(async () => {
        if (denied) throw new Error('forbidden');
      }),
    } as never,
    deploy as never,
    {
      encrypt: (v: string) => `enc:${v}`,
      decrypt: (v: string) => v.replace(/^enc:/, ''),
    } as never,
    clusterNats as never,
    autoscaling as never,
  );
  return {
    service,
    rows,
    applications,
    clusterNats,
    deploy,
    operator,
    autoscaling,
  };
}

describe('an application’s own account on its cluster’s NATS', () => {
  it('makes an account the cluster’s operator signs, and puts the server in place', async () => {
    const { service, rows, clusterNats, operator } = build();
    await service.connect(USER, 'app1');
    expect(clusterNats.deploy).toHaveBeenCalledWith('c1');
    expect(claims(rows[0].jwt)).toMatchObject({
      iss: operator.getPublicKey(),
      sub: rows[0].publicKey,
      nats: { type: 'account', limits: { disk_storage: -1 } },
    });
    expect(rows[0].seed).toMatch(/^enc:SA/);
  });

  it('hands the application the address and a credentials file signed by its account, then redeploys', async () => {
    const { service, rows, applications, deploy } = build();
    await service.connect(USER, 'app1');
    const { env } = (applications.update.mock.calls[0] as unknown[])[1] as {
      env: any[];
    };
    expect(env.map((e) => [e.name, e.secret ?? false, e.source])).toEqual([
      ['KEEP', false, undefined],
      ['NATS_URL', false, 'link'],
      ['NATS_CREDS', true, 'link'],
    ]);
    const creds = env[2].value.replace(/^enc:/, '');
    const userJwt = creds.split('\n')[1];
    expect(claims(userJwt)).toMatchObject({
      iss: rows[0].publicKey,
      nats: { type: 'user' },
    });
    expect(creds).toMatch(/-----BEGIN USER NKEY SEED-----\nSU/);
    expect(deploy.deploy).toHaveBeenCalledWith(
      'app1',
      { useCurrentImage: true },
      'u1',
    );
  });

  it('gives one application one account, however often it asks', async () => {
    const { service, rows } = build();
    await service.connect(USER, 'app1');
    await service.connect(USER, 'app1');
    expect(rows).toHaveLength(1);
  });

  it('removes both variables and the account on disconnect', async () => {
    const { service, rows, applications } = build();
    await service.connect(USER, 'app1');
    applications.update.mockClear();
    await service.disconnect(USER, 'app1');
    const { env } = (applications.update.mock.calls[0] as unknown[])[1] as {
      env: any[];
    };
    expect(env.map((e) => e.name)).toEqual(['KEEP']);
    expect(rows).toHaveLength(0);
  });

  it('asks the caller’s permission first', async () => {
    const { service, clusterNats } = build(true);
    await expect(service.connect(USER, 'app1')).rejects.toThrow('forbidden');
    expect(clusterNats.deploy).not.toHaveBeenCalled();
  });

  it('scales a connected app on its queue with its own account, installing KEDA', async () => {
    const { service, rows, applications, clusterNats, autoscaling } = build();
    await service.connect(USER, 'app1');
    applications.update.mockClear();
    const view = await service.scaleOnQueue(USER, 'app1', {
      stream: 'ORDERS',
      consumer: 'mailer',
      lagThreshold: 20,
      min: 0,
      max: 4,
    });
    expect(clusterNats.ensureKeda).toHaveBeenCalledWith('c1');
    const { scaling } = (applications.update.mock.calls[0] as unknown[])[1] as {
      scaling: any;
    };
    expect(scaling).toMatchObject({
      enabled: true,
      queue: { account: rows[0].publicKey, min: 0 },
    });
    expect(autoscaling.reconcile).toHaveBeenCalled();
    expect(view.applicationId).toBe('app1');
  });

  it('refuses to scale an app on a queue it has no account for', async () => {
    const { service } = build();
    await expect(
      service.scaleOnQueue(USER, 'app1', {
        stream: 'S',
        consumer: 'C',
        lagThreshold: 1,
        min: 0,
        max: 1,
      }),
    ).rejects.toThrow('NATS account first');
  });
});
