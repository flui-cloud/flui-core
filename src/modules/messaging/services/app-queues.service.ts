import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { JetStreamManager } from 'nats';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { ApplicationsRepository } from '../../applications/repositories/applications.repository';
import { ApplicationAccessService } from '../../applications/services/application-access.service';
import { NatsAccountEntity } from '../entities/nats-account.entity';
import { NatsConnectionService } from './nats-connection.service';
import {
  QueueSpec,
  QueueView,
  createQueue,
  deleteQueue,
  listQueues,
} from '../nats/queue-ops';

/**
 * The queues of an application, managed inside its own NATS account by a
 * short-lived user Flui signs for the occasion and never stores.
 */
@Injectable()
export class AppQueuesService {
  constructor(
    @InjectRepository(NatsAccountEntity)
    private readonly accounts: Repository<NatsAccountEntity>,
    private readonly applications: ApplicationsRepository,
    private readonly access: ApplicationAccessService,
    private readonly nats: NatsConnectionService,
  ) {}

  list(user: AuthenticatedUser, applicationId: string): Promise<QueueView[]> {
    return this.withQueues(user, applicationId, 'app:read', (jsm) =>
      listQueues(jsm),
    );
  }

  create(
    user: AuthenticatedUser,
    applicationId: string,
    spec: QueueSpec,
  ): Promise<QueueView[]> {
    return this.withQueues(user, applicationId, 'app:write', async (jsm) => {
      await createQueue(jsm, spec);
      return listQueues(jsm);
    });
  }

  remove(
    user: AuthenticatedUser,
    applicationId: string,
    name: string,
  ): Promise<QueueView[]> {
    return this.withQueues(user, applicationId, 'app:write', async (jsm) => {
      await deleteQueue(jsm, name);
      return listQueues(jsm);
    });
  }

  private async withQueues<T>(
    user: AuthenticatedUser,
    applicationId: string,
    action: 'app:read' | 'app:write',
    work: (jsm: JetStreamManager) => Promise<T>,
  ): Promise<T> {
    const app = await this.application(applicationId);
    await this.access.assertCan(user, action, app);
    const account = await this.accounts.findOne({ where: { applicationId } });
    if (!account) {
      throw new ConflictException('This application has no NATS account yet.');
    }
    return this.nats.withConnection(
      app.clusterId,
      account.seed,
      `flui-${app.slug}`,
      async (nc) => work(await nc.jetstreamManager()),
    );
  }

  private async application(id: string): Promise<ApplicationEntity> {
    const app = await this.applications.findById(id);
    if (!app) throw new NotFoundException(`Application ${id} not found`);
    return app;
  }
}
