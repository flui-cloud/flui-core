import { GatewayMiddlewareCompilerService } from './gateway-middleware-compiler.service';
import { EndpointGatewayConfig } from '../interfaces/endpoint-gateway-config.interface';

describe('GatewayMiddlewareCompilerService', () => {
  const compiler = new GatewayMiddlewareCompilerService();
  const endpoint = {
    id: 'a1b2c3d4-0000-0000-0000-000000000000',
    k8sNamespace: 'flui-apps',
  };

  it('compiles nothing for a missing config (default behavior preserved)', () => {
    const result = compiler.compile(endpoint, null);
    expect(result.middlewares).toHaveLength(0);
    expect(result.refs).toHaveLength(0);
    expect(result.path).toBe('/');
  });

  it('compiles an ipAllowList middleware from allowIps', () => {
    const config: EndpointGatewayConfig = { allowIps: ['203.0.113.0/24'] };
    const result = compiler.compile(endpoint, config);
    expect(result.middlewares).toHaveLength(1);
    const mw = result.middlewares[0];
    expect(mw.name).toBe('flui-gw-a1b2c3d4-allowlist');
    expect(mw.manifest.spec).toEqual({
      ipAllowList: { sourceRange: ['203.0.113.0/24'] },
    });
    expect(mw.ref).toBe('flui-apps-flui-gw-a1b2c3d4-allowlist@kubernetescrd');
  });

  it('compiles a rateLimit middleware with optional burst/period', () => {
    const config: EndpointGatewayConfig = {
      rateLimit: { average: 100, burst: 50, period: '1s' },
    };
    const result = compiler.compile(endpoint, config);
    expect(result.middlewares[0].manifest.spec).toEqual({
      rateLimit: { average: 100, burst: 50, period: '1s' },
    });
  });

  it('omits burst/period when not set', () => {
    const result = compiler.compile(endpoint, { rateLimit: { average: 10 } });
    expect(result.middlewares[0].manifest.spec).toEqual({
      rateLimit: { average: 10 },
    });
  });

  it('compiles a forwardAuth middleware for SSO and requires the address', () => {
    const config: EndpointGatewayConfig = { auth: { sso: true } };
    expect(() => compiler.compile(endpoint, config)).toThrow(
      /no forwardAuth address/,
    );

    const result = compiler.compile(
      endpoint,
      config,
      'https://api.example.com/api/v1/authz/gateway',
    );
    const spec = result.middlewares[0].manifest.spec as {
      forwardAuth: Record<string, unknown>;
    };
    expect(spec.forwardAuth.address).toBe(
      'https://api.example.com/api/v1/authz/gateway',
    );
    expect(spec.forwardAuth.trustForwardHeader).toBe(true);
  });

  it('orders the chain allowlist → ratelimit → sso', () => {
    const config: EndpointGatewayConfig = {
      allowIps: ['10.0.0.0/8'],
      rateLimit: { average: 5 },
      auth: { sso: true, minRole: 'viewer' },
    };
    const result = compiler.compile(endpoint, config, 'https://api/authz');
    expect(result.middlewares.map((m) => m.name)).toEqual([
      'flui-gw-a1b2c3d4-allowlist',
      'flui-gw-a1b2c3d4-ratelimit',
      'flui-gw-a1b2c3d4-sso',
    ]);
    expect(result.refs.join(',')).toBe(
      'flui-apps-flui-gw-a1b2c3d4-allowlist@kubernetescrd,' +
        'flui-apps-flui-gw-a1b2c3d4-ratelimit@kubernetescrd,' +
        'flui-apps-flui-gw-a1b2c3d4-sso@kubernetescrd',
    );
  });

  it('stamps managed-by and endpoint labels on every middleware', () => {
    const result = compiler.compile(endpoint, { allowIps: ['10.0.0.0/8'] });
    const metadata = result.middlewares[0].manifest.metadata as {
      labels: Record<string, string>;
      namespace: string;
    };
    expect(metadata.namespace).toBe('flui-apps');
    expect(metadata.labels).toEqual({
      'managed-by': 'flui-cloud',
      'flui-resource-type': 'gateway-middleware',
      'flui-endpoint-id': endpoint.id,
    });
  });

  it('normalizes paths', () => {
    expect(compiler.normalizePath(undefined)).toBe('/');
    expect(compiler.normalizePath('/')).toBe('/');
    expect(compiler.normalizePath('api')).toBe('/api');
    expect(compiler.normalizePath('/api/')).toBe('/api');
    expect(compiler.compile(endpoint, { path: '/v1' }).path).toBe('/v1');
  });

  it('exposes the full name set for cleanup', () => {
    expect(compiler.allMiddlewareNames(endpoint)).toEqual([
      'flui-gw-a1b2c3d4-allowlist',
      'flui-gw-a1b2c3d4-ratelimit',
      'flui-gw-a1b2c3d4-sso',
    ]);
  });
});
