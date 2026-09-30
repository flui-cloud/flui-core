import {
  CliEndpointResolverService,
  effectiveOidcIssuer,
} from './cli-endpoint-resolver.service';

const MASTER_IP = '49.13.132.151';
const TOKEN = 'cheerful-meerkat-py';
const NIP = `${TOKEN}.49-13-132-151.nip.io`;

function endpointIngress(service: string, host: string, id: string) {
  return {
    metadata: {
      name: `${service}-${id}-ingress`,
      labels: {
        'managed-by': 'flui-cloud',
        'flui-resource-type': 'dns-ingress',
        'flui-endpoint-id': `${id}-0000`,
      },
    },
    spec: {
      tls: [{ hosts: [host] }],
      rules: [
        {
          host,
          http: { paths: [{ backend: { service: { name: service } } }] },
        },
      ],
    },
  };
}

function bootstrapRoute(name: string, host: string) {
  return {
    metadata: { name, labels: { app: name } },
    spec: {
      entryPoints: ['websecure'],
      routes: [{ match: `Host(\`${host}\`)` }],
    },
  };
}

function resolverAnswering(snapshot: Record<string, unknown>) {
  const ssh = {
    sshExec: jest.fn().mockResolvedValue(JSON.stringify(snapshot)),
  };
  return new CliEndpointResolverService(ssh as never);
}

const bootstrapRoutes = [
  bootstrapRoute('flui-api', `api.${NIP}`),
  bootstrapRoute('flui-web', `app.${NIP}`),
  bootstrapRoute('zitadel', `auth.${NIP}`),
];

describe('system endpoints moved to a domain from the dashboard', () => {
  const snapshot = {
    ingresses: {
      items: [
        endpointIngress('flui-api', 'api.example.com', 'b5c62124'),
        endpointIngress('flui-web', 'dashboard.example.com', 'a2436838'),
        endpointIngress('zitadel', 'auth.example.com', '27973037'),
      ],
    },
    ingressRoutes: { items: bootstrapRoutes },
    configmap: { data: { OIDC_ISSUER: 'https://auth.example.com' } },
    secret: null,
    webConfigMap: null,
    authConfig: { authMode: 'oidc', issuer: 'https://auth.example.com' },
  };

  it('reads the addresses the endpoints publish, not the ones the cluster was born with', async () => {
    const endpoints = await resolverAnswering(snapshot).resolveEndpoints(
      MASTER_IP,
      TOKEN,
    );
    expect(endpoints.fluiApi.effectiveUrl).toBe('https://api.example.com');
    expect(endpoints.fluiWeb.effectiveUrl).toBe(
      'https://dashboard.example.com',
    );
    expect(endpoints.zitadel.fqdn).toBe('auth.example.com');
    expect(endpoints.fluiApi.custom).toBe(true);
  });

  it('takes the issuer the running API reports', async () => {
    const endpoints = await resolverAnswering(snapshot).resolveEndpoints(
      MASTER_IP,
      TOKEN,
    );
    expect(effectiveOidcIssuer(endpoints)).toBe('https://auth.example.com');
  });
});

describe('a cluster still on the addresses it was born with', () => {
  it('reads the bootstrap routes and says they are the default address', async () => {
    const endpoints = await resolverAnswering({
      ingresses: { items: [] },
      ingressRoutes: { items: bootstrapRoutes },
      configmap: null,
      secret: null,
      webConfigMap: null,
      authConfig: null,
    }).resolveEndpoints(MASTER_IP, TOKEN);
    expect(endpoints.fluiApi.effectiveUrl).toBe(`https://api.${NIP}`);
    expect(endpoints.fluiApi.custom).toBe(false);
  });
});

describe('the issuer when the API does not answer', () => {
  const base = {
    oidcIssuer: 'https://auth.stale.example.com',
    oidcIssuerLive: '',
    zitadel: {
      fqdn: 'auth.example.com',
      defaultUrl: '',
      effectiveUrl: 'https://auth.example.com',
      synced: true,
      custom: true,
    },
  };

  it('falls back to where Zitadel is published', () => {
    expect(effectiveOidcIssuer(base)).toBe('https://auth.example.com');
  });

  it('falls back to the configured value when Zitadel has no address', () => {
    expect(
      effectiveOidcIssuer({
        ...base,
        zitadel: { ...base.zitadel, fqdn: null },
      }),
    ).toBe('https://auth.stale.example.com');
  });
});
