jest.mock('@flui-cloud/infra', () => ({
  OvhProviderService: jest.fn(),
  packRegionId: jest.fn(),
  parseRegionId: jest.fn(),
}));
jest.mock('./ovh-openstack-client.factory', () => ({
  buildOvhOpenStackClient: jest.fn().mockResolvedValue({}),
}));

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Logger } from '@nestjs/common';
import {
  OvhProviderService as InfraOvhProviderService,
  parseRegionId,
} from '@flui-cloud/infra';
import { buildOvhOpenStackClient } from './ovh-openstack-client.factory';
import {
  OvhProviderService,
  normalizeOvhServerStatus,
} from './ovh-provider.service';

describe('normalizeOvhServerStatus', () => {
  it('maps Nova ACTIVE to the common "running" ServersService.waitForServerReady polls for', () => {
    expect(normalizeOvhServerStatus('ACTIVE')).toBe('running');
  });

  it('maps Nova ERROR to the common "error"', () => {
    expect(normalizeOvhServerStatus('ERROR')).toBe('error');
  });

  it('lowercases any other Nova status rather than leaving it opaque uppercase', () => {
    expect(normalizeOvhServerStatus('BUILD')).toBe('build');
    expect(normalizeOvhServerStatus('SHUTOFF')).toBe('shutoff');
  });
});

describe('OvhProviderService.getServerStatus — not-found translation', () => {
  function build(getServerStatus: jest.Mock) {
    (InfraOvhProviderService as unknown as jest.Mock).mockImplementation(
      () => ({ getServerStatus }),
    );
    const credentialProvider = {
      getActiveAccessKeyPair: jest
        .fn()
        .mockResolvedValue({ accessKey: 'ak', secretKey: 'sk' }),
    };
    return new OvhProviderService({} as never, credentialProvider as never);
  }

  it('translates infra\'s "not found" throw into the "not-found" status string waitForDeletionComplete polls for', async () => {
    const service = build(
      jest.fn().mockRejectedValue(new Error('OVH server abc-123 not found.')),
    );

    await expect(service.getServerStatus('abc-123')).resolves.toBe('not-found');
  });

  it('re-throws any error that is not a "not found" — a transient failure must not look like a completed delete', async () => {
    const service = build(
      jest.fn().mockRejectedValue(new Error('OVH API unreachable')),
    );

    await expect(service.getServerStatus('abc-123')).rejects.toThrow(
      'OVH API unreachable',
    );
  });

  it('normalizes a real status when the call succeeds', async () => {
    const service = build(jest.fn().mockResolvedValue('ACTIVE'));

    await expect(service.getServerStatus('abc-123')).resolves.toBe('running');
  });
});

describe('OvhProviderService.createServer — post-boot network attach', () => {
  it('reboots only when the console confirms the guest actually hit the NIC race', async () => {
    jest.useFakeTimers();
    try {
      const attachServerInterface = jest.fn().mockResolvedValue(undefined);
      const rebootServer = jest.fn().mockResolvedValue(undefined);
      const resolveComputeRegion = jest.fn().mockResolvedValue('GRA11');
      const getConsoleOutput = jest
        .fn()
        .mockResolvedValue(
          "Cloud-init v. 24.4 running 'init' at Sat, 12 Sep 2026 21:25:31 +0000.\ncloud-init[593]: Traceback...\nValueError: Unable to find a system nic for {'mac': 'x'}",
        );
      (buildOvhOpenStackClient as jest.Mock).mockResolvedValue({
        resolveComputeRegion,
        attachServerInterface,
        rebootServer,
        getConsoleOutput,
      });
      (parseRegionId as jest.Mock).mockReturnValue({ id: 'net-1' });
      (InfraOvhProviderService as unknown as jest.Mock).mockImplementation(
        () => ({
          createServer: jest.fn().mockResolvedValue({
            serverId: 'srv-1',
            ipAddress: '1.2.3.4',
            status: 'ACTIVE',
          }),
          getServerDetailsAsDto: jest.fn().mockResolvedValue({
            status: 'ACTIVE',
            public_ip: '1.2.3.4',
            private_ip: '10.0.0.5',
          }),
        }),
      );
      const credentialProvider = {
        getActiveAccessKeyPair: jest
          .fn()
          .mockResolvedValue({ accessKey: 'ak', secretKey: 'sk' }),
      };
      const service = new OvhProviderService(
        {} as never,
        credentialProvider as never,
      );

      const resultPromise = service.createServer({
        name: 'workload-2-master',
        networks: ['region:net-1'],
      } as never);
      // pollForNicRaceOutcome's first console check fires after one
      // pollIntervalMs (5s); the crash signature is there from that first
      // check, so it resolves immediately — then the existing 5s
      // post-reboot settle delay runs before waitForServerActive.
      await jest.advanceTimersByTimeAsync(5_000);
      await jest.advanceTimersByTimeAsync(5_000);
      const result = await resultPromise;

      expect(attachServerInterface).toHaveBeenCalledWith(
        'GRA11',
        'srv-1',
        'net-1',
      );
      expect(getConsoleOutput).toHaveBeenCalledWith('GRA11', 'srv-1', 500);
      expect(rebootServer).toHaveBeenCalledWith('GRA11', 'srv-1');
      expect(rebootServer.mock.invocationCallOrder[0]).toBeGreaterThan(
        attachServerInterface.mock.invocationCallOrder[0],
      );
      expect(result.privateIp).toBe('10.0.0.5');
    } finally {
      jest.useRealTimers();
    }
  });

  it('does NOT reboot when the console shows cloud-init finished cleanly — a guest bootstrap script may already be running', async () => {
    jest.useFakeTimers();
    try {
      const attachServerInterface = jest.fn().mockResolvedValue(undefined);
      const rebootServer = jest.fn().mockResolvedValue(undefined);
      const getConsoleOutput = jest
        .fn()
        .mockResolvedValue(
          "Cloud-init v. 26.1 running 'init' at Sat, 12 Sep 2026 21:25:31 +0000.\nCloud-init v. 26.1 finished at Sat, 12 Sep 2026 21:25:50 +0000. Datasource DataSourceOpenStackLocal [net,ver=2].",
        );
      (buildOvhOpenStackClient as jest.Mock).mockResolvedValue({
        resolveComputeRegion: jest.fn().mockResolvedValue('GRA11'),
        attachServerInterface,
        rebootServer,
        getConsoleOutput,
      });
      (parseRegionId as jest.Mock).mockReturnValue({ id: 'net-1' });
      (InfraOvhProviderService as unknown as jest.Mock).mockImplementation(
        () => ({
          createServer: jest.fn().mockResolvedValue({
            serverId: 'srv-1',
            ipAddress: '1.2.3.4',
            status: 'ACTIVE',
          }),
        }),
      );
      const credentialProvider = {
        getActiveAccessKeyPair: jest
          .fn()
          .mockResolvedValue({ accessKey: 'ak', secretKey: 'sk' }),
      };
      const service = new OvhProviderService(
        {} as never,
        credentialProvider as never,
      );

      const resultPromise = service.createServer({
        name: 'workload-2-master',
        networks: ['region:net-1'],
      } as never);
      await jest.advanceTimersByTimeAsync(5_000);
      await resultPromise;

      expect(getConsoleOutput).toHaveBeenCalled();
      expect(rebootServer).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('never reboots a server with no networks to attach (e.g. the control cluster)', async () => {
    const attachServerInterface = jest.fn();
    const rebootServer = jest.fn();
    (buildOvhOpenStackClient as jest.Mock).mockResolvedValue({
      resolveComputeRegion: jest.fn().mockResolvedValue('GRA11'),
      attachServerInterface,
      rebootServer,
    });
    (InfraOvhProviderService as unknown as jest.Mock).mockImplementation(
      () => ({
        createServer: jest.fn().mockResolvedValue({
          serverId: 'srv-1',
          ipAddress: '1.2.3.4',
          status: 'ACTIVE',
        }),
      }),
    );
    const credentialProvider = {
      getActiveAccessKeyPair: jest
        .fn()
        .mockResolvedValue({ accessKey: 'ak', secretKey: 'sk' }),
    };
    const service = new OvhProviderService(
      {} as never,
      credentialProvider as never,
    );

    await service.createServer({ name: 'control-master' } as never);

    expect(attachServerInterface).not.toHaveBeenCalled();
    expect(rebootServer).not.toHaveBeenCalled();
  });
});

describe('OvhProviderService.createServer — an instance the provider could not build', () => {
  const build = (fault?: { message?: string }) => {
    const getServer = jest.fn().mockResolvedValue(fault ? { fault } : {});
    (buildOvhOpenStackClient as jest.Mock).mockResolvedValue({
      resolveComputeRegion: jest.fn().mockResolvedValue('GRA11'),
      attachServerInterface: jest.fn(),
      getServer,
    });
    (parseRegionId as jest.Mock).mockReturnValue({ id: 'net-1' });
    (InfraOvhProviderService as unknown as jest.Mock).mockImplementation(
      () => ({
        createServer: jest.fn().mockResolvedValue({
          serverId: 'srv-1',
          status: 'BUILD',
        }),
        getServerDetailsAsDto: jest.fn().mockResolvedValue({ status: 'ERROR' }),
        deleteServer: jest.fn().mockResolvedValue(undefined),
      }),
    );
    const service = new OvhProviderService(
      {} as never,
      {
        getActiveAccessKeyPair: jest
          .fn()
          .mockResolvedValue({ accessKey: 'ak', secretKey: 'sk' }),
      } as never,
    );
    return service.createServer({
      name: 'wl-master',
      networks: ['region:net-1'],
    } as never);
  };

  it('gives up as soon as Nova says ERROR, instead of waiting out the deadline', async () => {
    // Polling to the deadline and attaching anyway surfaces the failure as
    // "cannot attach_interface while it is in vm_state error", which blames the
    // interface for a machine that was never built.
    await expect(build()).rejects.toThrow(/could not build the instance/i);
  });

  it('repeats the reason OVH gave, which the client type does not declare', async () => {
    await expect(
      build({ message: 'No valid host was found. ' }),
    ).rejects.toThrow(/No valid host was found/);
  });

  it('says what to change when the region is simply full', async () => {
    await expect(
      build({ message: 'No valid host was found.' }),
    ).rejects.toThrow(/another region, or a different node size/i);
  });

  it('still fails clearly when the reason cannot be read', async () => {
    (buildOvhOpenStackClient as jest.Mock).mockResolvedValue({
      resolveComputeRegion: jest.fn().mockResolvedValue('GRA11'),
      attachServerInterface: jest.fn(),
      getServer: jest.fn().mockRejectedValue(new Error('gone')),
    });
    (InfraOvhProviderService as unknown as jest.Mock).mockImplementation(
      () => ({
        createServer: jest
          .fn()
          .mockResolvedValue({ serverId: 'srv-1', status: 'BUILD' }),
        getServerDetailsAsDto: jest.fn().mockResolvedValue({ status: 'ERROR' }),
        deleteServer: jest.fn().mockResolvedValue(undefined),
      }),
    );
    const service = new OvhProviderService(
      {} as never,
      {
        getActiveAccessKeyPair: jest
          .fn()
          .mockResolvedValue({ accessKey: 'ak', secretKey: 'sk' }),
      } as never,
    );

    await expect(
      service.createServer({
        name: 'wl-master',
        networks: ['region:net-1'],
      } as never),
    ).rejects.toThrow(/could not build the instance/i);
  });
});

describe('OvhProviderService.createServer — waiting for the guest to boot before the attach', () => {
  const NET_STAGE =
    "Cloud-init v. 24.4 running 'init' at Sat, 13 Sep 2026 10:00:02 +0000.";
  const CLOUD_INIT_DONE =
    'Cloud-init v. 24.4 finished at Sat, 13 Sep 2026 10:00:20 +0000. Datasource DataSourceOpenStackLocal [net,ver=2].';

  function build(getConsoleOutput: jest.Mock) {
    const attachServerInterface = jest.fn().mockResolvedValue(undefined);
    (buildOvhOpenStackClient as jest.Mock).mockResolvedValue({
      resolveComputeRegion: jest.fn().mockResolvedValue('GRA11'),
      attachServerInterface,
      rebootServer: jest.fn().mockResolvedValue(undefined),
      getConsoleOutput,
    });
    (parseRegionId as jest.Mock).mockReturnValue({ id: 'net-1' });
    (InfraOvhProviderService as unknown as jest.Mock).mockImplementation(
      () => ({
        createServer: jest.fn().mockResolvedValue({
          serverId: 'srv-1',
          ipAddress: '1.2.3.4',
          status: 'ACTIVE',
        }),
      }),
    );
    const service = new OvhProviderService(
      {} as never,
      {
        getActiveAccessKeyPair: jest
          .fn()
          .mockResolvedValue({ accessKey: 'ak', secretKey: 'sk' }),
      } as never,
    );
    return { service, attachServerInterface };
  }

  const createWorkloadServer = (service: OvhProviderService) =>
    service.createServer({
      name: 'workload-2-master',
      networks: ['region:net-1'],
    } as never);

  it('holds the attach until the console shows the guest running — a NIC present at power-on boots with no addresses at all', async () => {
    jest.useFakeTimers();
    try {
      const getConsoleOutput = jest
        .fn()
        .mockResolvedValueOnce('')
        .mockResolvedValueOnce('')
        .mockResolvedValue(`${NET_STAGE}\n${CLOUD_INIT_DONE}`);
      const { service, attachServerInterface } = build(getConsoleOutput);

      const pending = createWorkloadServer(service);
      await jest.advanceTimersByTimeAsync(0);
      expect(attachServerInterface).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(5_000);
      expect(attachServerInterface).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(5_000);
      expect(attachServerInterface).toHaveBeenCalledWith(
        'GRA11',
        'srv-1',
        'net-1',
      );

      await jest.advanceTimersByTimeAsync(5_000);
      await pending;
    } finally {
      jest.useRealTimers();
    }
  });

  it("does not mistake cloud-init's 'init-local' stage for the network stage", async () => {
    jest.useFakeTimers();
    try {
      const { service, attachServerInterface } = build(
        jest
          .fn()
          .mockResolvedValue(
            "Cloud-init v. 24.4 running 'init-local' at Sat, 13 Sep 2026 10:00:01 +0000.",
          ),
      );

      const pending = createWorkloadServer(service);
      await jest.advanceTimersByTimeAsync(60_000);
      expect(attachServerInterface).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(60_000);
      expect(attachServerInterface).toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(30_000);
      await pending;
    } finally {
      jest.useRealTimers();
    }
  });

  it('attaches anyway when the console stays unreadable — an unread console must never fail a cluster creation', async () => {
    jest.useFakeTimers();
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    try {
      const { service, attachServerInterface } = build(
        jest.fn().mockRejectedValue(new Error('console unavailable')),
      );

      const pending = createWorkloadServer(service);
      await jest.advanceTimersByTimeAsync(120_000);
      expect(attachServerInterface).toHaveBeenCalledWith(
        'GRA11',
        'srv-1',
        'net-1',
      );

      await jest.advanceTimersByTimeAsync(30_000);
      await expect(pending).resolves.toMatchObject({ serverId: 'srv-1' });
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      jest.useRealTimers();
    }
  });

  it('accepts the ci-info device table as an alternative signature of a running guest', async () => {
    jest.useFakeTimers();
    try {
      const { service, attachServerInterface } = build(
        jest
          .fn()
          .mockResolvedValue(
            'ci-info: ++++++++++++Net device info+++++++++++++\nci-info: | ens3 | True | 51.83.1.2 |',
          ),
      );

      const pending = createWorkloadServer(service);
      await jest.advanceTimersByTimeAsync(0);
      expect(attachServerInterface).toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(30_000);
      await pending;
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('OvhProviderService.createServer — private NIC netplan injection', () => {
  const BOOTSTRAP_SCRIPT = [
    '#!/bin/bash',
    '# Flui.cloud Bootstrap Script (master)',
    'set -euo pipefail',
    "export CLUSTER_ID='abc'",
    'curl -fsSL "${SCRIPTS_BASE_URL}/k3s-master-init.sh" -o /tmp/init.sh',
    '',
  ].join('\n');

  async function userDataSentTo(config: Record<string, unknown>) {
    const infraCreateServer = jest.fn().mockResolvedValue({
      serverId: 'srv-1',
      ipAddress: '1.2.3.4',
      status: 'ACTIVE',
    });
    (buildOvhOpenStackClient as jest.Mock).mockResolvedValue({
      resolveComputeRegion: jest.fn().mockResolvedValue('GRA11'),
      attachServerInterface: jest.fn().mockResolvedValue(undefined),
      rebootServer: jest.fn(),
      getConsoleOutput: jest
        .fn()
        .mockResolvedValue(
          "Cloud-init v. 26.1 running 'init' at Sat, 12 Sep 2026 21:25:31 +0000.\nCloud-init v. 26.1 finished at Sat, 12 Sep 2026 21:25:50 +0000. Datasource DataSourceOpenStackLocal [net,ver=2].",
        ),
    });
    (parseRegionId as jest.Mock).mockReturnValue({ id: 'net-1' });
    (InfraOvhProviderService as unknown as jest.Mock).mockImplementation(
      () => ({
        createServer: infraCreateServer,
      }),
    );
    const service = new OvhProviderService(
      {} as never,
      {
        getActiveAccessKeyPair: jest
          .fn()
          .mockResolvedValue({ accessKey: 'ak', secretKey: 'sk' }),
      } as never,
    );

    jest.useFakeTimers();
    try {
      const pending = service.createServer(config as never);
      await jest.advanceTimersByTimeAsync(30_000);
      await pending;
    } finally {
      jest.useRealTimers();
    }
    return infraCreateServer.mock.calls[0][0].user_data as string | undefined;
  }

  it('outwaits the control plane rather than giving up first', async () => {
    // The node used to allow sixty seconds while the attach can land as late
    // as four minutes after creation — 120s waiting for ACTIVE plus 120s
    // watching the console — so it gave up first and carried on without the
    // network it was about to be given.
    const userData = await userDataSentTo({
      name: 'workload-2-master',
      networks: ['region:net-1'],
      user_data: BOOTSTRAP_SCRIPT,
    });

    expect(userData).toContain('-lt 300'); // 300 x 2s
    expect(userData).not.toContain('flui_i" -lt 30 ]');
  });

  it('refuses to install rather than proceeding without a private network', async () => {
    // Proceeding looks healthy: the cluster forms, the pods schedule, and the
    // traffic between them crosses the internet in the clear for the life of
    // the node. A creation that fails here is recoverable; that is not.
    const userData = await userDataSentTo({
      name: 'workload-2-master',
      networks: ['region:net-1'],
      user_data: BOOTSTRAP_SCRIPT,
    });

    expect(userData).toContain(
      'FATAL: OVH private network interface never appeared',
    );
    expect(userData).toContain('exit 1');
    // The old call swallowed every failure the function could report.
    expect(userData).not.toContain('flui_ovh_configure_private_nic || true');
  });

  it('declares the hot-attached NIC in netplan, ahead of the bootstrap script it leaves intact', async () => {
    const userData = await userDataSentTo({
      name: 'workload-2-master',
      networks: ['region:net-1'],
      user_data: BOOTSTRAP_SCRIPT,
    });

    expect(userData.startsWith('#!/bin/bash\n')).toBe(true);
    // Ahead of the script's own `set -euo pipefail`. That used to be the
    // reason a failure here could not abort the bootstrap; now it exits
    // explicitly instead, because a node without its private network must not
    // install K3s at all.
    expect(userData.indexOf('flui_ovh_configure_private_nic')).toBeLessThan(
      userData.indexOf('set -euo pipefail'),
    );
    expect(userData).toContain('/etc/netplan/60-flui-private.yaml');
    expect(userData).toContain('dhcp4-overrides');
    // Without this the private DHCP installs a competing default route.
    expect(userData).toContain('use-routes: false');
    // Without this a later boot blocks on systemd-networkd-wait-online.
    expect(userData).toContain('optional: true');
    expect(userData).toContain("export CLUSTER_ID='abc'");
    expect(userData).toContain(
      'curl -fsSL "${SCRIPTS_BASE_URL}/k3s-master-init.sh" -o /tmp/init.sh',
    );
  });

  it('discovers the NIC at runtime rather than hard-coding a predictable name', async () => {
    const userData = await userDataSentTo({
      name: 'workload-2-master',
      networks: ['region:net-1'],
      user_data: BOOTSTRAP_SCRIPT,
    });

    expect(userData).not.toContain('ens7');
    expect(userData).toContain('/sys/class/net/');
    expect(userData).toContain('ip -4 route show default');
  });

  it('leaves user_data untouched when no VNet is attached — nothing to compensate for', async () => {
    const userData = await userDataSentTo({
      name: 'control-master',
      user_data: BOOTSTRAP_SCRIPT,
    });

    expect(userData).toBe(BOOTSTRAP_SCRIPT);
  });

  it('emits a standalone script when there is no user_data to splice into', async () => {
    const userData = await userDataSentTo({
      name: 'workload-2-master',
      networks: ['region:net-1'],
    });

    expect(userData.startsWith('#!/bin/bash\n')).toBe(true);
    expect(userData).toContain('flui_ovh_configure_private_nic');
  });

  it('refuses to splice shell into a user_data that is not a shell script — a broken bootstrap is worse than no private network', async () => {
    const cloudConfig = '#cloud-config\nruncmd:\n  - echo hi\n';

    const userData = await userDataSentTo({
      name: 'workload-2-master',
      networks: ['region:net-1'],
      user_data: cloudConfig,
    });

    expect(userData).toBe(cloudConfig);
  });

  it('waits for egress, not just for the private address, before handing back to the bootstrap', async () => {
    const userData = await userDataSentTo({
      name: 'workload-2-master',
      networks: ['region:net-1'],
      user_data: BOOTSTRAP_SCRIPT,
    });

    expect(userData).toContain('flui_ovh_wait_for_egress');
    expect(userData.indexOf('netplan apply')).toBeLessThan(
      userData.lastIndexOf('flui_ovh_wait_for_egress'),
    );
    // Bounded, and never fatal: the caller is `|| true` and the loop returns 0.
    expect(userData).toContain('continuing anyway');
  });

  describe('rendered shell', () => {
    async function renderSnippet() {
      return (await userDataSentTo({
        name: 'workload-2-master',
        networks: ['region:net-1'],
      })) as string;
    }

    function sandbox(script: string) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flui-ovh-nic-'));
      // The snippet only ever touches absolute paths, so the sandbox has to
      // redirect them rather than chroot.
      const rewritten = script
        .replace(/\/sys\/class\/net/g, `${dir}/sys`)
        .replace(
          /\/etc\/netplan\/60-flui-private\.yaml/g,
          `${dir}/netplan.yaml`,
        );
      for (const dev of ['ens3', 'ens7']) {
        fs.mkdirSync(path.join(dir, 'sys', dev), { recursive: true });
        fs.writeFileSync(path.join(dir, 'sys', dev, 'device'), '');
      }
      fs.mkdirSync(path.join(dir, 'sys', 'lo'), { recursive: true });

      const bin = path.join(dir, 'bin');
      fs.mkdirSync(bin);
      const stub = (name: string, body: string) => {
        const file = path.join(bin, name);
        fs.writeFileSync(file, `#!/bin/bash\n${body}\n`);
        fs.chmodSync(file, 0o700);
      };
      stub(
        'ip',
        [
          'case "$*" in',
          '  "-4 route show default") echo "default via 10.10.0.1 dev ens3";;',
          '  "-4 -o addr show dev ens7")',
          '    [ -f "$FLUI_STUB_DIR/applied" ] && echo "7: ens7 inet 10.10.1.182/24 scope global ens7";;',
          '  "-4 -o addr show dev ens3") echo "2: ens3 inet 51.83.1.2/32 scope global ens3";;',
          'esac',
          'exit 0',
        ].join('\n'),
      );
      stub('netplan', 'touch "$FLUI_STUB_DIR/applied"; exit 0');
      stub('curl', '[ "$FLUI_CURL_OK" = "1" ] && exit 0; exit 6');
      stub('sleep', 'exit 0');

      const file = path.join(dir, 'snippet.sh');
      fs.writeFileSync(file, rewritten);
      return { dir, bin, file };
    }

    function run(curlOk: boolean, s: ReturnType<typeof sandbox>) {
      return execFileSync('bash', [s.file], {
        encoding: 'utf8',
        env: {
          PATH: `${s.bin}:/usr/bin:/bin`,
          FLUI_STUB_DIR: s.dir,
          FLUI_CURL_OK: curlOk ? '1' : '0',
        },
      });
    }

    it('is syntactically valid shell', async () => {
      const snippet = await renderSnippet();
      const file = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), 'flui-ovh-syntax-')),
        'snippet.sh',
      );
      fs.writeFileSync(file, snippet);

      expect(() =>
        execFileSync('bash', ['-n', file], { encoding: 'utf8' }),
      ).not.toThrow();
    });

    it('returns as soon as egress is proven, after the private address is up', async () => {
      const s = sandbox(await renderSnippet());
      try {
        const out = run(true, s);

        expect(out).toContain('OVH private NIC ens7: 10.10.1.182/24');
        expect(out).toContain('Egress restored after netplan apply');
        expect(out.indexOf('OVH private NIC')).toBeLessThan(
          out.indexOf('Egress restored'),
        );
        expect(
          fs.readFileSync(path.join(s.dir, 'netplan.yaml'), 'utf8'),
        ).toContain('use-routes: false');
      } finally {
        fs.rmSync(s.dir, { recursive: true, force: true });
      }
    }, 30_000);

    it('gives up with a warning instead of aborting when egress never comes back', async () => {
      const s = sandbox(await renderSnippet());
      try {
        const out = run(false, s);

        expect(out).toContain('OVH private NIC ens7: 10.10.1.182/24');
        expect(out).toContain('WARNING: no egress');
        // execFileSync would have thrown on a non-zero exit — the bootstrap
        // must survive this.
      } finally {
        fs.rmSync(s.dir, { recursive: true, force: true });
      }
    }, 30_000);
  });
});

describe('OvhProviderService.listInstances', () => {
  function build(servers: unknown[], nodeSizes: unknown[] = []) {
    (buildOvhOpenStackClient as jest.Mock).mockResolvedValue({});
    (InfraOvhProviderService as unknown as jest.Mock).mockImplementation(
      () => ({
        listServersAsDto: jest.fn().mockResolvedValue(servers),
        getNodeSizes: jest.fn().mockResolvedValue(nodeSizes),
      }),
    );
    const credentialProvider = {
      getActiveAccessKeyPair: jest
        .fn()
        .mockResolvedValue({ accessKey: 'ak', secretKey: 'sk' }),
    };
    return new OvhProviderService({} as never, credentialProvider as never);
  }

  it('is no longer the hard-coded empty stub — real servers come back as InstanceEntity', async () => {
    const service = build(
      [
        {
          id: 'srv-1',
          name: 'control-cluster-local-dev-master',
          server_type: 'd2-4',
          location: 'GRA11',
          status: 'ACTIVE',
          public_ip: '91.134.239.43',
          private_ip: '10.10.1.69',
          labels: [
            { key: 'managed-by', value: 'flui-cloud' },
            { key: 'flui-cluster-id', value: 'cluster-1' },
          ],
        },
      ],
      [{ id: 'd2-4', name: 'd2-4', cores: 2, memory: 4, disk: 50 }],
    );

    const instances = await service.listInstances();

    expect(instances).toHaveLength(1);
    expect(instances[0]).toMatchObject({
      name: 'control-cluster-local-dev-master',
      providerId: 'srv-1',
      status: 'running',
      cpuCores: 2,
      ramMb: 4096,
      diskMb: 51200,
      ipConfig: { v4: { ip: '91.134.239.43', gateway: '', netmaskCidr: 32 } },
    });
    // classifyOwnership() in InstancesService reads metadata.labels as a
    // plain Record, not ServerResponseDto's {key,value}[] shape.
    expect(instances[0].metadata.labels).toEqual({
      'managed-by': 'flui-cloud',
      'flui-cluster-id': 'cluster-1',
    });
  });

  it('scopes to one cluster via the flui-cluster-id label when clusterId is passed', async () => {
    const service = build([
      {
        id: 'srv-1',
        name: 'a',
        server_type: 'd2-4',
        status: 'ACTIVE',
        labels: [{ key: 'flui-cluster-id', value: 'cluster-1' }],
      },
      {
        id: 'srv-2',
        name: 'b',
        server_type: 'd2-4',
        status: 'ACTIVE',
        labels: [{ key: 'flui-cluster-id', value: 'cluster-2' }],
      },
    ]);

    const instances = await service.listInstances({ clusterId: 'cluster-2' });

    expect(instances.map((i) => i.name)).toEqual(['b']);
  });
});

describe('OvhProviderService.createVNet — subnet gateway clear targets the resolved region', () => {
  it("resolves the caller's region macro (e.g. 'GRA') through resolveNetworkRegion instead of handing it to clearSubnetGateway raw", async () => {
    const setDefaultRegion = jest.fn();
    const resolveNetworkRegion = jest.fn().mockResolvedValue('GRA11');
    const clearSubnetGateway = jest.fn().mockResolvedValue(undefined);
    (buildOvhOpenStackClient as jest.Mock).mockResolvedValue({
      setDefaultRegion,
      resolveNetworkRegion,
      clearSubnetGateway,
    });
    (InfraOvhProviderService as unknown as jest.Mock).mockImplementation(
      () => ({
        createVNet: jest.fn().mockResolvedValue({
          subnets: [{ id: 'subnet-1' }],
        }),
      }),
    );
    const credentialProvider = {
      getActiveAccessKeyPair: jest
        .fn()
        .mockResolvedValue({ accessKey: 'ak', secretKey: 'sk' }),
    };
    const service = new OvhProviderService(
      {} as never,
      credentialProvider as never,
    );

    await service.createVNet({
      subnets: [{ networkZone: 'GRA' }],
    } as never);

    expect(resolveNetworkRegion).toHaveBeenCalledWith('GRA');
    expect(clearSubnetGateway).toHaveBeenCalledWith('GRA11', 'subnet-1');
  });
});
