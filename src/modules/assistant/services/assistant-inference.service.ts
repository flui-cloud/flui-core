import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  POLICY_ENGINE,
  PolicyEngine,
} from '../../iam/interfaces/policy-engine.interface';
import { principalFromUser } from '../../iam/interfaces/iam.types';
import { UserEntity } from '../../auth/entities/user.entity';
import { InferenceUsageService } from '../../inference/services/inference-usage.service';
import { CloudProvider } from '../../providers/enums/cloud-provider.enum';
import {
  InferencePrincipal,
  InferenceResolverService,
} from '../../inference/services/inference-resolver.service';
import { InferenceClientService } from '../../inference/services/inference-client.service';
import { InferenceEndpoint } from '../../providers/interfaces/inference-capability';
import { pickChatModel } from '../assistant.constants';

export interface InferenceSelection {
  model?: string;
  provider?: CloudProvider;
  connectionId?: string;
}

/** Resolves a request's inference endpoint + model from the same rules for chat and agent. */
@Injectable()
export class AssistantInferenceService {
  constructor(
    private readonly resolver: InferenceResolverService,
    private readonly client: InferenceClientService,
    private readonly config: ConfigService,
    @Inject(POLICY_ENGINE) private readonly policy: PolicyEngine,
    @InjectRepository(UserEntity)
    private readonly users: Repository<UserEntity>,
    private readonly usage: InferenceUsageService,
  ) {}

  /**
   * How many tokens one guest's area may spend before the door closes.
   *
   * A number of *tokens* rather than of questions, because a question is not a
   * unit of anything: the same sentence costs ten times more once the model is
   * reading logs back. The screen turns it into a ring, which is the one form
   * a visitor can read without being taught what a token is.
   */
  private guestBudget(): number {
    const raw = Number(
      this.config.get<string>('SANDBOX_INFERENCE_TOKEN_BUDGET'),
    );
    return Number.isFinite(raw) && raw > 0 ? raw : 200_000;
  }

  /**
   * Where a guest's inference is decided for them, and the reason it is decided
   * here rather than on the chat route.
   *
   * Seven surfaces spend inference — the assistant and the six console
   * copilots — and every one of them passes through this service. A check on
   * the chat controller would leave the SQL console open, which is the surface
   * where a model writes queries against real data.
   *
   * Three things the caller may normally choose are taken away, because on a
   * demo the instance is paying: the model, the provider and the connection.
   * The last one matters most and is the least obvious — a connection with no
   * owner is the installation's and `canSpend` lets *anyone* spend it, which is
   * right for a colleague and wrong for a visitor who arrived a minute ago.
   *
   * `isSandbox` comes from the grants the platform wrote, never from the
   * request: the same rule the comment below states for the principal.
   * Hiding the model picker in the interface is a courtesy; this is the refusal.
   */
  private async pinnedForGuest(
    principal: InferencePrincipal,
  ): Promise<{ endpoint: InferenceEndpoint; source: string } | null> {
    // The row, not the request: a binding can be addressed to an email as well
    // as to an id — the sandbox's own grants are — so asking IAM with half a
    // principal would answer "not a guest" for every guest.
    if (!principal.userId) return null;
    const user = await this.users.findOne({
      where: { id: principal.userId },
      select: { id: true, email: true, role: true, isAdmin: true },
    });
    if (!user) return null;

    const { isSandbox } = await this.policy.resolveAccess(
      principalFromUser({
        userId: user.id,
        email: user.email,
        role: user.role,
        isAdmin: user.isAdmin,
      } as never),
    );
    if (!isSandbox) return null;

    const endpoint = await this.guestEndpoint(principal);
    const pinnedModel =
      this.config.get<string>('SANDBOX_ASSISTANT_MODEL') ??
      endpoint.defaultModel;
    return {
      endpoint: { ...endpoint, pinnedModel },
      source: pinnedModel ? `guest:${pinnedModel}` : 'guest',
    };
  }

  /**
   * The door, and the reason the principal is a second argument rather than a
   * field of the selection: `sel` is the request body itself on the assistant
   * routes, so anything read off it is something the caller wrote. Who is
   * asking has to arrive from the credential, never from the payload.
   */
  async resolveEndpoint(
    sel: InferenceSelection,
    principal: InferencePrincipal,
    surface = 'assistant',
  ): Promise<{ endpoint: InferenceEndpoint; source: string }> {
    const guest = await this.pinnedForGuest(principal);
    if (guest) {
      // Before the call, not after: a budget checked afterwards is a budget
      // that is always overspent by exactly one turn, and the turn that
      // overspends it is the one reading a long log back.
      await this.assertGuestHasBudget(principal.userId);
      return {
        ...guest,
        endpoint: {
          ...guest.endpoint,
          spender: { userId: principal.userId, guest: true, surface },
        },
      };
    }

    const spender = {
      userId: principal.userId || null,
      guest: false,
      surface,
    };
    if (sel.connectionId) {
      return {
        endpoint: {
          ...(await this.resolver.resolveConnection(
            sel.connectionId,
            principal,
          )),
          spender,
        },
        source: `connection:${sel.connectionId}`,
      };
    }
    if (sel.provider) {
      return {
        endpoint: {
          ...(await this.resolver.resolveNative(sel.provider)),
          spender,
        },
        source: `provider:${sel.provider}`,
      };
    }
    return {
      endpoint: { ...(await this.resolver.resolveDefault(principal)), spender },
      source: 'default',
    };
  }

  /**
   * Where a guest's inference actually comes from, said out loud.
   *
   * Not `resolveDefault`: that walks the inference-capable providers first and
   * takes the first one holding a credential, so on an installation that has a
   * Scaleway compute key — which is most of them — a connection marked
   * *default* would never be reached. An operator who attaches an account for
   * their visitors and sees Scaleway in the usage report would have no way to
   * tell why.
   *
   * So the instance names it: a connection id, or a native provider. Naming
   * neither keeps the old behaviour, which is the right default for an
   * installation that never thought about it.
   */
  private async guestEndpoint(
    principal: InferencePrincipal,
  ): Promise<InferenceEndpoint> {
    const connectionId = this.config.get<string>(
      'SANDBOX_INFERENCE_CONNECTION_ID',
    );
    if (connectionId) {
      try {
        return await this.resolver.resolveConnection(connectionId, principal);
      } catch {
        // The resolver answers "not found" both for a connection that is not
        // there and for one this principal may not spend — and a guest may
        // spend only the installation's. Naming a personal connection for
        // visitors would otherwise show every one of them a bare 404 while the
        // row sits in the operator's own list, looking fine.
        throw new ServiceUnavailableException(
          `SANDBOX_INFERENCE_CONNECTION_ID names a connection this installation cannot let a guest spend (${connectionId}). Guests can only spend a connection that belongs to the installation rather than to a person.`,
        );
      }
    }
    const provider = this.config.get<string>('SANDBOX_INFERENCE_PROVIDER');
    if (provider) {
      return this.resolver.resolveNative(provider as CloudProvider);
    }
    return this.resolver.resolveDefault(principal);
  }

  /**
   * Refuses rather than degrades. A demo that silently switches to a worse
   * model when the money runs out teaches the visitor something false about
   * the product; one that says "this area has used its share" teaches them
   * something true about how it is run.
   */
  private async assertGuestHasBudget(userId: string): Promise<void> {
    const budget = this.guestBudget();
    const spent = await this.usage.tokensFor(userId);
    if (spent < budget) return;
    throw new HttpException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        code: 'SANDBOX_INFERENCE_BUDGET_SPENT',
        message:
          'This sandbox has used the share of assistant time it comes with. Everything else in it keeps working, and your own coding agent can carry on over MCP — that one runs on your account, not this instance.',
        spent,
        budget,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  /** Whether this person is a guest at all — the screen asks before drawing a ring. */
  async isGuest(userId: string): Promise<boolean> {
    return !!(await this.pinnedForGuest({ userId }));
  }

  /** What one area has spent, and what it was given. For the ring on screen. */
  async guestUsage(userId: string): Promise<{ spent: number; budget: number }> {
    return {
      spent: await this.usage.tokensFor(userId),
      budget: this.guestBudget(),
    };
  }

  async resolveModel(
    sel: InferenceSelection,
    endpoint: InferenceEndpoint,
  ): Promise<string> {
    // Before the caller's own choice, and that order is the point.
    if (endpoint.pinnedModel) return endpoint.pinnedModel;
    if (sel.model) return sel.model;
    // Model ids are provider-specific, so prefer the source's own default.
    if (endpoint.defaultModel) return endpoint.defaultModel;
    const override = this.config.get<string>('ASSISTANT_DEFAULT_MODEL');
    if (override) return override;
    const models = await this.client.listModelIds(
      endpoint.baseUrl,
      endpoint.apiKey,
    );
    const chat = pickChatModel(models);
    if (!chat) {
      throw new ServiceUnavailableException(
        'No chat model available on the inference endpoint',
      );
    }
    return chat;
  }
}
