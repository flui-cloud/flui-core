jest.mock('@kubernetes/client-node', () => ({}));

import {
  K3sScriptService,
  K3sWorkerConfig,
  topologyEnv,
} from './k3s-script.service';

const worker: K3sWorkerConfig = {
  clusterId: 'c1',
  clusterName: 'lab',
  masterIp: '10.0.0.2',
  instanceId: 'lab-worker-1',
  instanceName: 'lab-worker-1',
  provider: 'hetzner',
  k3sToken: 'token',
};

describe('the topology a bootstrap script hands the node', () => {
  it('is the zone and region the provider declares', () => {
    expect(topologyEnv({ zone: 'nbg1', region: 'eu-central' })).toEqual({
      FLUI_NODE_ZONE: 'nbg1',
      FLUI_NODE_REGION: 'eu-central',
    });
  });

  /** A node of a provider that declares nothing joins exactly as it did before labels existed. */
  it('is empty when the provider declares none', () => {
    expect(topologyEnv(null)).toEqual({
      FLUI_NODE_ZONE: '',
      FLUI_NODE_REGION: '',
    });
    expect(topologyEnv()).toEqual({
      FLUI_NODE_ZONE: '',
      FLUI_NODE_REGION: '',
    });
  });

  it('reaches the worker script as exported variables', async () => {
    const script = await new K3sScriptService().generateWorkerScript({
      ...worker,
      topology: { zone: 'nbg1', region: 'eu-central' },
    });
    expect(script).toContain("export FLUI_NODE_ZONE='nbg1'");
    expect(script).toContain("export FLUI_NODE_REGION='eu-central'");
  });

  it('exports empty values for a worker with no declared topology', async () => {
    const script = await new K3sScriptService().generateWorkerScript(worker);
    expect(script).toContain("export FLUI_NODE_ZONE=''");
    expect(script).toContain("export FLUI_NODE_REGION=''");
  });

  it('carries no token and no master for a server bought to join later', async () => {
    const script = await new K3sScriptService().generateWorkerScript({
      ...worker,
      k3sRole: 'server',
      joinLater: true,
    });
    expect(script).toContain("export FLUI_K3S_JOIN='later'");
    expect(script).toContain("export K3S_TOKEN=''");
    expect(script).toContain("export K3S_URL=''");
    expect(script).toContain("export MASTER_IP=''");
    expect(script).not.toContain('token');
    expect(await new K3sScriptService().generateWorkerScript(worker)).toContain(
      "export FLUI_K3S_JOIN='now'",
    );
  });

  it('joins a server to the control plane only when asked, an agent otherwise', async () => {
    const service = new K3sScriptService();
    expect(
      await service.generateWorkerScript({ ...worker, k3sRole: 'server' }),
    ).toContain("export FLUI_K3S_ROLE='server'");
    expect(await service.generateWorkerScript(worker)).toContain(
      "export FLUI_K3S_ROLE='agent'",
    );
  });
});
