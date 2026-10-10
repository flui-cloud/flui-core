import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  KeyObject,
} from 'node:crypto';
import { Repository } from 'typeorm';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { RegistrySigningKeyEntity } from '../entities/registry-signing-key.entity';
import { signEs256Jwt } from '../registry-jwt';

interface ActiveKey {
  kid: string;
  privateKey: KeyObject;
  publicKeyPem: string;
}

@Injectable()
export class RegistrySigningKeyService {
  private cached: ActiveKey | null = null;

  constructor(
    @InjectRepository(RegistrySigningKeyEntity)
    private readonly keys: Repository<RegistrySigningKeyEntity>,
    private readonly encryption: EncryptionService,
  ) {}

  async sign(claims: Record<string, unknown>): Promise<string> {
    const key = await this.active();
    return signEs256Jwt(key.kid, claims, key.privateKey);
  }

  /** What the registry is configured to trust. */
  async publicKeyPem(): Promise<string> {
    return (await this.active()).publicKeyPem;
  }

  private async active(): Promise<ActiveKey> {
    if (this.cached) return this.cached;
    const row =
      (await this.keys.findOne({ where: { active: true } })) ??
      (await this.create());
    this.cached = {
      kid: row.kid,
      privateKey: createPrivateKey(
        this.encryption.decrypt(row.privateKeyEncrypted),
      ),
      publicKeyPem: row.publicKeyPem,
    };
    return this.cached;
  }

  private async create(): Promise<RegistrySigningKeyEntity> {
    const { privateKey, publicKey } = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
    });
    const kid = createHash('sha256')
      .update(publicKey.export({ type: 'spki', format: 'der' }))
      .digest('base64url')
      .slice(0, 32);
    try {
      return await this.keys.save(
        this.keys.create({
          kid,
          algorithm: 'ES256',
          publicKeyPem: publicKey
            .export({ type: 'spki', format: 'pem' })
            .toString(),
          privateKeyEncrypted: this.encryption.encrypt(
            privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
          ),
          active: true,
        }),
      );
    } catch (error) {
      // Another replica created the key first; the partial unique index on
      // `active` refused this one, and theirs is the key.
      const winner = await this.keys.findOne({ where: { active: true } });
      if (winner) return winner;
      throw error;
    }
  }
}
