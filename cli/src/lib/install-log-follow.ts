export interface InstallLogChunk {
  operationId: string;
  status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  text: string;
  since: number;
  next: number;
  more: boolean;
  captured: boolean;
  truncated: boolean;
  done: boolean;
  note: string | null;
}

export interface FollowOptions {
  read: (since: number) => Promise<InstallLogChunk>;
  write: (text: string) => void;
  follow: boolean;
  intervalMs: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Prints the log from the start and, when following, keeps reading from the
 * cursor until the API says nothing more will come. Returns the last answer,
 * whose `note` and `status` the caller reports.
 */
export async function followInstallLog(
  options: FollowOptions,
): Promise<InstallLogChunk> {
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let since = 0;
  for (;;) {
    const chunk = await options.read(since);
    if (chunk.text) options.write(chunk.text);
    since = chunk.next;
    if (chunk.more) continue;
    if (!options.follow || chunk.done) return chunk;
    await sleep(options.intervalMs);
  }
}
