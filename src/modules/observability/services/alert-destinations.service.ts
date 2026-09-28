import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'node:crypto';
import { isEmail } from 'class-validator';
import { In, Repository } from 'typeorm';
import {
  EgressPolicy,
  egressPolicyFromEnv,
} from '../../../common/net/egress-guard';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { ceilingWithholds } from '../../auth/utils/credential-ceiling.util';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import {
  POLICY_ENGINE,
  PolicyEngine,
} from '../../iam/interfaces/policy-engine.interface';
import { principalFromUser } from '../../iam/interfaces/iam.types';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import {
  AlertDestinationEntity,
  AlertDestinationScope,
  AlertSeverityFloor,
} from '../entities/alert-destination.entity';
import { AlertEventEntity } from '../entities/alert-event.entity';
import {
  AlertDestinationDto,
  AlertDestinationTestResultDto,
  CreateAlertDestinationDto,
  CreatedAlertDestinationDto,
  UpdateAlertDestinationDto,
} from '../dto/alert-destination.dto';
import { AlertRoutingService } from './alert-routing.service';
import {
  assertWebhookTarget,
  ResolveAll,
  resolveAll,
} from './alert-routing.util';

export const TEST_ALERT = 'FluiTestAlert';

/**
 * The destinations people add, and the one switch on the built-in
 * administrator email. The signing secret is minted here, stored sealed and
 * handed back exactly once.
 */
@Injectable()
export class AlertDestinationsService {
  protected resolve: ResolveAll = resolveAll;
  protected egress: () => EgressPolicy = egressPolicyFromEnv;

  constructor(
    @InjectRepository(AlertDestinationEntity)
    private readonly destinations: Repository<AlertDestinationEntity>,
    private readonly encryption: EncryptionService,
    private readonly routing: AlertRoutingService,
    @Inject(POLICY_ENGINE) private readonly policy: PolicyEngine,
  ) {}

  async list(): Promise<AlertDestinationDto[]> {
    const rows = await this.destinations.find({
      where: { kind: In(['email', 'webhook']) },
      order: { createdAt: 'ASC' },
    });
    return rows.map(toDto);
  }

  async create(
    input: CreateAlertDestinationDto,
    createdBy: string | null,
    actor?: AuthenticatedUser,
  ): Promise<CreatedAlertDestinationDto> {
    const scope: AlertDestinationScope = input.scope ?? 'infrastructure';
    await this.assertMayHear(scope, actor);
    const target = input.target.trim();
    let secret: string | null = null;

    if (input.kind === 'email') {
      if (!isEmail(target)) {
        throw new BadRequestException(`${target} is not an email address`);
      }
    } else {
      await assertWebhookTarget(target, this.egress(), this.resolve);
      secret = randomBytes(32).toString('hex');
    }

    const saved = await this.destinations.save(
      this.destinations.create({
        kind: input.kind,
        target,
        minSeverity: input.minSeverity ?? 'critical',
        scope,
        secretEncrypted: secret ? this.encryption.encrypt(secret) : null,
        enabled: true,
        createdBy,
      }),
    );
    return { ...toDto(saved), secret };
  }

  async update(
    id: string,
    input: UpdateAlertDestinationDto,
    actor?: AuthenticatedUser,
  ): Promise<AlertDestinationDto> {
    const row = await this.find(id);
    if (input.scope !== undefined) {
      await this.assertMayHear(input.scope, actor);
      row.scope = input.scope;
    }
    if (input.enabled !== undefined) row.enabled = input.enabled;
    if (input.minSeverity !== undefined) row.minSeverity = input.minSeverity;
    return toDto(await this.destinations.save(row));
  }

  /**
   * Every application's alerts carry their names, errors and summaries: sending
   * them somewhere is reading tenants' data, which `cluster:manage` alone does
   * not grant. Asked of the credential's ceiling first, as every other place
   * that checks `data:access` outside the HTTP guards does.
   */
  private async assertMayHear(
    scope: AlertDestinationScope,
    actor: AuthenticatedUser | undefined,
  ): Promise<void> {
    if (scope !== 'all') return;
    const permitted =
      !!actor &&
      !ceilingWithholds(actor, IAM_PERMISSION.DATA_ACCESS) &&
      (await this.policy.check(
        principalFromUser(actor),
        IAM_PERMISSION.DATA_ACCESS,
      ));
    if (!permitted) {
      throw new ForbiddenException(
        `A destination that receives every application's alerts needs the ${IAM_PERMISSION.DATA_ACCESS} permission. Keep it to scope "infrastructure", or ask someone with data access to widen it.`,
      );
    }
  }

  async remove(id: string): Promise<void> {
    await this.destinations.remove(await this.find(id));
  }

  async test(id: string): Promise<AlertDestinationTestResultDto> {
    const row = await this.find(id);
    const now = new Date();
    const event = {
      id: `test-${row.id}`,
      fingerprint: `flui-test-${row.id}`,
      alertname: TEST_ALERT,
      severity: row.minSeverity,
      status: 'firing',
      startsAt: now,
      endsAt: null,
      lastSeenAt: now,
      applicationId: null,
      applicationSlug: null,
      namespace: null,
      nodeInstance: null,
      labels: {},
      annotations: {
        summary: 'Test alert from Flui: this destination receives alerts.',
        description:
          'Sent on request to check this destination. Nothing is wrong.',
      },
    } as unknown as AlertEventEntity;
    const { ok, status, error } = await this.routing.sendTo(
      row,
      'fired',
      event,
    );
    return { ok, status, error };
  }

  async adminWarnings(): Promise<boolean> {
    const row = await this.destinations.findOne({ where: { kind: 'admins' } });
    return Boolean(row?.enabled && row.minSeverity === 'warning');
  }

  async setAdminWarnings(on: boolean, by: string | null): Promise<boolean> {
    try {
      await this.writeAdminFloor(on, by);
    } catch (error) {
      // Two first switches race to create the one row; the loser writes onto
      // the winner's instead.
      if ((error as { code?: string })?.code !== '23505') throw error;
      await this.writeAdminFloor(on, by);
    }
    return on;
  }

  private async writeAdminFloor(on: boolean, by: string | null): Promise<void> {
    const floor: AlertSeverityFloor = on ? 'warning' : 'critical';
    const row =
      (await this.destinations.findOne({ where: { kind: 'admins' } })) ??
      this.destinations.create({ kind: 'admins', target: null, enabled: true });
    row.minSeverity = floor;
    row.enabled = true;
    row.createdBy = by;
    await this.destinations.save(row);
  }

  private async find(id: string): Promise<AlertDestinationEntity> {
    const row = await this.destinations.findOne({ where: { id } });
    if (!row || row.kind === 'admins') {
      throw new NotFoundException('No such alert destination');
    }
    return row;
  }
}

function toDto(row: AlertDestinationEntity): AlertDestinationDto {
  return {
    id: row.id,
    kind: row.kind as 'email' | 'webhook',
    target: row.target ?? '',
    minSeverity: row.minSeverity,
    scope: row.scope ?? 'infrastructure',
    enabled: row.enabled,
    signed: Boolean(row.secretEncrypted),
    createdBy: row.createdBy ?? null,
    createdAt: row.createdAt.toISOString(),
    lastDeliveryAt: row.lastDeliveryAt?.toISOString() ?? null,
    lastStatus: row.lastStatus ?? null,
    lastError: row.lastError ?? null,
  };
}
