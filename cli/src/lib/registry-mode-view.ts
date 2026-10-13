export type RegistryStorageChoice = 'volume' | 's3';

export interface RegistryModeStatus {
  mode: 'ghcr' | 'flui';
  source: 'setting' | 'install';
  storage: RegistryStorageChoice | null;
  host: string | null;
  ready: boolean | null;
  detail: string | null;
  bucketConnected: boolean;
  applicationsOnRegistry: number;
}

const PLACE: Record<RegistryStorageChoice, string> = {
  volume: 'a volume on the control cluster',
  s3: 'the connected bucket',
};

export function registryModeLines(status: RegistryModeStatus): string[] {
  if (status.mode === 'ghcr') {
    return [
      'New builds push to: GitHub Container Registry',
      `Bucket for the Flui registry: ${status.bucketConnected ? 'connected' : 'none'}`,
      'Switch with `flui registry enable`.',
    ];
  }
  const lines = [
    `New builds push to: the Flui registry (${status.host ?? 'no address'})`,
    `Images kept on: ${PLACE[status.storage ?? 'volume']}`,
    `State: ${status.ready ? 'ready' : 'starting'}`,
    `Applications on it: ${status.applicationsOnRegistry}`,
  ];
  if (status.detail) lines.push(`Note: ${status.detail}`);
  if (status.source === 'install') lines.push('Chosen at install.');
  return lines;
}

/** A connected bucket is what someone who connected one most likely wants. */
export function defaultStorage(
  status: Pick<RegistryModeStatus, 'bucketConnected'>,
): RegistryStorageChoice {
  return status.bucketConnected ? 's3' : 'volume';
}

export async function waitForRegistry(
  read: () => Promise<RegistryModeStatus>,
  options: {
    timeoutMs: number;
    intervalMs: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  },
): Promise<RegistryModeStatus> {
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const deadline = now() + options.timeoutMs;
  let status = await read();
  while (status.mode === 'flui' && !status.ready && now() < deadline) {
    await sleep(options.intervalMs);
    status = await read();
  }
  return status;
}
