import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { KeyStorageService } from '../../access/services/key-storage.service';
import { ConfigurationModeService } from '../../management/services/configuration-mode.service';
import { ValidationResultDto } from '../../management/dto/validation-result.dto';
import { InferenceConnectionRepository } from '../repositories/inference-connection.repository';
import { InferenceClientService } from './inference-client.service';
import { InferenceResolverService } from './inference-resolver.service';
import { CreateInferenceConnectionDto } from '../dto/create-inference-connection.dto';
import { InferenceConnectionDto } from '../dto/inference-connection.dto';
import { InferenceConnectionEntity } from '../entities/inference-connection.entity';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import {
  POLICY_ENGINE,
  PolicyEngine,
} from '../../iam/interfaces/policy-engine.interface';
import { principalFromUser } from '../../iam/interfaces/iam.types';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';

@Injectable()
export class InferenceConnectionService {
  constructor(
    private readonly repository: InferenceConnectionRepository,
    private readonly keyStorage: KeyStorageService,
    private readonly configurationMode: ConfigurationModeService,
    private readonly client: InferenceClientService,
    private readonly resolver: InferenceResolverService,
    @Inject(POLICY_ENGINE) private readonly policy: PolicyEngine,
  ) {}

  /**
   * `ownerUserId === null` writes the installation's row — the level the route
   * behind `integration:manage` reaches. A user id writes a personal one, which
   * anybody authenticated may do for herself and for nobody else.
   *
   * The two levels never disturb each other's default: `clearDefaultFor` is
   * scoped, so a person marking her own connection default does not unseat the
   * installation's for everybody.
   */
  async create(
    dto: CreateInferenceConnectionDto,
    ownerUserId: string | null,
  ): Promise<InferenceConnectionDto> {
    this.assertWritable();
    if (dto.isDefault) {
      await this.repository.clearDefaultFor(ownerUserId);
    }
    const models =
      dto.models ?? (await this.discoverModels(dto.baseUrl, dto.apiKey));
    const entity = await this.repository.create({
      label: dto.label,
      baseUrl: dto.baseUrl,
      encryptedApiKey: this.keyStorage.encryptKeyToString(dto.apiKey),
      models,
      isDefault: dto.isDefault ?? false,
      ownerUserId,
    });
    return InferenceConnectionDto.fromEntity(entity);
  }

  /**
   * The installation's rows plus the caller's own — and everything, for a
   * principal holding `iam:manage-users`.
   *
   * `iam:manage-users` and not `integration:manage`: the author's word was
   * "admin", and in this product that word covers two different rungs.
   * `iam:manage-users` is held by `owner` alone, `integration:manage` also by
   * `maintainer`. Widening this afterwards is one predicate; narrowing it
   * afterwards is a list of colleagues' private endpoints already read.
   */
  async list(user: AuthenticatedUser): Promise<InferenceConnectionDto[]> {
    const entities = (await this.seesEveryone(user))
      ? await this.repository.findAll()
      : await this.repository.findUsableBy(user.userId);
    return entities.map((e) => InferenceConnectionDto.fromEntity(e));
  }

  /**
   * The installation-level removal, behind `integration:manage`.
   *
   * A personal row is not reachable here unless the caller also holds
   * `iam:manage-users` — the visibility rung of decision 104, which is the same
   * rung that may take one away. Refused as absence, so a `maintainer` probing
   * ids learns nothing about who has connected what.
   */
  async remove(id: string, user: AuthenticatedUser): Promise<void> {
    this.assertWritable();
    const connection = await this.mustFind(id);
    const mine = connection.owner_user_id === user.userId;
    const reachable =
      connection.owner_user_id === null ||
      mine ||
      (await this.seesEveryone(user));
    if (!reachable) throw this.absent(id);
    await this.repository.delete(id);
  }

  /**
   * The caller's own, and only ever the caller's own.
   *
   * Its own route because it must not ask for a permission: a principal who may
   * connect her own model and may not disconnect it is the worst state a
   * credential model can be in, which is the reason `DELETE /auth/api-keys/:id`
   * is already declared outside the ceiling. Keeping it separate from the
   * gated route above means the *installation's* connection stays gated —
   * an agent key must still not be able to unplug the model it speaks through.
   */
  async removeOwn(id: string, user: AuthenticatedUser): Promise<void> {
    this.assertWritable();
    const connection = await this.mustFind(id);
    if (connection.owner_user_id !== user.userId) throw this.absent(id);
    await this.repository.delete(id);
  }

  /**
   * Validating spends the key — it calls the provider with it — so it asks the
   * spend question and not the visibility one, through the same neck every
   * other spender goes through.
   */
  async validate(
    id: string,
    user: AuthenticatedUser,
  ): Promise<ValidationResultDto> {
    const endpoint = await this.resolver.resolveConnection(id, {
      userId: user.userId,
    });
    try {
      const models = await this.client.listModelIds(
        endpoint.baseUrl,
        endpoint.apiKey,
      );
      await this.repository.updateModels(id, models);
      return {
        success: true,
        message: `Valid — ${models.length} models reachable`,
        details: { models },
      };
    } catch (error) {
      if (error.response?.status === 401 || error.response?.status === 403) {
        return { success: false, message: 'Invalid API key' };
      }
      return { success: false, message: `Validation failed: ${error.message}` };
    }
  }

  private async seesEveryone(user: AuthenticatedUser): Promise<boolean> {
    return this.policy.check(
      principalFromUser(user),
      IAM_PERMISSION.IAM_MANAGE_USERS,
    );
  }

  private async mustFind(id: string): Promise<InferenceConnectionEntity> {
    const connection = await this.repository.findById(id);
    if (!connection) throw this.absent(id);
    return connection;
  }

  private absent(id: string): NotFoundException {
    return new NotFoundException(`Inference connection ${id} not found`);
  }

  private async discoverModels(
    baseUrl: string,
    apiKey: string,
  ): Promise<string[]> {
    try {
      return await this.client.listModelIds(baseUrl, apiKey);
    } catch {
      return [];
    }
  }

  private assertWritable(): void {
    if (this.configurationMode.isHostedMode()) {
      throw new ForbiddenException(
        'Inference connections are managed by Flui in hosted mode',
      );
    }
  }
}
