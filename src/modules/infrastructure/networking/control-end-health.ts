import type { ControlNodeState } from './services/control-host-steps';

/**
 * The last thing that stopped the control's end of the Flui network from being
 * set up, kept in the process like the switch itself: the status read has to
 * say why members stay pending, and the reconciler is the only one that knows.
 */
export interface ControlEndProblem {
  message: string;
  at: Date;
}

let problem: ControlEndProblem | null = null;
let warning: string | null = null;

export function controlEndFailed(message: string, at = new Date()): void {
  problem = { message, at };
}

export function controlEndHealthy(): void {
  problem = null;
}

export function controlEndProblem(): ControlEndProblem | null {
  return problem;
}

/** Something about the control's end that works but is set up wrong. */
export function controlEndWarned(message: string | null): void {
  warning = message;
}

export function controlEndWarning(): string | null {
  return warning;
}

/**
 * Only the master's end holds members back: every member's config names it
 * and its key is the one kept. A control worker that did not converge is
 * reported on its own node, never as the hub's problem.
 */
export function recordControlEndHealth(nodes: ControlNodeState[]): void {
  const primary = nodes.find((n) => n.primary);
  if (!primary || primary.applied) {
    controlEndHealthy();
    return;
  }
  controlEndFailed(`the control master: ${primary.error ?? 'not applied'}`);
}
