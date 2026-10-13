import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, Not, Repository } from 'typeorm';
import { withAdvisoryLockWaiting } from '../../common/leadership/advisory-lock';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import {
  FLUI_REGISTRY_CONFIG,
  FluiRegistryConfig,
  ImageRegistryMode,
  RegistryStorageBackend,
} from '../flui-registry.config';
import { FluiRegistryDeploymentService } from './flui-registry-deployment.service';
import { RegistrySettingService } from './registry-setting.service';
import { RegistryStorageService } from './registry-storage.service';
import { describeError } from '../../shared/utils/error.util';

export type RegistryStorageChoice = 'volume' | 's3';

export interface RegistryModeStatus {
  mode: ImageRegistryMode;
  /** `setting` once someone switched after install; `install` while the install-time choice holds. */
  source: 'setting' | 'install';
  /** Where the Flui registry keeps images; null while builds go to GitHub Container Registry. */
  storage: RegistryStorageChoice | null;
  host: string | null;
  /** Every copy runs its current configuration; null while the Flui registry is off. */
  ready: boolean | null;
  /** Why readiness could not be read, when it could not. */
  detail: string | null;
  bucketConnected: boolean;
  applicationsOnRegistry: number;
}

const IN_USE_SHOWN = 10;

const storageOf = (backend: RegistryStorageBackend): RegistryStorageChoice =>
  backend === 's3' ? 's3' : 'volume';

const backendOf = (storage: RegistryStorageChoice): RegistryStorageBackend =>
  storage === 's3' ? 's3' : 'filesystem';

const placeOf = (backend: RegistryStorageBackend): string =>
  backend === 's3' ? 'a bucket' : 'a volume on the control cluster';

/**
 * Switches which registry new builds push to after install, one switch at a
 * time across every copy of the API. The choice itself lives in
 * `RegistrySettingService`, which every copy reads back.
 */
@Injectable()
export class RegistryModeService {
  private readonly logger = new Logger(RegistryModeService.name);

  constructor(
    @Inject(FLUI_REGISTRY_CONFIG) private readonly config: FluiRegistryConfig,
    private readonly setting: RegistrySettingService,
    @InjectRepository(ApplicationEntity)
    private readonly applications: Repository<ApplicationEntity>,
    private readonly deployment: FluiRegistryDeploymentService,
    private readonly storage: RegistryStorageService,
    private readonly dataSource: DataSource,
  ) {}

  async status(): Promise<RegistryModeStatus> {
    await this.setting.refresh();
    const on = this.config.mode === 'flui';
    let ready: boolean | null = null;
    let detail: string | null = null;
    if (on) {
      try {
        ready = await this.deployment.settled();
      } catch (error) {
        ready = false;
        detail = describeError(error);
      }
    }
    return {
      mode: this.config.mode,
      source: this.setting.source,
      storage: on ? storageOf(this.config.storageBackend) : null,
      host: this.config.host,
      ready,
      detail,
      bucketConnected: (await this.storage.status()).connected,
      applicationsOnRegistry: await this.applications.count({
        where: { imageRegistryHost: Not(IsNull()), deletedAt: IsNull() },
      }),
    };
  }

  /**
   * Puts the Flui registry on the control cluster, then sends new builds to
   * it. Nothing changes when it cannot be put in place. Applications built
   * before keep the images they run; they move at their next workflow setup.
   */
  async enable(
    storage: RegistryStorageChoice,
    userId: string | null,
  ): Promise<RegistryModeStatus> {
    await this.exclusively(() => this.switchOn(storage, userId));
    return this.status();
  }

  private async switchOn(
    storage: RegistryStorageChoice,
    userId: string | null,
  ): Promise<void> {
    await this.setting.refresh();
    const backend = backendOf(storage);
    if (this.config.mode === 'flui' && this.config.storageBackend !== backend) {
      throw new ConflictException(
        `The Flui registry already keeps images on ${placeOf(this.config.storageBackend)}. Images are never copied between a volume and a bucket, so this cannot be changed here.`,
      );
    }
    let candidate: FluiRegistryConfig;
    try {
      candidate = this.setting.candidate({
        mode: 'flui',
        storageBackend: backend,
      });
    } catch (error) {
      throw new BadRequestException(describeError(error));
    }
    if (!candidate.host) {
      throw new BadRequestException(
        'Flui cannot tell which address the registry would answer on: this installation has no public API address (PUBLIC_API_URL).',
      );
    }
    if (backend === 's3' && !(await this.storage.status()).connected) {
      throw new BadRequestException(
        'No bucket is connected for the registry. Connect one first with `flui registry storage connect`, or choose the volume.',
      );
    }
    try {
      await this.deployment.reconcile(candidate);
    } catch (error) {
      throw new ServiceUnavailableException(
        `The Flui registry could not be put in place, so nothing was changed: ${describeError(error)}`,
      );
    }
    await this.setting.record(
      { mode: 'flui', storageBackend: backend },
      userId,
    );
    this.logger.log(
      `New builds now push to the Flui registry on ${candidate.host}, kept on ${placeOf(backend)}`,
    );
  }

  /**
   * Sends new builds back to GitHub Container Registry, only while no
   * application runs images from the Flui registry: they could not be pulled
   * once it stops. The registry stops first, so a registry that cannot be
   * stopped leaves builds where they were and says so.
   */
  async disable(userId: string | null): Promise<RegistryModeStatus> {
    await this.exclusively(() => this.switchOff(userId));
    return this.status();
  }

  private async switchOff(userId: string | null): Promise<void> {
    await this.setting.refresh();
    if (this.config.mode !== 'flui') return;
    const using = await this.applications.find({
      where: { imageRegistryHost: Not(IsNull()), deletedAt: IsNull() },
      select: { id: true, name: true },
      order: { name: 'ASC' },
    });
    if (using.length > 0) {
      const names = using.slice(0, IN_USE_SHOWN).map((app) => app.name);
      const more =
        using.length > IN_USE_SHOWN
          ? ` and ${using.length - IN_USE_SHOWN} more`
          : '';
      throw new ConflictException({
        code: 'REGISTRY_IN_USE',
        message: `${using.length} application(s) run images from the Flui registry: ${names.join(', ')}${more}. Builds can go back to GitHub Container Registry only once no application uses it.`,
      });
    }
    try {
      await this.deployment.stop();
    } catch (error) {
      throw new ServiceUnavailableException(
        `The Flui registry could not be stopped, so new builds still push to it: ${describeError(error)}`,
      );
    }
    await this.setting.record(
      { mode: 'ghcr', storageBackend: this.config.storageBackend },
      userId,
    );
    this.logger.log('New builds now push to GitHub Container Registry');
  }

  private exclusively(work: () => Promise<void>): Promise<void> {
    return withAdvisoryLockWaiting(this.dataSource, 'registry-mode', work);
  }
}
