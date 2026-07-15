import { Injectable, Logger } from '@nestjs/common';
import { CliSshService } from './cli-ssh.service';

export interface ByosPurgeTarget {
  host: string;
  port: number;
  user: string;
  keyPath: string;
}

export interface ByosPurgeOptions {
  removeAccess: boolean;
  onData?: (chunk: string) => void;
}

export interface ByosPurgeResult {
  warnings: string[];
}

/**
 * BYOS host teardown, driven from the CLI over SSH because purging the control
 * host tears down the API itself — it cannot uninstall itself. Tier 1 leaves
 * SSH trust (reinstall-ready); `removeAccess` also strips the CA/managed key and
 * re-enables password login so the operator is never locked out.
 */
@Injectable()
export class CliByosPurgeService {
  private readonly logger = new Logger(CliByosPurgeService.name);

  constructor(private readonly sshService: CliSshService) {}

  buildScript(removeAccess: boolean, managedPublicKey: string | null): string {
    const tier1 = [
      'set +e',
      'echo FLUI_PURGE_START',
      'if [ -x /usr/local/bin/k3s-uninstall.sh ]; then',
      '  echo "[flui-purge] uninstalling k3s server..."',
      '  /usr/local/bin/k3s-uninstall.sh',
      'elif [ -x /usr/local/bin/k3s-agent-uninstall.sh ]; then',
      '  echo "[flui-purge] uninstalling k3s agent..."',
      '  /usr/local/bin/k3s-agent-uninstall.sh',
      'else',
      '  echo "[flui-purge] no k3s uninstall script (already removed?)"',
      'fi',
      'NFT=$(command -v nft || echo /usr/sbin/nft)',
      '"$NFT" delete table inet flui 2>/dev/null && echo "[flui-purge] nft table flui removed" || true',
      'systemctl disable --now flui-firewall.service 2>/dev/null || true',
      'rm -f /etc/systemd/system/flui-firewall.service',
      'for svc in node-exporter vector; do',
      '  systemctl disable --now "$svc" 2>/dev/null || true',
      '  rm -f /etc/systemd/system/"$svc".service',
      'done',
      'systemctl daemon-reload 2>/dev/null || true',
      'rm -f /usr/local/bin/node_exporter /usr/local/bin/vector',
      'userdel node_exporter 2>/dev/null || true',
      'rm -rf /var/log/flui /etc/vector /var/lib/vector /var/log/vector',
      'echo "[flui-purge] monitoring agents removed"',
      'if [ -f /etc/exports ]; then',
      String.raw`  sed -i '\|^/var/lib/flui/storage |d' /etc/exports`,
      '  exportfs -ra 2>/dev/null || true',
      'fi',
      // This path may be a mounted shared-storage Volume holding in-cluster
      // Postgres data — wipe+unmount explicitly so `rm -rf` below doesn't just
      // silently traverse into it and leave orphaned data behind.
      'if mountpoint -q /var/lib/flui/storage 2>/dev/null; then',
      '  echo "[flui-purge] wiping shared-storage volume contents..."',
      '  find /var/lib/flui/storage -mindepth 1 -delete 2>/dev/null || true',
      '  umount /var/lib/flui/storage 2>/dev/null || true',
      '  echo "[flui-purge] shared-storage volume wiped and unmounted"',
      'fi',
      'rm -rf /var/lib/flui /tmp/flui-modules /etc/flui',
      'rm -f /root/.kube/config',
      String.raw`sed -i '\|/etc/rancher/k3s/k3s.yaml|d' /root/.bashrc 2>/dev/null || true`,
      'echo "[flui-purge] data and kubeconfig removed"',
      'echo FLUI_PURGE_TIER1_DONE',
    ];

    if (!removeAccess) return tier1.join('\n') + '\n';

    const tier2 = [
      'rm -f /etc/ssh/trusted_user_ca_keys',
      String.raw`sed -i '\|^TrustedUserCAKeys /etc/ssh/trusted_user_ca_keys|d' /etc/ssh/sshd_config`,
      "sed -i 's/^PasswordAuthentication no/PasswordAuthentication yes/' /etc/ssh/sshd_config",
    ];
    if (managedPublicKey) {
      tier2.push(
        'if [ -f "$HOME/.ssh/authorized_keys" ]; then',
        `  grep -vxF '${managedPublicKey}' "$HOME/.ssh/authorized_keys" > "$HOME/.ssh/authorized_keys.flui-tmp" && mv "$HOME/.ssh/authorized_keys.flui-tmp" "$HOME/.ssh/authorized_keys"`,
        'fi',
      );
    }
    tier2.push(
      'systemctl reload sshd 2>/dev/null || systemctl reload ssh 2>/dev/null || true',
      'echo "[flui-purge] SSH trust removed; password login re-enabled"',
      'echo FLUI_PURGE_TIER2_DONE',
    );
    return [...tier1, ...tier2].join('\n') + '\n';
  }

  async purgeHost(
    target: ByosPurgeTarget,
    opts: ByosPurgeOptions,
  ): Promise<ByosPurgeResult> {
    const warnings: string[] = [];
    const managedPublicKey = opts.removeAccess
      ? await this.managedPublicKeyOrNull()
      : null;
    const script = this.buildScript(opts.removeAccess, managedPublicKey);

    let output = '';
    const sink = (chunk: string): void => {
      output += chunk;
      opts.onData?.(chunk);
    };

    try {
      await this.sshService.runScriptWithKey({
        host: target.host,
        port: target.port,
        user: target.user,
        keyPath: target.keyPath,
        script,
        onData: sink,
      });
    } catch (e) {
      throw new Error(
        `Could not reach ${target.user}@${target.host}:${target.port} to purge: ${(e as Error).message}`,
      );
    }

    if (!output.includes('FLUI_PURGE_TIER1_DONE')) {
      warnings.push(
        'host teardown did not confirm completion — inspect the output above',
      );
    }
    if (opts.removeAccess && !output.includes('FLUI_PURGE_TIER2_DONE')) {
      warnings.push('SSH-trust removal did not confirm completion');
    }
    return { warnings };
  }

  private async managedPublicKeyOrNull(): Promise<string | null> {
    try {
      return await this.sshService.getPublicKey();
    } catch {
      return null;
    }
  }
}
