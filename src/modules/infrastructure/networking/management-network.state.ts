/**
 * Whether the Flui network (the management overlay) is on for this
 * installation, as last read from its stored state.
 *
 * Stored on the control cluster so an installer refresh cannot switch it off;
 * `FLUI_WG_ENABLED=false` at install is the opt-out for a host that cannot run
 * it, and on is the default. Read synchronously because the callers are rule
 * renderers and schedulers, not request handlers.
 */
export type ManagementNetworkSource = 'setting' | 'install' | 'default';

export interface ManagementNetworkSwitch {
  enabled: boolean;
  source: ManagementNetworkSource;
}

let current: ManagementNetworkSwitch | null = null;

export function switchFromInstall(env = process.env): ManagementNetworkSwitch {
  const raw = env.FLUI_WG_ENABLED?.trim().toLowerCase();
  if (raw === 'false' || raw === '0' || raw === 'off') {
    return { enabled: false, source: 'install' };
  }
  if (raw === 'true' || raw === '1' || raw === 'on') {
    return { enabled: true, source: 'install' };
  }
  return { enabled: true, source: 'default' };
}

/** What a person stored, when anyone did; otherwise the installer's choice. */
export function resolveSwitch(
  stored: { enabled?: boolean } | null | undefined,
  env = process.env,
): ManagementNetworkSwitch {
  return typeof stored?.enabled === 'boolean'
    ? { enabled: stored.enabled, source: 'setting' }
    : switchFromInstall(env);
}

export function rememberSwitch(value: ManagementNetworkSwitch): void {
  current = value;
}

export function managementNetworkSwitch(): ManagementNetworkSwitch {
  return current ?? switchFromInstall();
}

export function managementNetworkOn(): boolean {
  return managementNetworkSwitch().enabled;
}
