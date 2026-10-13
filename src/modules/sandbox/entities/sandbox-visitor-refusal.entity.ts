import { Column, Entity, PrimaryColumn } from 'typeorm';

/** Visitors turned away, counted per hour and reason: a bounded record, however hard the door is pushed. */
@Entity('sandbox_visitor_refusals')
export class SandboxVisitorRefusalEntity {
  @PrimaryColumn({
    type: 'timestamptz',
    primaryKeyConstraintName: 'PK_sandbox_visitor_refusals',
  })
  hour: Date;

  @PrimaryColumn({
    type: 'varchar',
    length: 24,
    primaryKeyConstraintName: 'PK_sandbox_visitor_refusals',
  })
  reason: string;

  @Column({ type: 'integer', default: 0 })
  count: number;
}
