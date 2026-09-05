import { findSystemAppByLabel } from '../../applications/constants/system-app-catalog';

/**
 * The components a platform release moves, and nothing else.
 *
 * Deliberately not every system app: Postgres, Grafana and the rest are
 * third-party workloads on their own release trains, curated per-app by
 * `allowedVersions`. A Flui release is a statement about Flui's own three
 * images, so this list is what "update the platform" means.
 */
export type PlatformComponentKey = 'fluiApi' | 'fluiWeb' | 'fluiAuthz';

export interface PlatformUpdateComponentDef {
  key: PlatformComponentKey;
  name: string;
  /** `k8sAppLabel` in SYSTEM_APP_CATALOG — the row carrying the running image. */
  systemAppLabel: string;
  role: string;
  /**
   * True for the component whose rollout terminates the process driving it.
   * The one fact that makes a platform update different from every other
   * deploy: it must be sequenced last and finished by the pod that replaces us.
   */
  restartsControlPlane: boolean;
}

export const PLATFORM_UPDATE_COMPONENTS: PlatformUpdateComponentDef[] = [
  {
    key: 'fluiWeb',
    name: 'Flui Web',
    systemAppLabel: 'flui-web',
    role: 'Dashboard',
    restartsControlPlane: false,
  },
  {
    key: 'fluiAuthz',
    name: 'Flui Authz',
    systemAppLabel: 'flui-authz',
    role: 'Authorization service',
    restartsControlPlane: false,
  },
  {
    key: 'fluiApi',
    name: 'Flui API',
    systemAppLabel: 'flui-api',
    role: 'Control plane API',
    restartsControlPlane: true,
  },
];

/** Image repository for a component, read from the system-app catalog. */
export function repositoryOf(def: PlatformUpdateComponentDef): string | null {
  const app = findSystemAppByLabel(def.systemAppLabel);
  return app?.imageSource?.repository ?? null;
}
