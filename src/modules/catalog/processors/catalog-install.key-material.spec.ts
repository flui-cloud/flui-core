jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('ip-cidr', () => ({}));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));
jest.mock('@octokit/rest', () => ({ Octokit: class {} }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('libsodium-wrappers', () => ({ ready: Promise.resolve() }));

import { X509Certificate, createPrivateKey } from 'node:crypto';
import * as bcrypt from 'bcrypt';
import { CatalogInstallProcessor } from './catalog-install.processor';
import { CatalogSecretGeneratorService } from '../services/catalog-secret-generator.service';
import { CatalogTemplateResolverService } from '../services/catalog-template-resolver.service';
import { CatalogEnvVar } from '../interfaces/catalog-manifest.interface';

type Resolved = Array<{ name: string; value: string; secret: boolean }>;

function processor() {
  const self = Object.create(CatalogInstallProcessor.prototype);
  Object.assign(self, {
    secretGenerator: new CatalogSecretGeneratorService(),
    templateResolver: new CatalogTemplateResolverService(),
    encryptionService: {
      decrypt: (v: string) => {
        if (!v.startsWith('enc:')) throw new Error('not encrypted');
        return v.slice(4);
      },
    },
  });
  return self as {
    resolveEnv(env: CatalogEnvVar[], install: unknown): Resolved;
    persistedEnv(app: unknown): Record<string, string>;
    renderConfigFiles(
      files: Array<{ path: string; content: string }>,
      ctx: unknown,
    ): Array<{ path: string; content: string }>;
  };
}

const install = { slug: 'harbor-ab12', userInputs: {}, envOverrides: {} };

describe('key material in a catalog install', () => {
  it('generates a private key and a certificate that belongs to it', () => {
    const env = processor().resolveEnv(
      [
        {
          name: 'TOKEN_CERT',
          valueFrom: { certificateFor: 'TOKEN_KEY', commonName: 'token-ca' },
        },
        {
          name: 'TOKEN_KEY',
          valueFrom: { generate: 'rsa-private-key', bits: 2048 },
        },
      ],
      install,
    );
    const byName = Object.fromEntries(env.map((e) => [e.name, e]));
    const key = createPrivateKey(byName.TOKEN_KEY.value);
    const cert = new X509Certificate(byName.TOKEN_CERT.value);

    expect(key.asymmetricKeyDetails?.modulusLength).toBe(2048);
    expect(cert.subject).toBe('CN=token-ca');
    expect(cert.checkPrivateKey(key)).toBe(true);
    expect(byName.TOKEN_KEY.secret).toBe(true);
    expect(byName.TOKEN_CERT.secret).toBe(true);
  });

  it('names the certificate after the install when no common name is given', () => {
    const env = processor().resolveEnv(
      [
        { name: 'KEY', valueFrom: { generate: 'rsa-private-key', bits: 2048 } },
        { name: 'CERT', valueFrom: { certificateFor: 'KEY' } },
      ],
      install,
    );
    const cert = new X509Certificate(env.find((e) => e.name === 'CERT')!.value);
    expect(cert.subject).toBe('CN=harbor-ab12');
  });

  it('writes the certificate as base64 of its PEM when asked, for a value inside JSON', () => {
    const env = processor().resolveEnv(
      [
        { name: 'KEY', valueFrom: { generate: 'rsa-private-key', bits: 2048 } },
        {
          name: 'CERT',
          valueFrom: { certificateFor: 'KEY', encoding: 'base64' },
        },
      ],
      install,
    );
    const value = env.find((e) => e.name === 'CERT')!.value;
    expect(value).toMatch(/^[A-Za-z0-9+/=]+$/);
    const cert = new X509Certificate(Buffer.from(value, 'base64').toString());
    expect(cert.subject).toBe('CN=harbor-ab12');
  });

  it('gives each install its own key', () => {
    const spec: CatalogEnvVar[] = [
      { name: 'KEY', valueFrom: { generate: 'rsa-private-key', bits: 2048 } },
    ];
    const [a] = processor().resolveEnv(spec, install);
    const [b] = processor().resolveEnv(spec, install);
    expect(a.value).not.toBe(b.value);
  });
});

describe('a hashed secret in a catalog install', () => {
  it('hashes the generated secret it names with bcrypt', () => {
    const env = processor().resolveEnv(
      [
        { name: 'HASH', valueFrom: { bcryptOf: 'PASSWORD' } },
        { name: 'PASSWORD', valueFrom: { generate: 'secret', length: 32 } },
      ],
      install,
    );
    const byName = Object.fromEntries(env.map((e) => [e.name, e]));
    expect(byName.HASH.value).toMatch(/^\$2[aby]\$10\$/);
    expect(bcrypt.compareSync(byName.PASSWORD.value, byName.HASH.value)).toBe(
      true,
    );
    expect(byName.HASH.secret).toBe(true);
  });
});

describe('a component a previous run already created', () => {
  it('lends later components the values it was created with', () => {
    const env = processor().persistedEnv({
      env: [
        { name: 'POSTGRES_PASSWORD', value: 'enc:first-run', secret: true },
        { name: 'POSTGRES_USER', value: 'harbor' },
        { name: 'LEGACY', value: 'plain', secret: true },
        {
          name: 'FROM_BLOCK',
          value: '',
          externalSecretRef: { name: 'x', key: 'y' },
        },
      ],
    });
    expect(env).toEqual({
      POSTGRES_PASSWORD: 'first-run',
      POSTGRES_USER: 'harbor',
      LEGACY: 'plain',
    });
  });
});

describe('a config file of a composed component', () => {
  const ctx = {
    app: { id: 'harbor-ab12', slug: 'harbor-ab12', namespace: 'user-x' },
    env: { SECRET: 'no' },
    self: { host: 'harbor-ab12-proxy-svc', env: { SECRET: 'no' } },
    components: {
      core: { host: 'harbor-ab12-core-svc', env: { CORE_SECRET: 's3cr3t' } },
    },
  };

  it('names the addresses of its siblings', () => {
    const [file] = processor().renderConfigFiles(
      [
        {
          path: '/etc/nginx/nginx.conf',
          content:
            'proxy_pass http://{{components.core.host}}:8080; # {{self.host}}',
        },
      ],
      ctx,
    );
    expect(file.content).toBe(
      'proxy_pass http://harbor-ab12-core-svc:8080; # harbor-ab12-proxy-svc',
    );
  });

  it('cannot read a variable', () => {
    expect(() =>
      processor().renderConfigFiles(
        [{ path: '/x', content: '{{components.core.env.CORE_SECRET}}' }],
        ctx,
      ),
    ).toThrow('could not be resolved');
  });
});
