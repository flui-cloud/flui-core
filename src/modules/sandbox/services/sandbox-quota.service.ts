import { Injectable, Logger } from '@nestjs/common';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import {
  buildSandboxQuotaManifests,
  DEFAULT_SANDBOX_QUOTA,
  SandboxQuota,
} from '../constants/sandbox-quota.manifest';

@Injectable()
export class SandboxQuotaService {
  private readonly logger = new Logger(SandboxQuotaService.name);

  constructor(private readonly k8s: KubernetesService) {}

  async apply(
    kubeconfig: string,
    namespace: string,
    quota: SandboxQuota = DEFAULT_SANDBOX_QUOTA,
  ): Promise<void> {
    await this.k8s.applyManifest(
      kubeconfig,
      buildSandboxQuotaManifests(namespace, quota),
    );
    this.logger.log(`Sandbox quota applied to namespace ${namespace}`);
  }
}
