import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { IsNull, Repository } from 'typeorm';
import { validate as isUuid } from 'uuid';
import {
  RegistryCredentialEntity,
  RegistryCredentialKind,
} from '../entities/registry-credential.entity';

const hash = (secret: string): string =>
  createHash('sha256').update(secret).digest('hex');

@Injectable()
export class RegistryCredentialsService {
  constructor(
    @InjectRepository(RegistryCredentialEntity)
    private readonly credentials: Repository<RegistryCredentialEntity>,
  ) {}

  /**
   * A fresh credential of this kind for the application, replacing the one it
   * had: the secret is returned once and never stored.
   */
  async issue(
    applicationId: string,
    kind: RegistryCredentialKind,
  ): Promise<{ username: string; password: string }> {
    const password = randomBytes(32).toString('base64url');
    await this.credentials.update(
      { applicationId, kind, revokedAt: IsNull() },
      { revokedAt: new Date() },
    );
    const row = await this.credentials.save(
      this.credentials.create({
        applicationId,
        kind,
        secretHash: hash(password),
        revokedAt: null,
      }),
    );
    return { username: row.id, password };
  }

  async verify(
    username: string | undefined,
    password: string | undefined,
  ): Promise<RegistryCredentialEntity | null> {
    if (!username || !password || !isUuid(username)) return null;
    const row = await this.credentials.findOne({
      where: { id: username, revokedAt: IsNull() },
    });
    if (!row) return null;
    const given = Buffer.from(hash(password));
    const expected = Buffer.from(row.secretHash);
    return given.length === expected.length && timingSafeEqual(given, expected)
      ? row
      : null;
  }

  async revokeForApplication(applicationId: string): Promise<void> {
    await this.credentials.update(
      { applicationId, revokedAt: IsNull() },
      { revokedAt: new Date() },
    );
  }
}
