import {
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { IamSelector } from '../../iam/interfaces/iam.types';
import {
  CheckKind,
  CONTEXT_SCOPE_TYPES,
  ContextScopeType,
  ENTRY_NATURES,
  EntryNature,
} from '../operating-context.core';
import { PROBE_OPS, ProbeOp } from '../probes/context-probe';

export class WriteContextEntryDto {
  @IsIn(CONTEXT_SCOPE_TYPES)
  scopeType: ContextScopeType;

  @IsOptional()
  @IsString()
  scopeRef?: string;

  @IsOptional()
  @IsObject()
  selector?: IamSelector;

  @IsIn(ENTRY_NATURES)
  nature: EntryNature;

  @IsString()
  topic: string;

  @IsString()
  title: string;

  @IsString()
  body: string;

  @IsOptional()
  @IsIn(['none', 'attestation', 'probe'])
  checkKind?: CheckKind;

  @IsOptional()
  @IsString()
  probeId?: string;

  @IsOptional()
  @IsObject()
  probeParams?: Record<string, unknown>;

  @IsOptional()
  @IsIn(PROBE_OPS)
  probeOp?: ProbeOp;

  probeExpected?: unknown;

  /**
   * How long a confirmation is worth, for `attestation`.
   *
   * Bounded above because an attestation with a five-year life is a way of
   * writing `none` while looking checked, which is the exact dishonesty the
   * three kinds exist to prevent.
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  validForDays?: number;
}

/** Everything but the scope, which is what the entry *is*. */
export class EditContextEntryDto {
  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  body?: string;

  @IsOptional()
  @IsString()
  topic?: string;
}
