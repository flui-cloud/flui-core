import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import {
  IamPrincipalType,
  IamScopeType,
  IamSelector,
} from '../interfaces/iam.types';

@Entity('iam_role_bindings')
export class IamRoleBindingEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'varchar' })
  principalType: IamPrincipalType;

  @Index()
  @Column({ type: 'varchar' })
  principalRef: string;

  @Column({ type: 'varchar' })
  role: string;

  @Column({ type: 'varchar' })
  scopeType: IamScopeType;

  @Column({ type: 'varchar', nullable: true })
  scopeRef: string | null;

  @Column({ type: 'jsonb', nullable: true })
  selector: IamSelector | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  /**
   * When this grant stops counting. Null is a standing grant. An expired row is
   * kept: it is the record of who was let in and until when.
   */
  @Column({ type: 'timestamptz', nullable: true })
  expiresAt: Date | null;

  /** Who created the grant, as their email. Null for grants older than the column. */
  @Column({ type: 'varchar', nullable: true })
  grantedBy: string | null;

  /** When the day-before notice went out, so it goes out once. */
  @Column({ type: 'timestamptz', nullable: true })
  expiringNoticeAt: Date | null;

  /** When the has-ended notice went out, so it goes out once. */
  @Column({ type: 'timestamptz', nullable: true })
  expiredNoticeAt: Date | null;
}
