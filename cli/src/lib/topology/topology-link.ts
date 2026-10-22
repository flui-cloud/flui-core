import type { Snapshot, TopologyScreen } from './topology-view';

type Params = Array<[key: string, value: string]>;

/** The dashboard Topology query for a screen, in the order and form the dashboard writes it. */
export function screenParams(t: Snapshot, screen: TopologyScreen): Params {
  switch (screen.type) {
    case 'fleet':
      return [];
    case 'cluster':
      return [
        ['level', 'cluster'],
        ['cluster', screen.id],
      ];
    case 'platform':
      return [
        ['level', 'cluster'],
        ['cluster', screen.id],
        ['focus', `platform:${screen.id}`],
      ];
    case 'app': {
      const clusterId = t.apps.find((a) => a.id === screen.id)?.clusterId;
      return [
        ['level', 'app'],
        ...(clusterId ? ([['cluster', clusterId]] as Params) : []),
        ['app', screen.id],
        ['focus', `app:${screen.id}`],
      ];
    }
    case 'server':
      return [
        ['view', 'infrastructure'],
        ['focus', `server:${screen.id}`],
      ];
  }
}

const encode = (value: string) =>
  encodeURIComponent(value).replaceAll('%3A', ':');

/** Where a screen opens in the dashboard, e.g. https://dashboard.example.com/topology?level=cluster&cluster=c1 */
export function dashboardLink(
  base: string,
  t: Snapshot,
  screen: TopologyScreen,
): string {
  let root = base.trim();
  while (root.endsWith('/')) root = root.slice(0, -1);
  const query = screenParams(t, screen)
    .map(([key, value]) => `${key}=${encode(value)}`)
    .join('&');
  const search = query ? `?${query}` : '';
  return `${root}/topology${search}`;
}

export const NO_DASHBOARD_URL =
  'This Flui API does not say where its dashboard is (it predates that). ' +
  'Run `flui env status` once to record it, or pass --dashboard-url <url>.';

/** The dashboard base: the flag first, then what the API says; null when neither knows. */
export function dashboardBase(
  t: Snapshot,
  override: string | undefined,
): string | null {
  return override?.trim() || t.dashboardUrl?.trim() || null;
}
