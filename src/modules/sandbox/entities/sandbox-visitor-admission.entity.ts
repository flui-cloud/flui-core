import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';

/** A single-use ticket into the visitors' entrance, kept only as its hash. */
@Entity('sandbox_visitor_admissions')
export class SandboxVisitorAdmissionEntity {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  nonceHash: string;

  @Column({ type: 'varchar', length: 128 })
  ipHash: string;

  @Column({ type: 'boolean', default: false })
  cli: boolean;

  @Index('IDX_sandbox_visitor_admissions_expires')
  @Column({ type: 'timestamptz' })
  expiresAt: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
