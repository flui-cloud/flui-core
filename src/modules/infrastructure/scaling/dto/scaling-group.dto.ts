import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  NodeRequirement,
  PLACEMENT_STRATEGIES,
  PlacementStrategy,
  PROVISION_MODES,
  ProvisionMode,
  STANDING_ORDER_KINDS,
  StandingOrderKind,
} from '../scaling.core';

export class ScalingBoundsDto {
  @IsInt()
  @Min(0)
  min: number;

  @IsInt()
  @Min(0)
  desired: number;

  /**
   * Zero is allowed, and it is a statement rather than a disabled group: this
   * fleet should hold no nodes. Where nothing can be provisioned the ceiling was
   * never a gate — it reports — so `max: 0` is how a group says every machine on
   * the cluster is one somebody attached, and where Flui can buy it says urgency
   * may buy nothing. `min <= desired <= max` still holds, so it is only writable
   * with the other two at zero as well.
   */
  @IsInt()
  @Min(0)
  max: number;
}

export class ScalingLimitsDto {
  @IsOptional()
  @IsBoolean()
  hourlyBillingOnly?: boolean;

  /**
   * Absent means no ceiling at all, which is not the same as a ceiling of zero
   * — the block is replaced as a unit, so leaving it out is how a cap is
   * removed.
   */
  @IsOptional()
  @IsNumber()
  @Min(0)
  maxMonthlyCost?: number | null;
}

export class NodeRequirementDto implements NodeRequirement {
  @IsString()
  cpu: string;

  @IsString()
  memory: string;
}

export class StandingOrderDto {
  @IsIn(STANDING_ORDER_KINDS)
  kind: StandingOrderKind;

  @IsString()
  shape: string;

  @IsString()
  region: string;

  @IsInt()
  @Min(1)
  wanted: number;

  /** The node to drain and remove. Refused unless `kind` is `replace`. */
  @IsOptional()
  @IsString()
  replaces?: string | null;
}

export class WriteScalingGroupDto {
  @IsString()
  name: string;

  @ValidateNested()
  @Type(() => ScalingBoundsDto)
  bounds: ScalingBoundsDto;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  regions?: string[];

  /** In order of preference — the order is the preference. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  shapes?: string[];

  @IsOptional()
  @IsIn(PLACEMENT_STRATEGIES)
  strategy?: PlacementStrategy;

  /**
   * Bounded above because an hour of settling is no longer a check that the pod
   * is really stuck, it is an outage with a timer on it.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(3600)
  settleSeconds?: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => ScalingLimitsDto)
  limits?: ScalingLimitsDto;

  @IsOptional()
  @IsIn(PROVISION_MODES)
  provision?: ProvisionMode;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => StandingOrderDto)
  standingOrders?: StandingOrderDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => NodeRequirementDto)
  requirement?: NodeRequirementDto | null;
}

/**
 * Every field optional, and every field present replaced whole.
 *
 * The three bounds are three roles that only mean anything together — a patch
 * that could raise the ceiling without being shown the floor is a patch that
 * writes an inconsistent group.
 *
 * Present is the test, not truthy: `regions: []`, `shapes: []`,
 * `standingOrders: []` and `settleSeconds: 0` are values, and they land. A field
 * is left alone only by being left out — which is the only way a block can be
 * emptied at all, and a PATCH that took an empty array and quietly did nothing
 * would report success for a change it discarded.
 */
export class EditScalingGroupDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => ScalingBoundsDto)
  bounds?: ScalingBoundsDto;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  regions?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  shapes?: string[];

  @IsOptional()
  @IsIn(PLACEMENT_STRATEGIES)
  strategy?: PlacementStrategy;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(3600)
  settleSeconds?: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => ScalingLimitsDto)
  limits?: ScalingLimitsDto;

  @IsOptional()
  @IsIn(PROVISION_MODES)
  provision?: ProvisionMode;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => StandingOrderDto)
  standingOrders?: StandingOrderDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => NodeRequirementDto)
  requirement?: NodeRequirementDto | null;
}
