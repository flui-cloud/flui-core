import { SuggestedActionType } from '../enums/suggested-action-type.enum';
import { SuggestedAction } from '../interfaces/crash-diagnosis.interface';

export const DEFAULT_MEMORY_LIMIT_MI = 256;
export const MEMORY_RAISE_CAP_MI = 8 * 1024;

/**
 * What to propose after a container was killed for crossing its memory limit.
 *
 * A proposal, never an act: raising a limit without a person deciding it lets
 * one leaking application take memory the machine promised to others, and the
 * evictions that follow are what make a fleet buy machines. Only the limit is
 * proposed — the memory reserved on the machine stays as it was — so accepting
 * it never makes the cluster look fuller than it is.
 */
export function memoryRaise(
  currentLimitMi: number | null,
  containerName: string | null,
): SuggestedAction {
  const current =
    currentLimitMi && currentLimitMi > 0
      ? currentLimitMi
      : DEFAULT_MEMORY_LIMIT_MI;

  if (current >= MEMORY_RAISE_CAP_MI) {
    return {
      type: SuggestedActionType.MANUAL,
      message: `The memory limit is already ${formatMemory(current)}. An application that still runs out at this size is more often leaking than short — look at what it holds before raising it further.`,
    };
  }

  const next = Math.min(current * 2, MEMORY_RAISE_CAP_MI);
  return {
    type: SuggestedActionType.RESOURCES,
    message: `Raise the memory limit from ${formatMemory(current)} to ${formatMemory(next)}.`,
    payload: {
      limits: { memory: formatMemory(next) },
      ...(containerName ? { containerName } : {}),
    },
  };
}

export function formatMemory(mi: number): string {
  if (mi >= 1024 && mi % 1024 === 0) return `${mi / 1024}Gi`;
  return `${mi}Mi`;
}
