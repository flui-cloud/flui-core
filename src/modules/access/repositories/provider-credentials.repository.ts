import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CloudProvider } from '../../providers/enums/cloud-provider.enum';
import { ProviderCredentialsEntity } from '../entities/credentials.entity';
import { KeyStorageService } from '../services/key-storage.service';

export const SEALED_PROVIDER_CREDENTIAL_FIELDS = [
  'client_id',
  'client_secret',
  'password',
  'access_token',
  'refresh_token',
] as const;

type SealedField = (typeof SEALED_PROVIDER_CREDENTIAL_FIELDS)[number];

export type ProviderCredentialsSummary = Pick<
  ProviderCredentialsEntity,
  'id' | 'provider' | 'purpose' | 'isActive' | 'token_expires_at' | 'createdAt'
>;

export interface SaveProviderCredentialsInput {
  provider: CloudProvider;
  username: string;
  password: string;
  client_id: string;
  client_secret: string;
  accessToken?: string;
  refreshToken?: string;
  expiresIn?: number;
  refreshTokenExp?: number;
}

/**
 * The only reader and writer of provider credential secrets: callers hand it
 * plaintext and get plaintext back, the table only ever sees values sealed
 * with the installation key.
 */
@Injectable()
export class ProviderCredentialsRepository {
  constructor(
    @InjectRepository(ProviderCredentialsEntity)
    private readonly credentialsRepo: Repository<ProviderCredentialsEntity>,
    private readonly keyStorage: KeyStorageService,
  ) {}

  async saveCredentials(
    input: SaveProviderCredentialsInput,
  ): Promise<ProviderCredentialsEntity> {
    const { provider, username, expiresIn, refreshTokenExp } = input;
    const credentials = this.credentialsRepo.create(
      this.seal({
        provider: provider,
        client_id: input.client_id,
        client_secret: input.client_secret,
        username: username,
        password: input.password,
        access_token: input.accessToken,
        refresh_token: input.refreshToken,
        token_expires_at: expiresIn
          ? new Date(Date.now() + expiresIn * 1000)
          : null,
        isActive: true,
        refresh_token_expires_at: refreshTokenExp
          ? new Date(refreshTokenExp * 1000)
          : null,
      }),
    );

    const existing = await this.credentialsRepo.findOne({
      where: { provider, username },
    });

    if (existing) {
      credentials.id = existing.id;
    }
    return this.open(await this.credentialsRepo.save(credentials));
  }

  async findByProvider(
    provider: CloudProvider,
  ): Promise<ProviderCredentialsEntity[]> {
    const rows = await this.credentialsRepo.find({
      where: { provider, isActive: true },
    });
    return rows.map((row) => this.open(row));
  }

  async findById(id: string): Promise<ProviderCredentialsEntity | null> {
    const row = await this.credentialsRepo.findOneBy({ id, isActive: true });
    return row ? this.open(row) : null;
  }

  async updateTokens(
    id: string,
    accessToken: string,
    refreshToken?: string,
    expiresIn?: number,
  ): Promise<ProviderCredentialsEntity> {
    const credentials = await this.credentialsRepo.findOneBy({
      id,
      isActive: true,
    });

    if (!credentials) {
      throw new Error('Credentials not found');
    }

    credentials.access_token = this.keyStorage.encryptKeyToString(accessToken);
    if (refreshToken) {
      credentials.refresh_token =
        this.keyStorage.encryptKeyToString(refreshToken);
    }
    if (expiresIn) {
      credentials.token_expires_at = new Date(Date.now() + expiresIn * 1000);
    }

    return this.open(await this.credentialsRepo.save(credentials));
  }

  async deleteCredentials(id: string): Promise<void> {
    await this.credentialsRepo.update(id, { isActive: false });
  }

  async getActiveCredentials(): Promise<ProviderCredentialsEntity[]> {
    const rows = await this.credentialsRepo.find({
      where: { isActive: true },
    });
    return rows.map((row) => this.open(row));
  }

  async isTokenExpired(id: string): Promise<boolean> {
    const credentials = await this.credentialsRepo.findOneBy({
      id,
      isActive: true,
    });
    if (!credentials?.token_expires_at) {
      return true;
    }

    return credentials.token_expires_at < new Date();
  }

  async findAll(): Promise<ProviderCredentialsSummary[]> {
    return this.credentialsRepo.find({
      select: {
        id: true,
        provider: true,
        purpose: true,
        isActive: true,
        token_expires_at: true,
        createdAt: true,
      },
    });
  }

  async deleteTokenAndCredentials(id: string) {
    await this.credentialsRepo.delete(id);
  }

  private seal<T extends Partial<Record<SealedField, string | null>>>(
    row: T,
  ): T {
    return this.mapSecrets(row, (value) =>
      this.keyStorage.encryptKeyToString(value),
    );
  }

  private open(row: ProviderCredentialsEntity): ProviderCredentialsEntity {
    return this.mapSecrets(row, (value) =>
      this.keyStorage.decryptKeyFromString(value),
    );
  }

  private mapSecrets<T extends Partial<Record<SealedField, string | null>>>(
    row: T,
    transform: (value: string) => string,
  ): T {
    const copy = { ...row };
    for (const field of SEALED_PROVIDER_CREDENTIAL_FIELDS) {
      const value = row[field];
      if (typeof value === 'string' && value !== '') {
        (copy as Record<SealedField, string>)[field] = transform(value);
      }
    }
    return copy;
  }
}
