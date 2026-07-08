import { Injectable } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { CertificateProvider } from '../enums/certificate-provider.enum';
import { DnsProvider } from '../enums/dns-provider.enum';
import {
  ICertificateProvider,
  CertificateIssuerConfig,
  CertificateManifestConfig,
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
  secretKey: string;
}

const DNS01_WEBHOOK_CONFIGS: Record<string, Dns01WebhookConfig> = {
  [DnsProvider.HETZNER]: {
    groupName: 'acme.hetzner.com',
    solverName: 'hetzner',
    secretName: 'hetzner-secret',
    secretKey: 'token',
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

  generateCombinedClusterIssuerManifest(
    config: CertificateIssuerConfig & {
      zoneNames: string[];
      dnsProvider: DnsProvider;
    },
  ): string {
    const issuerName = this.getWildcardIssuerName(config.server);
    const webhookConfig = this.getDns01WebhookConfig(config.dnsProvider);
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
    const dnsZonesBlock = config.zoneNames
      .map((zone) => `            - "${zone}"`)
      .join('\n');
    return template
      .replaceAll('{{ISSUER_NAME}}', issuerName)
      .replaceAll('{{ACME_SERVER}}', config.server)
      .replaceAll('{{ACME_EMAIL}}', config.email)
      .replaceAll('{{PRIVATE_KEY_SECRET_REF}}', `${issuerName}-key`)
      .replaceAll('{{DNS_ZONES}}', dnsZonesBlock)
      .replaceAll('{{WEBHOOK_GROUP_NAME}}', webhookConfig.groupName)
      .replaceAll('{{WEBHOOK_SOLVER_NAME}}', webhookConfig.solverName)
      .replaceAll('{{WEBHOOK_SECRET_NAME}}', webhookConfig.secretName)
      .replaceAll('{{WEBHOOK_SECRET_KEY}}', webhookConfig.secretKey);
  }

  generateDns01ClusterIssuerManifest(
    config: CertificateIssuerConfig & {
      zoneName: string;
      dnsProvider: DnsProvider;
    },
  ): string {
    const issuerName = this.getIssuerName(config.server);
    const webhookConfig = this.getDns01WebhookConfig(config.dnsProvider);
    const template = readFileSync(
      getProjectPath(
        'src',
        'modules',
        'dns',
        'templates',
        'cluster-issuer-dns01.yaml',
      ),
      'utf-8',
    );
    return template
      .replaceAll('{{ISSUER_NAME}}', issuerName)
      .replaceAll('{{ACME_SERVER}}', config.server)
      .replaceAll('{{ACME_EMAIL}}', config.email)
      .replaceAll('{{PRIVATE_KEY_SECRET_REF}}', config.privateKeySecretRef)
      .replaceAll('{{ZONE_NAME}}', config.zoneName)
      .replaceAll('{{WEBHOOK_GROUP_NAME}}', webhookConfig.groupName)
      .replaceAll('{{WEBHOOK_SOLVER_NAME}}', webhookConfig.solverName)
      .replaceAll('{{WEBHOOK_SECRET_NAME}}', webhookConfig.secretName)
      .replaceAll('{{WEBHOOK_SECRET_KEY}}', webhookConfig.secretKey);
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

  generateDnsTokenSecretManifest(
    token: string,
    dnsProvider: DnsProvider,
  ): string {
    const webhookConfig = this.getDns01WebhookConfig(dnsProvider);
    const secret = {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: webhookConfig.secretName,
        namespace: 'cert-manager',
        labels: { 'managed-by': 'flui-cloud' },
      },
      stringData: {
        [webhookConfig.secretKey]: token,
      },
    };
    return JSON.stringify(secret);
  }

  getDns01WebhookConfig(dnsProvider: DnsProvider): Dns01WebhookConfig {
    const config = DNS01_WEBHOOK_CONFIGS[dnsProvider];
    if (!config) {
      throw new Error(
        `DNS-01 webhook is not supported for provider "${dnsProvider}". ` +
          `Supported providers: ${Object.keys(DNS01_WEBHOOK_CONFIGS).join(', ')}`,
      );
    }
    return config;
  }
}
