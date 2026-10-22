import { exampleTopology } from '../../../../src/modules/sandbox/stand-in/sandbox-world-topology';
import { dashboardBase, dashboardLink } from './topology-link';

const t = exampleTopology(1792663200000);
const BASE = 'https://dashboard.example.com';

/** The query the dashboard reads back with parseTopologyState. */
const query = (link: string) =>
  Object.fromEntries(new URL(link).searchParams.entries());

describe('dashboard links', () => {
  it('opens the fleet on the defaults, with nothing in the address', () => {
    expect(dashboardLink(`${BASE}/`, t, { type: 'fleet' })).toBe(
      'https://dashboard.example.com/topology',
    );
  });

  it('opens a cluster at its level', () => {
    const link = dashboardLink(BASE, t, {
      type: 'cluster',
      id: 'example-cluster-1',
    });
    expect(link).toBe(
      'https://dashboard.example.com/topology?level=cluster&cluster=example-cluster-1',
    );
    expect(query(link)).toEqual({
      level: 'cluster',
      cluster: 'example-cluster-1',
    });
  });

  it('opens the Flui platform focused on its cluster, as the map node does', () => {
    expect(
      dashboardLink(BASE, t, { type: 'platform', id: 'example-cluster-3' }),
    ).toBe(
      'https://dashboard.example.com/topology?level=cluster&cluster=example-cluster-3&focus=platform:example-cluster-3',
    );
  });

  it('opens an app as the app overview "What it connects to" link does', () => {
    const link = dashboardLink(BASE, t, { type: 'app', id: 'example-app-1' });
    expect(link).toBe(
      'https://dashboard.example.com/topology?level=app&cluster=example-cluster-1&app=example-app-1&focus=app:example-app-1',
    );
    expect(query(link)).toEqual({
      level: 'app',
      cluster: 'example-cluster-1',
      app: 'example-app-1',
      focus: 'app:example-app-1',
    });
  });

  it('opens a server focused in the infrastructure view', () => {
    expect(
      dashboardLink(BASE, t, { type: 'server', id: 'example-server-2' }),
    ).toBe(
      'https://dashboard.example.com/topology?view=infrastructure&focus=server:example-server-2',
    );
  });

  it('keeps colons in an id readable and escapes the rest', () => {
    const link = dashboardLink(BASE, t, { type: 'server', id: 'node:a b&c' });
    expect(link).toBe(
      'https://dashboard.example.com/topology?view=infrastructure&focus=server:node:a%20b%26c',
    );
    expect(query(link).focus).toBe('server:node:a b&c');
  });

  it('takes the flag over what the API says, and knows when neither says', () => {
    expect(dashboardBase({ ...t, dashboardUrl: BASE }, undefined)).toBe(BASE);
    expect(
      dashboardBase({ ...t, dashboardUrl: BASE }, 'http://localhost:4200'),
    ).toBe('http://localhost:4200');
    expect(
      dashboardBase({ ...t, dashboardUrl: undefined }, undefined),
    ).toBeNull();
  });
});
