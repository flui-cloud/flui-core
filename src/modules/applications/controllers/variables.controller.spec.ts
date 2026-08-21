/* eslint-disable sonarjs/assertions-in-tests --
   Some assertions are supertest's own `.expect(status)`, which throws on a
   mismatch; the rule only recognises a global `expect()`. */

// Same reason as `clusters.controller.fence.spec.ts`: the import graph reaches
// ESM-only packages ts-jest cannot transform, and this suite touches none of them.
jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import * as request from 'supertest';
import { VariablesController } from './variables.controller';
import { AppConfigService } from '../services/app-config.service';
import { AppAccessGuard } from '../guards/app-access.guard';
import { ApplicationsRepository } from '../repositories/applications.repository';
import { AppResourcesRepository } from '../repositories/app-resources.repository';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { ApplicationEnvVar } from '../interfaces/source-config.interface';

/**
 * The hand-off of a sensitive variable, through the real controller and the
 * real service — only the cluster and the database are stand-ins.
 *
 * What each case is here to catch:
 *
 *  - **"missing a value" is a state.** Declaring a key returns 200 and the read
 *    reports it as awaiting, not as configured and not as an error;
 *  - **the value is never read back.** After delivery the whole response body
 *    is searched for the secret. If it ever appears anywhere — a field, a name,
 *    a log line copied into a message — this goes red;
 *  - **declaring cannot destroy.** A key that already holds a value survives an
 *    agent asking for it again.
 */

const APP_ID = 'app-1';
const SECRET = 'sk_live_do_not_leak_me';

describe('variables controller — delivering a sensitive value', () => {
  let app: INestApplication;
  let stored: ApplicationEnvVar[];
  let clusterByName: Record<string, Record<string, string>>;
  /** Every manifest pushed to the cluster, so a needless write is visible. */
  let written: string[];

  beforeAll(async () => {
    const application = {
      id: APP_ID,
      slug: 'my-api',
      clusterId: 'cluster-1',
      k8sNamespace: 'default',
      get env() {
        return stored;
      },
    };

    const applications = {
      findById: async (id: string) => (id === APP_ID ? application : null),
      update: async (_id: string, patch: { env: ApplicationEnvVar[] }) => {
        stored = patch.env;
      },
    };

    const kubernetes = {
      getWorkloadEnvSources: async () => ({
        configMaps: ['my-api-config'],
        secrets: ['my-api-secret'],
      }),
      getResource: async (_kubeconfig: string, kind: string, name: string) => ({
        metadata: { resourceVersion: '1' },
        // The cluster is deliberately truthful about the naming: the Secret the
        // workload reads is `<slug>-secret`, and the one the sensitive upsert
        // writes is `<slug>-secret`. A read that only believed the cluster
        // would lose a just-delivered key until the next deploy.
        data: kind === 'Secret' ? (clusterByName[name] ?? {}) : {},
      }),
      replaceManifest: async (_kubeconfig: string, manifest: string) => {
        const parsed = JSON.parse(manifest) as {
          kind: string;
          metadata: { name: string };
          data: Record<string, string>;
        };
        written.push(parsed.kind);
        if (parsed.kind === 'Secret') {
          clusterByName[parsed.metadata.name] = parsed.data;
        }
      },
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [VariablesController],
      providers: [
        AppConfigService,
        { provide: ApplicationsRepository, useValue: applications },
        {
          provide: AppResourcesRepository,
          useValue: { findByApplicationId: async () => [] },
        },
        { provide: KubernetesService, useValue: kubernetes },
        {
          provide: EncryptionService,
          useValue: {
            encrypt: (v: string) => `enc:${v}`,
            decrypt: (v: string) => v.replace(/^enc:/, ''),
          },
        },
        {
          provide: getRepositoryToken(ClusterEntity),
          useValue: {
            findOne: async () => ({
              id: 'cluster-1',
              kubeconfigEncrypted: 'enc:kubeconfig',
            }),
          },
        },
      ],
    })
      // The guard has its own suite; what is under test here is the hand-off.
      .overrideGuard(AppAccessGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
    await app.init();
  });

  beforeEach(() => {
    stored = [{ name: 'LOG_LEVEL', value: 'info', source: 'user' }];
    clusterByName = {};
    written = [];
  });

  afterAll(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());
  const declare = (key: string) =>
    http()
      .put(`/variables/applications/${APP_ID}?type=sensitive`)
      .send({ data: {}, requestKeys: [key] });
  const deliver = (key: string, value: string) =>
    http()
      .put(`/variables/applications/${APP_ID}?type=sensitive`)
      .send({ data: { [key]: value } });

  it('creates a sensitive variable with no value, and the read calls it missing', async () => {
    const res = await declare('STRIPE_SECRET_KEY').expect(200);
    expect(res.body.pendingKeys).toEqual(['STRIPE_SECRET_KEY']);
    expect(res.body.sensitiveKeys).not.toContain('STRIPE_SECRET_KEY');
    expect(res.body.data).not.toHaveProperty('STRIPE_SECRET_KEY');
  });

  it('writes nothing to the cluster for a key that is only declared', async () => {
    await declare('STRIPE_SECRET_KEY').expect(200);
    expect(clusterByName).toEqual({});
    expect(written).toEqual([]);
  });

  it('says configured after delivery, and keeps masking', async () => {
    await declare('STRIPE_SECRET_KEY').expect(200);
    const res = await deliver('STRIPE_SECRET_KEY', SECRET).expect(200);
    expect(res.body.sensitiveKeys).toContain('STRIPE_SECRET_KEY');
    expect(res.body.pendingKeys).toEqual([]);
    expect(res.body.data.STRIPE_SECRET_KEY).toBe('****');
  });

  // The rule that has no second chance: once delivered, nothing reads it back.
  it('never returns the value, anywhere in the response', async () => {
    await declare('STRIPE_SECRET_KEY').expect(200);
    const after = await deliver('STRIPE_SECRET_KEY', SECRET).expect(200);
    expect(JSON.stringify(after.body)).not.toContain(SECRET);

    const reread = await http()
      .get(`/variables/applications/${APP_ID}`)
      .expect(200);
    expect(JSON.stringify(reread.body)).not.toContain(SECRET);
    expect(reread.body.data.STRIPE_SECRET_KEY).toBe('****');
  });

  it('stores the value encrypted, never in the clear', async () => {
    await deliver('STRIPE_SECRET_KEY', SECRET).expect(200);
    const entry = stored.find((e) => e.name === 'STRIPE_SECRET_KEY');
    expect(entry?.value).toBe(`enc:${SECRET}`);
    expect(entry?.secret).toBe(true);
    expect(entry?.pending).toBeUndefined();
  });

  it('leaves a configured key alone when it is asked for again', async () => {
    await deliver('STRIPE_SECRET_KEY', SECRET).expect(200);
    const res = await declare('STRIPE_SECRET_KEY').expect(200);
    expect(res.body.pendingKeys).toEqual([]);
    expect(res.body.sensitiveKeys).toContain('STRIPE_SECRET_KEY');
    expect(stored.find((e) => e.name === 'STRIPE_SECRET_KEY')?.value).toBe(
      `enc:${SECRET}`,
    );
  });

  // Delivery lands in the Secret the workload actually mounts — singular,
  // the name every other consumer binds.
  // The read still answers from the database first, because the pod only
  // picks a patched Secret up when it is next rolled.
  it('reports a delivered key before any redeploy has moved it', async () => {
    await deliver('STRIPE_SECRET_KEY', SECRET).expect(200);
    expect(clusterByName['my-api-secret']?.STRIPE_SECRET_KEY).toBe(
      Buffer.from(SECRET).toString('base64'),
    );

    const res = await http()
      .get(`/variables/applications/${APP_ID}`)
      .expect(200);
    expect(res.body.sensitiveKeys).toContain('STRIPE_SECRET_KEY');
    expect(res.body.pendingKeys).toEqual([]);
  });

  // A building block's bootstrap writes straight into the cluster and never
  // through here. Those keys are configured too, and must not disappear.
  it('still surfaces a key that exists only in the cluster', async () => {
    clusterByName['my-api-secret'] = {
      OPENBAO_UNSEAL_KEY: Buffer.from('x').toString('base64'),
    };
    const res = await http()
      .get(`/variables/applications/${APP_ID}`)
      .expect(200);
    expect(res.body.sensitiveKeys).toContain('OPENBAO_UNSEAL_KEY');
    expect(res.body.data.OPENBAO_UNSEAL_KEY).toBe('****');
  });

  // Silently dropping the field would report a hand-off that was never recorded.
  it('refuses requestKeys on the plain path instead of ignoring them', async () => {
    const res = await http()
      .put(`/variables/applications/${APP_ID}?type=plain`)
      .send({ data: {}, requestKeys: ['STRIPE_SECRET_KEY'] })
      .expect(400);
    expect(res.body.message).toContain('sensitive');
  });

  it('delivers and declares in one call without the two colliding', async () => {
    const res = await http()
      .put(`/variables/applications/${APP_ID}?type=sensitive`)
      .send({ data: { A_KEY: SECRET }, requestKeys: ['A_KEY', 'B_KEY'] })
      .expect(200);
    expect(res.body.sensitiveKeys).toContain('A_KEY');
    expect(res.body.pendingKeys).toEqual(['B_KEY']);
  });
});
