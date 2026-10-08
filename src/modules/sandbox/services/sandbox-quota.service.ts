import { Inject, Injectable, Logger } from '@nestjs/common';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import {
  buildSandboxQuotaManifests,
  SandboxQuota,
} from '../constants/sandbox-quota.manifest';
import { SANDBOX_CONFIG, SandboxConfig } from '../sandbox.config';

@Injectable()
export class SandboxQuotaService {
  private readonly logger = new Logger(SandboxQuotaService.name);

  constructor(
    private readonly k8s: KubernetesService,
    @Inject(SANDBOX_CONFIG) private readonly config: SandboxConfig,
  ) {}

  async apply(
    kubeconfig: string,
    namespace: string,
    quota: SandboxQuota = this.config.quota,
  ): Promise<void> {
    await this.k8s.applyManifest(
      kubeconfig,
      buildSandboxQuotaManifests(namespace, quota),
    );
    this.logger.log(`Sandbox quota applied to namespace ${namespace}`);
  }
}
