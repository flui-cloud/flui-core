import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { createHash, randomBytes } from 'node:crypto';
import { KeyStorageService } from '../../access/services/key-storage.service';
import {
  MailConnectionConfig,
  MailConnectionEntity,
  MailConnectionProvider,
  MailConnectionScope,
} from '../entities/mail-connection.entity';

export interface CreateMailConnection {
  provider: MailConnectionProvider;
  scope: MailConnectionScope;
  label?: string;
  sendingDomain?: string;
  /** The API key or relay password. Never required for Scaleway. */
  secret?: string;
  config?: MailConnectionConfig;
  /**
   * Take over the scope immediately.
   *
   * Left unset, a connection only starts sending when the scope has nobody in
   * it. Configuring a second provider is a normal thing to do — to compare
   * them, to have a replacement ready — and it must not silently move the
   * password resets onto an account whose domain has not finished verifying.
   */
  activate?: boolean;
}

/**
 * Storage and the rules that go with it for mail connections.
 *
 * Nothing here talks to a provider — that is the resolver's and the onboarding
 * service's job. This owns two things a caller must not be trusted with: the
 * secrets, and the separation between bulk and transactional.
 */
@Injectable()
export class MailConnectionService {
  private readonly logger = new Logger(MailConnectionService.name);

  constructor(
    @InjectRepository(MailConnectionEntity)
    private readonly repo: Repository<MailConnectionEntity>,
    private readonly keys: KeyStorageService,
  ) {}

  list(): Promise<MailConnectionEntity[]> {
    return this.repo.find({ order: { scope: 'ASC', createdAt: 'DESC' } });
  }

  active(scope: MailConnectionScope): Promise<MailConnectionEntity | null> {
    return this.repo.findOne({ where: { scope, isActive: true } });
  }

  activeAll(): Promise<MailConnectionEntity[]> {
    return this.repo.find({ where: { isActive: true } });
  }

  async byId(id: string): Promise<MailConnectionEntity> {
    const found = await this.repo.findOne({ where: { id } });
    if (!found) throw new NotFoundException(`No mail connection ${id}`);
    return found;
  }

  /** Everything stored for a scope, whichever one is currently sending. */
  inScope(scope: MailConnectionScope): Promise<MailConnectionEntity[]> {
    return this.repo.find({ where: { scope }, order: { createdAt: 'DESC' } });
  }

  /**
   * Store a connection, and let it send only if nothing else is.
   *
   * Several providers per scope may be configured; **one at a time carries the
   * mail.** Storing and sending are separate on purpose — a second provider is
   * normally added to be checked out, or kept ready — and a store that also
   * switched would move live password resets onto a domain that may still be
   * minutes away from verifying. Pass `activate` to mean it.
   *
   * Re-connecting the provider already in the slot keeps the slot: that is a
   * key rotation or a domain change, not a change of sender.
   */
  async upsert(input: CreateMailConnection): Promise<MailConnectionEntity> {
    const inline = input.provider !== 'scaleway-tem';
    if (inline && !input.secret?.trim()) {
      throw new BadRequestException(`${input.provider} needs a credential.`);
    }
    if (input.provider === 'zeptomail' && !input.config?.region?.trim()) {
      // The regional host IS the data residency. Defaulting it would route an
      // EU account through another region on an omitted field.
      throw new BadRequestException(
        'ZeptoMail needs its regional API host, which is also where the account data lives.',
      );
    }

    const secret = input.secret?.trim();
    const fingerprint = secret ? sha256(secret) : null;
    await this.assertSeparation(input, fingerprint);

    const existing = await this.repo.findOne({
      where: { provider: input.provider, scope: input.scope },
    });

    const holder = await this.active(input.scope);
    const activate =
      input.activate === true || !holder || holder.id === existing?.id;

    const row = this.repo.create({
      ...existing,
      provider: input.provider,
      scope: input.scope,
      label: input.label?.trim() || defaultLabel(input.provider, input.scope),
      sendingDomain:
        input.sendingDomain?.trim().toLowerCase() ??
        existing?.sendingDomain ??
        null,
      credentialSource: inline ? 'inline' : 'scaleway-compute',
      encryptedSecret: secret
        ? this.keys.encryptKeyToString(secret)
        : (existing?.encryptedSecret ?? null),
      secretFingerprint: fingerprint ?? existing?.secretFingerprint ?? null,
      config: { ...existing?.config, ...input.config },
      isActive: activate,
    });

    await this.repo.manager.transaction(async (manager) => {
      if (activate) await deactivateOthers(manager, input.scope, existing?.id);
      await manager.getRepository(MailConnectionEntity).save(row);
    });

    this.logger.log(
      activate
        ? `[mail] ${input.provider} is now the ${input.scope} sender`
        : `[mail] stored ${input.provider} for ${input.scope}, not sending`,
    );
    return this.byId(row.id);
  }

  /**
   * Hand the scope to a connection already stored.
   *
   * The separation is re-checked rather than trusted from when the row was
   * written: the other scope may have changed in between, and this is the
   * moment the arrangement becomes real.
   */
  async activate(id: string): Promise<MailConnectionEntity> {
    const connection = await this.byId(id);
    await this.assertSeparation(
      {
        provider: connection.provider,
        scope: connection.scope,
        ...(connection.sendingDomain
          ? { sendingDomain: connection.sendingDomain }
          : {}),
      },
      connection.secretFingerprint,
    );

    await this.repo.manager.transaction(async (manager) => {
      await deactivateOthers(manager, connection.scope, connection.id);
      await manager
        .getRepository(MailConnectionEntity)
        .update(connection.id, { isActive: true });
    });

    this.logger.log(
      `[mail] ${connection.provider} is now the ${connection.scope} sender`,
    );
    return this.byId(id);
  }

  /**
   * The three-legged invariant, checked where the schema cannot reach.
   *
   * A partial unique index already stops a second *active* connection in the
   * same scope. What it cannot see is whether the other scope is the same
   * account: one leg is inside a ciphertext and the other is a domain string.
   *
   * Every row of the other scope is compared, not only the one sending. A
   * stored connection exists to be switched to, so a collision accepted now is
   * a collision that surfaces at the click that makes it live — which is the
   * worst possible moment to discover it.
   */
  private async assertSeparation(
    input: Pick<CreateMailConnection, 'provider' | 'scope' | 'sendingDomain'>,
    fingerprint: string | null,
  ): Promise<void> {
    const otherScope = input.scope === 'bulk' ? 'transactional' : 'bulk';
    const others = await this.inScope(otherScope);
    const domain = input.sendingDomain?.trim().toLowerCase();

    for (const other of others) {
      if (fingerprint && other.secretFingerprint === fingerprint) {
        throw new BadRequestException(
          `That credential is already configured for ${otherScope} mail. Bulk and transactional ` +
            'mail must not share an account: a suspension caused by a mailing list would stop ' +
            'password resets too.',
        );
      }
      if (domain && other.sendingDomain === domain) {
        throw new BadRequestException(
          `${domain} is already the sending domain for ${otherScope} mail. Use a separate ` +
            'domain — reputation is tracked per domain, so sharing one lets a mailing list ' +
            'damage the deliverability of transactional mail.',
        );
      }
    }
  }

  /** The plaintext credential, decrypted on demand and never logged. */
  secretOf(connection: MailConnectionEntity): string | null {
    return connection.encryptedSecret
      ? this.keys.decryptKeyFromString(connection.encryptedSecret)
      : null;
  }

  webhookSecretOf(connection: MailConnectionEntity): string | null {
    return connection.encryptedWebhookSecret
      ? this.keys.decryptKeyFromString(connection.encryptedWebhookSecret)
      : null;
  }

  /**
   * Mint the shared secret a provider sends back on every webhook call, once.
   *
   * Stable across re-registrations on purpose: rotating it would leave the
   * provider holding the old one and every event it posts rejected, which looks
   * exactly like a provider that has gone quiet.
   */
  async ensureWebhookSecret(connection: MailConnectionEntity): Promise<string> {
    const held = this.webhookSecretOf(connection);
    if (held) return held;

    const minted = randomBytes(32).toString('hex');
    await this.repo.update(connection.id, {
      encryptedWebhookSecret: this.keys.encryptKeyToString(minted),
    });
    return minted;
  }

  /** An explicit `undefined` clears the key rather than storing it as null. */
  async setConfig(
    id: string,
    patch: Partial<MailConnectionConfig>,
  ): Promise<void> {
    const connection = await this.byId(id);
    const config = { ...connection.config, ...patch } as Record<
      string,
      unknown
    >;
    for (const [key, value] of Object.entries(config)) {
      if (value === undefined) delete config[key];
    }
    await this.repo.update(id, { config: config as MailConnectionConfig });
  }

  async setSendingDomain(id: string, domain: string): Promise<void> {
    await this.repo.update(id, { sendingDomain: domain.trim().toLowerCase() });
  }

  /**
   * Retire a connection.
   *
   * A hard delete, matching how the inference connections behave: stored events
   * carry their own provider string, so history survives. The credential goes
   * with it, which is why the caller should poll one last time first for a
   * provider whose outcomes arrive by polling.
   */
  async remove(id: string): Promise<void> {
    await this.byId(id);
    await this.repo.delete(id);
  }
}

/**
 * Clear the scope, keeping `keep` if it is already in it.
 *
 * Inside the caller's transaction rather than beside it: for a moment between
 * clearing and setting there is no sender for the scope, and a send that landed
 * in that gap would be refused for a configuration that is not changing.
 */
async function deactivateOthers(
  manager: EntityManager,
  scope: MailConnectionScope,
  keep: string | undefined,
): Promise<void> {
  const query = manager
    .getRepository(MailConnectionEntity)
    .createQueryBuilder()
    .update()
    .set({ isActive: false })
    .where('scope = :scope AND isActive = true', { scope });
  if (keep) query.andWhere('id != :id', { id: keep });
  await query.execute();
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function defaultLabel(
  provider: MailConnectionProvider,
  scope: MailConnectionScope,
): string {
  const names: Record<MailConnectionProvider, string> = {
    'scaleway-tem': 'Scaleway Transactional Email',
    brevo: 'Brevo',
    zeptomail: 'ZeptoMail',
    smtp: 'SMTP relay',
  };
  return `${names[provider]} (${scope})`;
}
