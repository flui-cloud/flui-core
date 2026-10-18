import { CLI_DEFAULTS } from '../config/defaults';

export interface FitCandidate {
  cores: number;
  memory: number;
  architecture: 'x86' | 'arm';
  bareMetal: boolean;
  supportsHourlyBilling: boolean;
}

/** The sizes worth offering for a first Flui cluster, and a price above which nobody starts. */
export const FIT = {
  minCores: CLI_DEFAULTS.MIN_SPECS.observability.cores,
  minMemory: CLI_DEFAULTS.MIN_SPECS.observability.memory,
  maxCores: 16,
  maxMemory: 32,
  maxMonthlyPrice: 100,
} as const;

/**
 * Whether a server type is one to start Flui on: x86 (apps built from a
 * repository are built for it), a cloud server billed by the hour rather than
 * a dedicated machine, big enough for the control plane, not oversized, and
 * priced below the cap. A type with no known price is left out, because
 * nothing says it is under the cap.
 */
export function fitsFlui(
  type: FitCandidate,
  monthlyPrice: number,
  maxMonthlyPrice: number = FIT.maxMonthlyPrice,
): boolean {
  return (
    type.architecture === 'x86' &&
    !type.bareMetal &&
    type.supportsHourlyBilling &&
    type.cores >= FIT.minCores &&
    type.cores <= FIT.maxCores &&
    type.memory >= FIT.minMemory &&
    type.memory <= FIT.maxMemory &&
    Number.isFinite(monthlyPrice) &&
    monthlyPrice <= maxMonthlyPrice
  );
}
