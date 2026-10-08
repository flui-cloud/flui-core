jest.mock('@kubernetes/client-node', () => ({}));

import { K3sScriptService } from './k3s-script.service';
import { getFirewallRulesForClusterType } from '../../firewalls/templates/firewall-rules.template';

const rulesetOf = (script: string): string => {
  const b64 =
    /echo '([A-Za-z0-9+/=]+)' \| base64 -d > \/etc\/flui\/flui-firewall\.nft/.exec(
      script,
    )?.[1];
  return b64 ? Buffer.from(b64, 'base64').toString('utf-8') : '';
};

const hostFirewall = {
  rules: getFirewallRulesForClusterType('workload', ['0.0.0.0/0', '::/0']),
  internalCidrs: [
    '10.42.0.0/16',
    '10.43.0.0/16',
    '10.0.1.0/24',
    '203.0.113.7/32',
  ],
};

const base = {
  clusterId: 'c1',
  clusterName: 'wc',
  k3sToken: 't',
  instanceId: 'wc-master',
  instanceName: 'wc-master',
  provider: 'ovh',
};

describe('the host firewall a node boots with', () => {
  it('is applied on the master before k3s is downloaded', async () => {
    const script = await new K3sScriptService().generateMasterScript({
      ...base,
      hostFirewall,
    });
    const applied = script.indexOf('Applying host firewall');
    expect(applied).toBeGreaterThan(-1);
    expect(applied).toBeLessThan(
      script.indexOf('Downloading k3s-master-init.sh'),
    );
  });

  it('is applied on a worker before it joins', async () => {
    const script = await new K3sScriptService().generateWorkerScript({
      ...base,
      instanceId: 'wc-worker-1',
      instanceName: 'wc-worker-1',
      masterIp: '10.0.1.2',
      hostFirewall,
    });
    expect(script.indexOf('Applying host firewall')).toBeLessThan(
      script.indexOf('Downloading k3s-worker-init.sh'),
    );
  });

  it('opens only the public ports, and the cluster to its own networks and peers', async () => {
    const ruleset = rulesetOf(
      await new K3sScriptService().generateMasterScript({
        ...base,
        hostFirewall,
      }),
    );
    expect(ruleset).toContain('policy drop');
    expect(ruleset).toContain('tcp dport 443 accept');
    expect(ruleset).toContain('ip saddr 10.0.1.0/24 accept');
    expect(ruleset).toContain('ip saddr 203.0.113.7/32 accept');
    expect(ruleset).not.toMatch(/^\s*tcp dport 6443 accept/m);
  });

  it('is left out where the provider firewalls the node before it exists', async () => {
    const script = await new K3sScriptService().generateMasterScript({
      ...base,
      provider: 'hetzner',
    });
    expect(script).not.toContain('Applying host firewall');
  });
});
