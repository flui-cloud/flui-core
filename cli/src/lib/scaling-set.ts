import type { ScalingGroupResponseDto } from 'src/modules/infrastructure/scaling/dto/scaling-response.dto';
import type { EditScalingGroupDto } from 'src/modules/infrastructure/scaling/dto/scaling-group.dto';

export type SetFlags = {
  'max-monthly'?: string;
  'hourly-only'?: boolean;
  provision?: string;
  shapes?: string;
  regions?: string;
  min?: number;
  desired?: number;
  max?: number;
  strategy?: string;
  settle?: number;
};

/**
 * Only the blocks a flag touches, each restated whole from what the group has:
 * the API replaces a block it receives, so a partial one would silently drop
 * the rest of it.
 */
export function changeOf(
  group: ScalingGroupResponseDto,
  flags: SetFlags,
): EditScalingGroupDto {
  const change: EditScalingGroupDto = {};
  if (
    flags['max-monthly'] !== undefined ||
    flags['hourly-only'] !== undefined
  ) {
    change.limits = {
      hourlyBillingOnly: flags['hourly-only'] ?? group.limits.hourlyBillingOnly,
      maxMonthlyCost:
        flags['max-monthly'] === undefined
          ? group.limits.maxMonthlyCost
          : monthly(flags['max-monthly']),
    };
  }
  if (
    flags.min !== undefined ||
    flags.desired !== undefined ||
    flags.max !== undefined
  ) {
    change.bounds = {
      min: flags.min ?? group.bounds.min,
      desired: flags.desired ?? group.bounds.desired,
      max: flags.max ?? group.bounds.max,
    };
  }
  if (flags.provision !== undefined)
    change.provision = flags.provision as never;
  if (flags.shapes !== undefined) change.shapes = list(flags.shapes);
  if (flags.regions !== undefined) change.regions = list(flags.regions);
  if (flags.strategy !== undefined) change.strategy = flags.strategy as never;
  if (flags.settle !== undefined) change.settleSeconds = flags.settle;
  return change;
}

function monthly(value: string): number | null {
  if (value.trim().toLowerCase() === 'none') return null;
  const n = Number(value.replace(/^€/, ''));
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(
      `--max-monthly takes a number of euros or "none", not "${value}"`,
    );
  }
  return n;
}

function list(value: string): string[] {
  return value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}
