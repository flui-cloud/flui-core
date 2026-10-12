import { apiVersionForKind } from './kube-api-version.util';

describe('apiVersionForKind', () => {
  it('reads IngressRoutes from the group Traefik 3 serves', () => {
    expect(apiVersionForKind('IngressRoute')).toBe('traefik.io/v1alpha1');
  });

  it('knows the kinds the migration bridge creates', () => {
    expect(apiVersionForKind('IngressRouteTCP')).toBe('traefik.io/v1alpha1');
    expect(apiVersionForKind('ServersTransport')).toBe('traefik.io/v1alpha1');
    expect(apiVersionForKind('EndpointSlice')).toBe('discovery.k8s.io/v1');
  });
});
