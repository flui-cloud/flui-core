/**
 * Why a scheduled run failed, in Flui's words, from what the cluster keeps:
 * the state of the run's container, and the job's own condition when the
 * container is already gone.
 */
export function describeRunFailure(
  job: Record<string, any>,
  pods: Record<string, any>[],
): string | null {
  for (const pod of pods) {
    for (const status of pod?.status?.containerStatuses ?? []) {
      const said =
        fromContainer(status?.state) ?? fromContainer(status?.lastState);
      if (said) return said;
    }
    if (pod?.status?.reason === 'Evicted') {
      return 'The run was stopped by the node, which ran short of resources.';
    }
  }
  const failed = (job?.status?.conditions ?? []).find(
    (c: any) => c?.type === 'Failed' && c?.status === 'True',
  );
  if (failed?.reason === 'DeadlineExceeded') {
    return 'The run took longer than it was allowed to and was stopped.';
  }
  if (failed?.reason === 'BackoffLimitExceeded') {
    return 'The run failed and its retry failed too; the reason is no longer on the cluster.';
  }
  return failed
    ? 'The run failed; the reason is no longer on the cluster.'
    : null;
}

function fromContainer(state: Record<string, any> | undefined): string | null {
  const waiting = state?.waiting;
  if (waiting?.reason) {
    if (/ErrImagePull|ImagePullBackOff|InvalidImageName/.test(waiting.reason)) {
      return 'The image could not be downloaded, so the run never started.';
    }
    if (
      /CreateContainer|RunContainer|StartError|ContainerCannotRun/.test(
        waiting.reason,
      )
    ) {
      return (
        startProblem(waiting.message) ?? 'The command could not be started.'
      );
    }
  }
  const terminated = state?.terminated;
  if (!terminated) return null;
  if (terminated.reason === 'OOMKilled') {
    return 'The run ran out of memory and was stopped.';
  }
  if (/StartError|ContainerCannotRun/.test(terminated.reason ?? '')) {
    return (
      startProblem(terminated.message) ?? 'The command could not be started.'
    );
  }
  if (typeof terminated.exitCode === 'number' && terminated.exitCode !== 0) {
    return terminated.exitCode === 127
      ? 'The command was not found in the image (exit code 127).'
      : `The command exited with code ${terminated.exitCode}.`;
  }
  return null;
}

function startProblem(message: string | undefined): string | null {
  if (!message) return null;
  if (/\/bin\/sh/.test(message) && /no such file|not found/i.test(message)) {
    return 'The image has no shell (/bin/sh), and a scheduled command runs through one. Use an image that has a shell.';
  }
  if (/executable file not found|no such file/i.test(message)) {
    return 'The command was not found in the image.';
  }
  return null;
}
