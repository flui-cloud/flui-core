import { Injectable } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { CertificateProvider } from '../enums/certificate-provider.enum';
import { DnsProvider } from '../enums/dns-provider.enum';
import {
  ICertificateProvider,
  CertificateIssuerConfig,
  CertificateManifestConfig,
  Dns01Credential,
  Dns01SolverSpec,
} from '../interfaces/certificate-provider.interface';
import { getProjectPath } from '../../../common/utils/project-root.util';

const ACME_SERVERS: Record<string, string> = {
  [CertificateProvider.LETS_ENCRYPT]:
    'https://acme-v02.api.letsencrypt.org/directory',
  [CertificateProvider.LETS_ENCRYPT_STAGING]:
    'https://acme-staging-v02.api.letsencrypt.org/directory',
};

interface Dns01WebhookConfig {
  groupName: string;
  solverName: string;
  secretName: string;
  /**
   * Shape of the credential the webhook expects. It drives both the keys of
   * the Secret we write and the `config` block of the dns01 solver, which
   * differ per webhook (Hetzner takes a single token, Scaleway a key pair).
   */
  credential:
    | { kind: 'api_token'; tokenKey: string }
    | { kind: 'access_key_pair'; accessKeyKey: string; secretKeyKey: string };
}

const DNS01_WEBHOOK_CONFIGS: Partial<Record<DnsProvider, Dns01WebhookConfig>> =
  {
    [DnsProvider.HETZNER]: {
      groupName: 'acme.hetzner.com',
      solverName: 'hetzner',
      secretName: 'hetzner-secret',
      credential: { kind: 'api_token', tokenKey: 'token' },
    },
    [DnsProvider.SCALEWAY]: {
      groupName: 'acme.scaleway.com',
      solverName: 'scaleway',
      secretName: 'scaleway-secret',
      credential: {
        kind: 'access_key_pair',
        accessKeyKey: 'SCW_ACCESS_KEY',
        secretKeyKey: 'SCW_SECRET_KEY',
      },
    },
  };

@Injectable()
export class AcmeCertificateService implements ICertificateProvider {
  generateClusterIssuerManifest(config: CertificateIssuerConfig): string {
    const issuerName = this.getIssuerName(config.server);
    const template = readFileSync(
      getProjectPath(
        'src',
        'modules',
        'dns',
        'templates',
        'cluster-issuer.yaml',
      ),
      'utf-8',
    );
    return template
      .replaceAll('{{ISSUER_NAME}}', issuerName)
      .replaceAll('{{ACME_SERVER}}', config.server)
      .replaceAll('{{ACME_EMAIL}}', config.email)
      .replaceAll('{{PRIVATE_KEY_SECRET_REF}}', config.privateKeySecretRef);
  }

  generateCertificateManifest(config: CertificateManifestConfig): string {
    const template = readFileSync(
      getProjectPath('src', 'modules', 'dns', 'templates', 'certificate.yaml'),
      'utf-8',
    );
    const dnsNamesYaml = config.domains
      .map((d, i) => (i === 0 ? `- ${d}` : `    - ${d}`))
      .join('\n');
    return template
      .replaceAll('{{CERT_NAME}}', config.name)
      .replaceAll('{{NAMESPACE}}', config.namespace)
      .replaceAll('{{SECRET_NAME}}', config.secretName)
      .replaceAll('{{ISSUER_NAME}}', config.issuerName)
      .replaceAll('{{DNS_NAMES}}', dnsNamesYaml);
  }

  validateConfiguration(config: CertificateIssuerConfig): {
    valid: boolean;
    errors: string[];
  } {
    const errors: string[] = [];

    if (!config.email?.includes('@')) {
      errors.push('A valid email address is required for ACME registration');
    }

    if (!config.server) {
      errors.push('ACME server URL is required');
    }

    if (!config.privateKeySecretRef) {
      errors.push('Private key secret reference is required');
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  getAcmeServerUrl(provider: CertificateProvider): string {
    return (
      ACME_SERVERS[provider] ?? ACME_SERVERS[CertificateProvider.LETS_ENCRYPT]
    );
  }

  getIssuerName(server: string): string {
    if (server.includes('staging')) {
      return 'letsencrypt-staging';
    }
    return 'letsencrypt-production';
  }

  getWildcardIssuerName(server: string): string {
    return `${this.getIssuerName(server)}-wildcard`;
  }

  /**
   * Wildcard ClusterIssuer covering zones across several DNS providers: one
   * dns01 solver per provider, each selecting its own zones, plus the
   * selector-less http01 solver as catch-all. cert-manager picks the most
   * specific matching solver, so a zone-selected dns01 solver always wins over
   * the catch-all for its own zones.
   */
  generateCombinedClusterIssuerManifest(config: {
    email: string;
    server: string;
    solvers: Dns01SolverSpec[];
  }): string {
    if (config.solvers.length === 0) {
      throw new Error(
        'A wildcard ClusterIssuer needs at least one dns01 solver',
      );
    }
    const issuerName = this.getWildcardIssuerName(config.server);
    const template = readFileSync(
      getProjectPath(
        'src',
        'modules',
        'dns',
        'templates',
        'cluster-issuer-combined.yaml',
      ),
      'utf-8',
    );
    const solversBlock = config.solvers
      .map((solver) => this.renderDns01Solver(solver))
      .join('\n');
    return template
      .replaceAll('{{ISSUER_NAME}}', issuerName)
      .replaceAll('{{ACME_SERVER}}', config.server)
      .replaceAll('{{ACME_EMAIL}}', config.email)
      .replaceAll('{{PRIVATE_KEY_SECRET_REF}}', `${issuerName}-key`)
      .replaceAll('{{DNS01_SOLVERS}}', solversBlock);
  }

  private renderDns01Solver(solver: Dns01SolverSpec): string {
    const webhook = this.getDns01WebhookConfig(solver.dnsProvider);
    const configBlock =
      webhook.credential.kind === 'api_token'
        ? [
            '              tokenSecretKeyRef:',
            `                name: ${webhook.secretName}`,
            `                key: ${webhook.credential.tokenKey}`,
          ]
        : [
            '              accessKeySecretRef:',
            `                name: ${webhook.secretName}`,
            `                key: ${webhook.credential.accessKeyKey}`,
            '              secretKeySecretRef:',
            `                name: ${webhook.secretName}`,
            `                key: ${webhook.credential.secretKeyKey}`,
          ];
    return [
      '      - dns01:',
      '          webhook:',
      `            groupName: ${webhook.groupName}`,
      `            solverName: ${webhook.solverName}`,
      '            config:',
      ...configBlock,
      '        selector:',
      '          dnsZones:',
      ...solver.zoneNames.map((zone) => `            - "${zone}"`),
    ].join('\n');
  }

  generateWildcardCertificateManifest(config: {
    name: string;
    namespace: string;
    secretName: string;
    issuerName: string;
    zoneName: string;
  }): string {
    const template = readFileSync(
      getProjectPath(
        'src',
        'modules',
        'dns',
        'templates',
        'wildcard-certificate.yaml',
      ),
      'utf-8',
    );
    return template
      .replaceAll('{{CERT_NAME}}', config.name)
      .replaceAll('{{NAMESPACE}}', config.namespace)
      .replaceAll('{{SECRET_NAME}}', config.secretName)
      .replaceAll('{{ISSUER_NAME}}', config.issuerName)
      .replaceAll('{{ZONE_NAME}}', config.zoneName);
  }

  generateDnsCredentialSecretManifest(
    dnsProvider: DnsProvider,
    credential: Dns01Credential,
  ): string {
    const webhookConfig = this.getDns01WebhookConfig(dnsProvider);
    if (webhookConfig.credential.kind !== credential.kind) {
      throw new Error(
        `DNS-01 webhook for "${dnsProvider}" expects a ${webhookConfig.credential.kind} credential, got ${credential.kind}`,
      );
    }
    let stringData: Record<string, string> = {};
    if (
      webhookConfig.credential.kind === 'api_token' &&
      credential.kind === 'api_token'
    ) {
      stringData = { [webhookConfig.credential.tokenKey]: credential.token };
    } else if (
      webhookConfig.credential.kind === 'access_key_pair' &&
      credential.kind === 'access_key_pair'
    ) {
      stringData = {
        [webhookConfig.credential.accessKeyKey]: credential.accessKey,
        [webhookConfig.credential.secretKeyKey]: credential.secretKey,
      };
    }
    const secret = {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: webhookConfig.secretName,
        namespace: 'cert-manager',
        labels: { 'managed-by': 'flui-cloud' },
      },
      stringData,
    };
    return JSON.stringify(secret);
  }

  /** DNS providers Flui can solve DNS-01 challenges for. */
  listDns01Providers(): DnsProvider[] {
    return Object.keys(DNS01_WEBHOOK_CONFIGS) as DnsProvider[];
  }

  supportsDns01(dnsProvider: DnsProvider): boolean {
    return DNS01_WEBHOOK_CONFIGS[dnsProvider] !== undefined;
  }

  getDns01WebhookConfig(dnsProvider: DnsProvider): Dns01WebhookConfig {
    const config = DNS01_WEBHOOK_CONFIGS[dnsProvider];
    if (!config) {
      throw new Error(
        `DNS-01 webhook is not supported for provider "${dnsProvider}". ` +
          `Supported providers: ${this.listDns01Providers().join(', ')}`,
      );
    }
    return config;
  }
}
