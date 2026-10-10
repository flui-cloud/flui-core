import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

/**
 * The key registry tokens are signed with, and nothing else is: the registry
 * accepts any token this key signs, whatever its issuer or audience. Only the
 * public half ever leaves the API.
 */
@Entity('registry_signing_keys')
@Unique('UQ_registry_signing_keys_kid', ['kid'])
@Index('IDX_registry_signing_keys_one_active', ['active'], {
  unique: true,
  where: '"active"',
})
export class RegistrySigningKeyEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 64 })
  kid: string;

  @Column({ type: 'varchar', length: 16 })
  algorithm: string;

  @Column({ type: 'text' })
  publicKeyPem: string;

  @Column({ type: 'text' })
  privateKeyEncrypted: string;

  @Column({ type: 'boolean', default: true })
  active: boolean;

  @CreateDateColumn()
  createdAt: Date;
}
