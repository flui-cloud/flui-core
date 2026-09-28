jest.mock('@kubernetes/client-node', () => ({}));

import { K3sScriptService, nfsAllowedNetworks } from './k3s-script.service';

const exported = (script: string, key: string): string | undefined =>
  new RegExp(`^export ${key}='([^']*)'$`, 'm').exec(script)?.[1];

const masterScript = (
  sharedStorage?: { enabled: boolean; privateNetworks?: string[] },
  envVnet?: { subnetIpRange: string },
) =>
  new K3sScriptService().generateMasterScript({
    clusterId: 'c1',
    clusterName: 'wc',
    k3sToken: 't',
    instanceId: 'wc-master',
    instanceName: 'wc-master',
    provider: 'hetzner',
    sharedStorage,
    envVnet: envVnet
      ? {
          vnetProviderResourceId: '',
          vnetProvider: '',
          vnetName: '',
          vnetIpRange: '',
          subnetProviderResourceId: '',
          subnetType: '',
          networkZone: '',
          ...envVnet,
        }
      : undefined,
  });

describe('the networks the shared volume is exported to', () => {
  it('offers it to the private subnet and the internal pod range', () => {
    expect(nfsAllowedNetworks(['10.0.1.0/24'])).toBe(
      '10.0.1.0/24,10.42.0.0/16',
    );
  });

  it('offers it to no one when the cluster has no private network', () => {
    expect(nfsAllowedNetworks()).toBe('');
    expect(nfsAllowedNetworks([])).toBe('');
    expect(nfsAllowedNetworks(['', '  '])).toBe('');
  });

  it('never widens to anyone, whatever it is given', () => {
    expect(nfsAllowedNetworks(['0.0.0.0/0', '::/0', '*'])).toBe('');
    expect(nfsAllowedNetworks(['0.0.0.0/0', '172.16.0.0/22'])).toBe(
      '172.16.0.0/22,10.42.0.0/16',
    );
  });

  it('lists each network once', () => {
    expect(nfsAllowedNetworks(['10.0.1.0/24', '10.0.1.0/24'])).toBe(
      '10.0.1.0/24,10.42.0.0/16',
    );
  });

  it('is written into the master script from the cluster subnet', async () => {
    const script = await masterScript({
      enabled: true,
      privateNetworks: ['10.0.1.0/24'],
    });
    expect(exported(script, 'FLUI_NFS_ALLOWED_NETWORKS')).toBe(
      '10.0.1.0/24,10.42.0.0/16',
    );
  });

  it('also takes the environment subnet the control is built on', async () => {
    const script = await masterScript(
      { enabled: true },
      { subnetIpRange: '10.1.0.0/24' },
    );
    expect(exported(script, 'FLUI_NFS_ALLOWED_NETWORKS')).toBe(
      '10.1.0.0/24,10.42.0.0/16',
    );
  });

  it('is exported empty rather than open when nothing is known', async () => {
    const script = await masterScript({ enabled: true });
    expect(exported(script, 'FLUI_NFS_ALLOWED_NETWORKS')).toBe('');
  });
});
