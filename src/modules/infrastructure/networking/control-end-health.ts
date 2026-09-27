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

export function controlEndFailed(message: string, at = new Date()): void {
  problem = { message, at };
}

export function controlEndHealthy(): void {
  problem = null;
}

export function controlEndProblem(): ControlEndProblem | null {
  return problem;
}
