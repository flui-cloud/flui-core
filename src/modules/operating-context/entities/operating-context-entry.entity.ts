import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { IamSelector } from '../../iam/interfaces/iam.types';
import {
  CheckKind,
  ContextScopeType,
  EntryNature,
  ProbeStatus,
} from '../operating-context.core';

/**
 * One thing a person decided about how this installation is run, and where it
 * applies.
 *
 * What is deliberately **not** here: any fact the platform can already answer.
 * How many nodes a cluster has, which image an application runs, who deployed
 * it last — those are state and history, and this table would only ever hold a
 * stale copy of them. An entry that wants to remember a number is an entry that
 * was written at the wrong layer; the check columns below exist precisely so
 * that a rule can *lean on* such a number without storing it.
 *
 * The scope columns are the grant vocabulary verbatim (`iam_role_bindings` has
 * the same three), so "who may read this entry" is answered by the machine that
 * already answers "who may read this resource" — no second reachability model,
 * and none of the drift that would follow from one.
 */
@Entity('operating_context_entries')
@Index(['scopeType', 'archivedAt'])
export class OperatingContextEntryEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** `global` | `cluster` | `selector` — a grant's words minus `section`. */
  @Column({ type: 'varchar' })
  scopeType: ContextScopeType;

  /** The cluster id, for `cluster` scope. */
  @Column({ type: 'varchar', nullable: true })
  scopeRef?: string | null;

  /** The same attribute set a scoped grant carries, for `selector` scope. */
  @Column({ type: 'jsonb', nullable: true })
  selector?: IamSelector | null;

  /** `practice` descends to whoever acts here; `rationale` stays with the level. */
  @Column({ type: 'varchar', default: 'practice' })
  nature: EntryNature;

  /**
   * The handle two entries share when they are about the same thing.
   *
   * The only way conflicts can be *shown*: nothing here reads prose, so two
   * rules disagreeing is detectable exactly to the extent that their authors
   * agreed on a word for the subject. A weak signal deliberately preferred to a
   * clever one — a similarity score that decided two notes contradicted each
   * other would be a second body of opinion about the first.
   */
  @Column({ type: 'varchar' })
  topic: string;

  @Column({ type: 'varchar' })
  title: string;

  @Column({ type: 'text' })
  body: string;

  @Column({ type: 'varchar', default: 'none' })
  checkKind: CheckKind;

  /** The registered probe this entry leans on, for `checkKind = 'probe'`. */
  @Column({ type: 'varchar', nullable: true })
  probeId?: string | null;

  @Column({ type: 'jsonb', nullable: true })
  probeParams?: Record<string, unknown> | null;

  /** `equals` | `notEquals` | `atLeast` | `atMost` | `exists`. */
  @Column({ type: 'varchar', nullable: true })
  probeOp?: string | null;

  @Column({ type: 'jsonb', nullable: true })
  probeExpected?: unknown;

  /** When a person last put their name to this entry, for `attestation`. */
  @Column({ type: 'timestamptz', nullable: true })
  confirmedAt?: Date | null;

  @Column({ type: 'varchar', nullable: true })
  confirmedByUserId?: string | null;

  @Column({ type: 'int', nullable: true })
  validForDays?: number | null;

  /**
   * The last answer the probe gave, and when.
   *
   * Persisted only when it *changes*, so the row carries the moment a premise
   * broke rather than the timestamp of the last person who happened to read it.
   */
  @Column({ type: 'varchar', nullable: true })
  lastProbeStatus?: ProbeStatus | null;

  @Column({ type: 'timestamptz', nullable: true })
  lastProbeAt?: Date | null;

  @Column({ type: 'text', nullable: true })
  lastProbeDetail?: string | null;

  @Column({ type: 'varchar' })
  authorUserId: string;

  /** Archived, never deleted: a rule that was true once explains a decision that was made once. */
  @Column({ type: 'timestamptz', nullable: true })
  archivedAt?: Date | null;

  /**
   * Who withdrew it, for a note that was.
   *
   * Null on every live note, and null on every note retired before this column
   * existed — the archive could be read back but not attributed, so *who do I
   * ask about this* had no answer on precisely the notes people go looking for.
   * No foreign key, like the two hands above: a person leaving this
   * installation must not take the record of what they decided with them.
   */
  @Column({ type: 'varchar', nullable: true })
  archivedByUserId?: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
