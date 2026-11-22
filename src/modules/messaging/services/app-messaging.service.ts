import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { ApplicationsRepository } from '../../applications/repositories/applications.repository';
import { ApplicationAccessService } from '../../applications/services/application-access.service';
import { ApplicationDeployService } from '../../applications/services/application-deploy.service';
import { AppAutoscalingService } from '../../applications/services/app-autoscaling.service';
import { ApplicationQueueScaling } from '../../applications/interfaces/source-config.interface';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { NatsAccountEntity } from '../entities/nats-account.entity';
import { NATS_IN_CLUSTER_URL } from '../nats/cluster-nats.manifest';
import {
  accountJwt,
  keyFromSeed,
  natsCreds,
  newAccountKey,
  newUserKey,
  seedOf,
  userJwt,
} from '../nats/nats-jwt';
import { ClusterNatsService } from './cluster-nats.service';

export const NATS_URL_VAR = 'NATS_URL';
export const NATS_CREDS_VAR = 'NATS_CREDS';

export interface AppMessaging {
  applicationId: string;
  connected: boolean;
  url: string | null;
  account: string | null;
  queueScaling: Omit<ApplicationQueueScaling, 'account'> | null;
}

export type QueueScalingRequest = Omit<ApplicationQueueScaling, 'account'>;

/**
 * Gives an application its own account on the NATS its cluster shares: its
 * subjects and streams are invisible to every other application there. The
 * application receives the address and a credentials file, nothing else.
 */
@Injectable()
export class AppMessagingService {
  constructor(
    @InjectRepository(NatsAccountEntity)
    private readonly accounts: Repository<NatsAccountEntity>,
    private readonly applications: ApplicationsRepository,
    private readonly access: ApplicationAccessService,
    private readonly deploy: ApplicationDeployService,
    private readonly encryption: EncryptionService,
    private readonly clusterNats: ClusterNatsService,
    private readonly autoscaling: AppAutoscalingService,
  ) {}

  async get(
    user: AuthenticatedUser,
    applicationId: string,
  ): Promise<AppMessaging> {
    const app = await this.application(applicationId);
    await this.access.assertCan(user, 'app:read', app);
    const account = await this.accounts.findOne({ where: { applicationId } });
    const queue = app.scaling?.enabled ? app.scaling.queue : undefined;
    return {
      applicationId,
      connected: !!account,
      url: account ? NATS_IN_CLUSTER_URL : null,
      account: account?.publicKey ?? null,
      queueScaling: queue
        ? {
            stream: queue.stream,
            consumer: queue.consumer,
            lagThreshold: queue.lagThreshold,
            min: queue.min,
            max: queue.max,
          }
        : null,
    };
  }

  /** Scale the application on its consumer's backlog, down to `min` (zero included). */
  async scaleOnQueue(
    user: AuthenticatedUser,
    applicationId: string,
    request: QueueScalingRequest,
  ): Promise<AppMessaging> {
    const app = await this.application(applicationId);
    await this.access.assertCan(user, 'app:write', app);
    const account = await this.accounts.findOne({ where: { applicationId } });
    if (!account) {
      throw new ConflictException(
        'Give the application its NATS account first: the queue it scales on lives there.',
      );
    }
    if (request.min > request.max) {
      throw new ConflictException('The floor cannot be above the ceiling.');
    }
    await this.clusterNats.ensureKeda(app.clusterId);
    const scaling = {
      ...app.scaling,
      enabled: true,
      queue: { ...request, account: account.publicKey },
    };
    const updated = await this.applications.update(app.id, { scaling });
    await this.autoscaling.reconcile(updated);
    return this.get(user, applicationId);
  }

  async stopQueueScaling(
    user: AuthenticatedUser,
    applicationId: string,
  ): Promise<AppMessaging> {
    const app = await this.application(applicationId);
    await this.access.assertCan(user, 'app:write', app);
    if (app.scaling?.queue) {
      const { queue: _queue, ...rest } = app.scaling;
      const updated = await this.applications.update(app.id, {
        scaling: { ...rest, enabled: false },
      });
      await this.autoscaling.reconcile(updated);
    }
    return this.get(user, applicationId);
  }

  async connect(
    user: AuthenticatedUser,
    applicationId: string,
  ): Promise<AppMessaging> {
    const app = await this.application(applicationId);
    await this.access.assertCan(user, 'app:write', app);
    if (await this.accounts.findOne({ where: { applicationId } })) {
      return this.get(user, applicationId);
    }
    const operatorRow = await this.clusterNats.operatorFor(app.clusterId);
    await this.clusterNats.deploy(app.clusterId);

    const operator = keyFromSeed(
      this.encryption.decrypt(operatorRow.operatorSeed),
    );
    const account = newAccountKey();
    const member = newUserKey();
    await this.accounts.insert(
      this.accounts.create({
        publicKey: account.getPublicKey(),
        clusterId: app.clusterId,
        applicationId,
        name: app.slug,
        seed: this.encryption.encrypt(seedOf(account)),
        jwt: accountJwt(operator, account.getPublicKey(), app.slug),
      }),
    );
    const creds = natsCreds(
      userJwt(account, member.getPublicKey(), app.slug),
      member,
    );
    await this.writeEnv(
      app,
      [
        { name: NATS_URL_VAR, value: NATS_IN_CLUSTER_URL, source: 'link' },
        {
          name: NATS_CREDS_VAR,
          value: this.encryption.encrypt(creds),
          secret: true,
          source: 'link',
        },
      ],
      user.userId,
    );
    return this.get(user, applicationId);
  }

  async disconnect(
    user: AuthenticatedUser,
    applicationId: string,
  ): Promise<void> {
    const app = await this.application(applicationId);
    await this.access.assertCan(user, 'app:write', app);
    const account = await this.accounts.findOne({ where: { applicationId } });
    if (!account) return;
    await this.writeEnv(app, [], user.userId);
    await this.accounts.delete({ publicKey: account.publicKey });
  }

  private async writeEnv(
    app: ApplicationEntity,
    entries: ApplicationEntity['env'],
    userId: string,
  ): Promise<void> {
    const owned = new Set([NATS_URL_VAR, NATS_CREDS_VAR]);
    const env = [
      ...(app.env ?? []).filter((e) => !owned.has(e.name)),
      ...entries,
    ];
    await this.applications.update(app.id, { env });
    if (app.imageRef) {
      await this.deploy.deploy(app.id, { useCurrentImage: true }, userId);
    }
  }

  private async application(id: string): Promise<ApplicationEntity> {
    const app = await this.applications.findById(id);
    if (!app) throw new NotFoundException(`Application ${id} not found`);
    return app;
  }
}
