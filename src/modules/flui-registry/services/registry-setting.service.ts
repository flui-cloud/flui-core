import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { LOCAL_JOB } from '../../common/leadership/scheduler-leadership.service';
import {
  REGISTRY_SETTING_ID,
  RegistrySettingEntity,
} from '../entities/registry-setting.entity';
import {
  FLUI_REGISTRY_CONFIG,
  FluiRegistryConfig,
  RegistrySetting,
  fluiRegistryConfigFrom,
} from '../flui-registry.config';
import { describeError } from '../../shared/utils/error.util';

/**
 * The installation's registry choice, which wins over the install-time
 * environment the installer writes again on every restart. Every copy of the
 * API reads it back every ten seconds into the one shared configuration; the
 * paths that must not act on a stale choice read it through `current()`.
 */
@Injectable()
export class RegistrySettingService implements OnModuleInit {
  private readonly logger = new Logger(RegistrySettingService.name);
  private origin: 'setting' | 'install' = 'install';
  private unreadable = false;

  constructor(
    @Inject(FLUI_REGISTRY_CONFIG) private readonly config: FluiRegistryConfig,
    private readonly env: ConfigService,
    @InjectRepository(RegistrySettingEntity)
    private readonly settings: Repository<RegistrySettingEntity>,
  ) {}

  /** `setting` once someone switched after install; `install` while the install-time choice holds. */
  get source(): 'setting' | 'install' {
    return this.origin;
  }

  async onModuleInit(): Promise<void> {
    await this.tick();
  }

  @Cron(CronExpression.EVERY_10_SECONDS, { name: `${LOCAL_JOB}registry-mode` })
  async tick(): Promise<void> {
    try {
      await this.refresh();
      if (this.unreadable)
        this.logger.log('The registry setting is read again');
      this.unreadable = false;
    } catch (error) {
      if (!this.unreadable) {
        this.logger.warn(
          `The registry setting could not be read; the last known choice holds: ${describeError(error)}`,
        );
      }
      this.unreadable = true;
    }
  }

  /** The setting as stored now, applied to the shared configuration. */
  async refresh(): Promise<FluiRegistryConfig> {
    const row = await this.settings.findOne({
      where: { id: REGISTRY_SETTING_ID },
    });
    this.apply(
      row ? { mode: row.mode, storageBackend: row.storageBackend } : null,
    );
    return this.config;
  }

  /** The configuration to act on, read from the stored setting at this moment. */
  current(): Promise<FluiRegistryConfig> {
    return this.refresh();
  }

  /** What the configuration would be with `setting`, without recording it. */
  candidate(setting: RegistrySetting): FluiRegistryConfig {
    return fluiRegistryConfigFrom((key) => this.env.get<string>(key), setting);
  }

  async record(setting: RegistrySetting, userId: string | null): Promise<void> {
    await this.settings.save(
      this.settings.create({
        id: REGISTRY_SETTING_ID,
        mode: setting.mode,
        storageBackend: setting.storageBackend,
        changedByUserId: userId,
      }),
    );
    this.apply(setting);
  }

  private apply(setting: RegistrySetting | null): void {
    Object.assign(
      this.config,
      fluiRegistryConfigFrom((key) => this.env.get<string>(key), setting),
    );
    this.origin = setting ? 'setting' : 'install';
  }
}
