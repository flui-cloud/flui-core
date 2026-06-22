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
}
