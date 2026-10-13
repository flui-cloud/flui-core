jest.mock('@kubernetes/client-node', () => ({}));

const locks: string[] = [];
let held: Promise<unknown> = Promise.resolve();
jest.mock('../../common/leadership/advisory-lock', () => ({
  withAdvisoryLockWaiting: (
    _source: unknown,
    name: string,
    work: () => Promise<unknown>,
  ) => {
    locks.push(name);
    const run = held.then(work, work);
    held = run.catch(() => undefined);
    return run;
  },
}));

import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  FluiRegistryConfig,
  fluiRegistryConfigFrom,
} from '../flui-registry.config';
import { RegistrySettingEntity } from '../entities/registry-setting.entity';
import { FluiRegistryPublisherService } from './flui-registry-publisher.service';
import { RegistryModeService } from './registry-mode.service';
import { RegistrySettingService } from './registry-setting.service';

interface Options {
  env?: Record<string, string>;
  row?: Partial<RegistrySettingEntity> | null;
  db?: { row: Partial<RegistrySettingEntity> | null };
  stopFails?: string;
  reconcileDelayMs?: number;
  bucket?: boolean;
  using?: Array<{ id: string; name: string }>;
  reconcileFails?: string;
  settled?: boolean;
}

const harness = (options: Options = {}) => {
  const env: Record<string, string> = {
    PUBLIC_API_URL: 'https://api.example.test',
    ...options.env,
  };
  const config = fluiRegistryConfigFrom((key) => env[key]);
  const calls: string[] = [];
  const reconciled: FluiRegistryConfig[] = [];
  const db = options.db ?? { row: options.row ?? null };
  const saved: Array<Partial<RegistrySettingEntity>> = [];
  const using = options.using ?? [];
  const setting = new RegistrySettingService(
    config,
    { get: (key: string) => env[key] } as never,
    {
      findOne: async () => db.row,
      create: (value: Partial<RegistrySettingEntity>) => value,
      save: async (value: Partial<RegistrySettingEntity>) => {
        saved.push(value);
        db.row = value;
        calls.push('persist');
        return value;
      },
    } as never,
  );
  const service = new RegistryModeService(
    config,
    setting,
    {
      count: async () => using.length,
      find: async () => using,
    } as never,
    {
      reconcile: async (candidate: FluiRegistryConfig) => {
        if (options.reconcileDelayMs) {
          await new Promise((done) =>
            setTimeout(done, options.reconcileDelayMs),
          );
        }
        calls.push('reconcile');
        reconciled.push(candidate);
        if (options.reconcileFails) throw new Error(options.reconcileFails);
        return true;
      },
      settled: async () => options.settled ?? false,
      stop: async () => {
        calls.push('stop');
        if (options.stopFails) throw new Error(options.stopFails);
      },
    } as never,
    {
      status: async () => ({ connected: options.bucket ?? false }),
    } as never,
    {} as never,
  );
  const publisher = new FluiRegistryPublisherService(
    config,
    {} as never,
    {} as never,
    setting,
  );
  return { service, setting, config, calls, reconciled, saved, publisher, db };
};

describe('which registry new builds push to', () => {
  it('keeps the install-time choice while nothing was switched', async () => {
    const { service, setting, config } = harness({
      env: { FLUI_IMAGE_REGISTRY: 'ghcr' },
    });
    await setting.onModuleInit();
    expect(config.mode).toBe('ghcr');
    expect((await service.status()).source).toBe('install');
  });

  it('lets the setting win over the environment the installer writes again', async () => {
    const { service, setting, config, publisher } = harness({
      env: { FLUI_IMAGE_REGISTRY: 'ghcr' },
      row: { mode: 'flui', storageBackend: 'filesystem' },
    });
    await setting.onModuleInit();
    expect(config.mode).toBe('flui');
    expect(publisher.host()).toBe('api.example.test');
    expect(await service.status()).toMatchObject({
      mode: 'flui',
      source: 'setting',
      storage: 'volume',
    });
  });

  it('also wins when the environment says flui and the setting went back', async () => {
    const { service, setting, config } = harness({
      env: { FLUI_IMAGE_REGISTRY: 'flui' },
      row: { mode: 'ghcr', storageBackend: 'filesystem' },
    });
    await setting.onModuleInit();
    expect(config.mode).toBe('ghcr');
  });

  it('boots on the install-time choice when the setting cannot be read', async () => {
    const { service, setting, config } = harness({
      env: { FLUI_IMAGE_REGISTRY: 'flui' },
    });
    (setting as unknown as { settings: unknown }).settings = {
      findOne: async () => {
        throw new Error('relation "registry_settings" does not exist');
      },
    };
    await expect(setting.onModuleInit()).resolves.toBeUndefined();
    expect(config.mode).toBe('flui');
  });
});

describe('switching to the Flui registry', () => {
  it('puts the registry in place, then records the choice, and new builds follow without a restart', async () => {
    const { service, calls, saved, reconciled, publisher } = harness();
    expect(publisher.host()).toBeNull();

    const status = await service.enable('volume', 'user-1');

    expect(calls).toEqual(['reconcile', 'persist']);
    expect(reconciled[0]).toMatchObject({
      mode: 'flui',
      storageBackend: 'filesystem',
      host: 'api.example.test',
    });
    expect(saved[0]).toMatchObject({
      id: 'instance',
      mode: 'flui',
      storageBackend: 'filesystem',
      changedByUserId: 'user-1',
    });
    expect(publisher.host()).toBe('api.example.test');
    expect(publisher.pushTarget({ id: 'APP-1', slug: 'web' })?.imageName).toBe(
      'api.example.test/apps/app-1',
    );
    expect(status).toMatchObject({
      mode: 'flui',
      source: 'setting',
      storage: 'volume',
      ready: false,
    });
  });

  it('runs on the connected bucket with copies of its own', async () => {
    const { service, config, reconciled } = harness({ bucket: true });
    await service.enable('s3', null);
    expect(reconciled[0].storageBackend).toBe('s3');
    expect(config.storageBackend).toBe('s3');
    expect(config.replicas).toBe(2);
  });

  it('refuses a bucket when none is connected, and changes nothing', async () => {
    const { service, calls, config } = harness({ bucket: false });
    const refusal = service.enable('s3', null);
    await expect(refusal).rejects.toThrow(BadRequestException);
    await expect(refusal).rejects.toThrow(/flui registry storage connect/);
    expect(calls).toEqual([]);
    expect(config.mode).toBe('ghcr');
  });

  it('refuses when there is no address for the registry to answer on', async () => {
    const { service, calls } = harness({ env: { PUBLIC_API_URL: '' } });
    await expect(service.enable('volume', null)).rejects.toThrow(
      /no public API address/,
    );
    expect(calls).toEqual([]);
  });

  it('changes nothing when the registry cannot be put in place', async () => {
    const { service, calls, config, publisher } = harness({
      reconcileFails: 'No ready control cluster to run the registry on',
    });
    await expect(service.enable('volume', null)).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(calls).toEqual(['reconcile']);
    expect(config.mode).toBe('ghcr');
    expect(publisher.host()).toBeNull();
  });

  it('runs the registry again when asked twice with the same storage', async () => {
    const { service, calls } = harness({
      env: { FLUI_IMAGE_REGISTRY: 'flui' },
      settled: true,
    });
    const status = await service.enable('volume', null);
    expect(calls).toEqual(['reconcile', 'persist']);
    expect(status.ready).toBe(true);
  });

  it('will not move a running registry between a volume and a bucket', async () => {
    const { service, calls } = harness({
      env: { FLUI_IMAGE_REGISTRY: 'flui' },
      bucket: true,
    });
    await expect(service.enable('s3', null)).rejects.toThrow(ConflictException);
    expect(calls).toEqual([]);
  });

  it('says why readiness is unknown instead of failing the status', async () => {
    const { service } = harness({ env: { FLUI_IMAGE_REGISTRY: 'flui' } });
    (service as unknown as { deployment: unknown }).deployment = {
      settled: async () => {
        throw new Error('No ready control cluster to run the registry on');
      },
    };
    expect(await service.status()).toMatchObject({
      ready: false,
      detail: 'No ready control cluster to run the registry on',
    });
  });
});

describe('going back to GitHub Container Registry', () => {
  it('is refused, with their names, while applications run images from the Flui registry', async () => {
    const { service, calls, config } = harness({
      env: { FLUI_IMAGE_REGISTRY: 'flui' },
      using: [
        { id: 'a', name: 'api' },
        { id: 'b', name: 'web' },
      ],
    });
    const refusal = service.disable(null);
    await expect(refusal).rejects.toThrow(ConflictException);
    await expect(refusal).rejects.toThrow(/2 application\(s\).*api, web/);
    expect(calls).toEqual([]);
    expect(config.mode).toBe('flui');
  });

  it('records the choice and stops the registry when nothing uses it', async () => {
    const { service, calls, config, publisher } = harness({
      env: { FLUI_IMAGE_REGISTRY: 'flui' },
    });
    const status = await service.disable('user-1');
    expect(calls).toEqual(['stop', 'persist']);
    expect(config.mode).toBe('ghcr');
    expect(publisher.host()).toBeNull();
    expect(status).toMatchObject({ mode: 'ghcr', storage: null, ready: null });
  });

  it('does nothing on an installation already on GHCR', async () => {
    const { service, calls } = harness();
    await service.disable(null);
    expect(calls).toEqual([]);
  });
});

describe('when the registry cannot be stopped', () => {
  it('keeps builds on the Flui registry, says so, and records nothing', async () => {
    const { service, calls, config, saved, publisher } = harness({
      env: { FLUI_IMAGE_REGISTRY: 'flui' },
      stopFails: 'No ready control cluster to run the registry on',
    });
    const refusal = service.disable('user-1');
    await expect(refusal).rejects.toThrow(ServiceUnavailableException);
    await expect(refusal).rejects.toThrow(/still push to it/);
    expect(calls).toEqual(['stop']);
    expect(saved).toEqual([]);
    expect(config.mode).toBe('flui');
    expect(publisher.host()).toBe('api.example.test');
  });
});

describe('several copies of the API', () => {
  it('a second copy picks the change up on its next read', async () => {
    const db = { row: null as Partial<RegistrySettingEntity> | null };
    const first = harness({ db });
    const second = harness({ db });
    await second.setting.onModuleInit();

    await first.service.enable('volume', 'user-1');
    expect(second.config.mode).toBe('ghcr');

    await second.setting.tick();
    expect(second.config.mode).toBe('flui');
    expect(second.publisher.host()).toBe('api.example.test');
    expect((await second.service.status()).source).toBe('setting');
  });

  it('sets a workflow up on the stored choice before its own refresh comes', async () => {
    const db = { row: null as Partial<RegistrySettingEntity> | null };
    const first = harness({ db });
    const second = harness({ db });
    await first.service.enable('volume', null);

    expect(second.publisher.host()).toBeNull();
    expect(
      (await second.publisher.currentPushTarget({ id: 'A1', slug: 'web' }))
        ?.imageName,
    ).toBe('api.example.test/apps/a1');
  });

  it('goes back to the install-time choice once the setting is gone', async () => {
    const { service, setting, config, db } = harness({
      env: { FLUI_IMAGE_REGISTRY: 'ghcr' },
      row: { mode: 'flui', storageBackend: 'filesystem' },
    });
    await setting.onModuleInit();
    expect(config.mode).toBe('flui');

    db.row = null;
    await setting.tick();
    expect(config.mode).toBe('ghcr');
    expect((await service.status()).source).toBe('install');
  });

  it('does not keep a setting it failed to read at boot', async () => {
    const { service, setting, config, db } = harness({
      env: { FLUI_IMAGE_REGISTRY: 'ghcr' },
    });
    const settings = (setting as unknown as { settings: { findOne: unknown } })
      .settings;
    const findOne = settings.findOne;
    settings.findOne = async () => {
      throw new Error('connection refused');
    };
    await setting.onModuleInit();
    expect(config.mode).toBe('ghcr');

    settings.findOne = findOne;
    db.row = { mode: 'flui', storageBackend: 'filesystem' };
    await setting.tick();
    expect(config.mode).toBe('flui');
  });

  it('switches one request at a time under the registry-mode lock', async () => {
    locks.length = 0;
    const { service, calls, config } = harness({ reconcileDelayMs: 20 });
    const enabling = service.enable('volume', null);
    const disabling = service.disable(null);
    await Promise.all([enabling, disabling]);

    expect(locks).toEqual(['registry-mode', 'registry-mode']);
    expect(calls).toEqual(['reconcile', 'persist', 'stop', 'persist']);
    expect(config.mode).toBe('ghcr');
  });
});
