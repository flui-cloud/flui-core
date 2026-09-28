jest.mock('@kubernetes/client-node', () => ({}));

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BadRequestException } from '@nestjs/common';
import {
  NodeAccessRecoveryService,
  RECOVERY_RULE,
  buildRescueRepairScript,
  keyFingerprint,
} from './node-access-recovery.service';

const node = {
  id: 'n1',
  serverName: 'ovh-master',
  providerResourceId: 'srv-1',
  ipAddress: '1.2.3.4',
};
const cluster = (provider: string) => ({
  id: 'c1',
  name: 'ovh-test',
  provider,
  nodes: [node],
});

function make(
  provider: string,
  over: { repair?: string; refuse?: boolean } = {},
) {
  const order: string[] = [];
  const saved: any[] = [];
  const ovh = {
    rescueForRecovery: jest.fn(async () => {
      order.push('rescue');
      return { region: 'GRA11', image: 'Debian 12' };
    }),
    unrescue: jest.fn(async () => {
      order.push('unrescue');
    }),
    rescueStatus: jest.fn(async () =>
      order.includes('unrescue') ? 'ACTIVE' : 'RESCUE',
    ),
    consoleUrl: jest.fn(async () => 'https://console.example/vnc?token=t'),
  };
  const firewall = {
    ensureClusterFirewall: jest.fn(async () => {
      order.push('firewall');
      return { id: 'fw1', desiredRules: [{ description: 'ssh', port: '22' }] };
    }),
    updateAndApplyRules: jest.fn(),
  };
  const service = new NodeAccessRecoveryService(
    { findOne: jest.fn().mockResolvedValue(cluster(provider)) } as never,
    {} as never,
    {
      create: (row: unknown) => row,
      save: jest.fn(async (row: any) => {
        saved.push({ ...row });
        return { id: 'op1', ...row };
      }),
      findOne: jest.fn().mockResolvedValue({ id: 'op1', metadata: {} }),
    } as never,
    { add: jest.fn() } as never,
    { getProvider: () => ovh } as never,
    {
      getBootstrapKeyMaterialForCluster: jest.fn().mockResolvedValue({
        id: 'k',
        publicKey:
          'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILkOTD3HFFmc0q6pbmNuyNMw4Ux9+ehdzlnB94eb+hAy flui',
        privateKey: 'PRIVATE',
      }),
    } as never,
    {
      execCommand: jest.fn(async () => {
        if (over.refuse) throw new Error('Permission denied (publickey)');
        order.push('repair');
        return over.repair ?? 'FLUI_RECOVER_DONE';
      }),
    } as never,
    firewall as never,
  );
  (service as unknown as { rescueKeyWaitMs: number }).rescueKeyWaitMs = 0;
  return { service, order, saved, firewall };
}

describe('getting back into a node through its provider', () => {
  it('refuses a machine the operator brought', async () => {
    const { service } = make('byos');
    await expect(
      service.start('c1', 'n1', '5.5.5.5', 'ada'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('opens 22 to one address on a provider firewall, and nothing wider', async () => {
    const { service, firewall } = make('hetzner');
    await service.run({
      operationId: 'op1',
      clusterId: 'c1',
      nodeId: 'n1',
      sourceIp: '5.5.5.5',
    });
    expect(firewall.updateAndApplyRules).toHaveBeenCalledWith('fw1', [
      { description: 'ssh', port: '22' },
      {
        description: RECOVERY_RULE,
        direction: 'in',
        protocol: 'tcp',
        port: '22',
        sourceIps: ['5.5.5.5/32'],
      },
    ]);
  });

  it('asks for an address on Hetzner and Scaleway', async () => {
    const { service } = make('scaleway');
    await expect(service.start('c1', 'n1', null, 'ada')).rejects.toThrow(
      'Name the address',
    );
  });

  it('rescues an OVH node, repairs its disk, boots it again and re-applies the firewall, in that order', async () => {
    const { service, order, saved } = make('ovh');
    await service.run({
      operationId: 'op1',
      clusterId: 'c1',
      nodeId: 'n1',
      sourceIp: null,
    });
    expect(order).toEqual(['rescue', 'repair', 'unrescue', 'firewall']);
    expect(saved.at(-1)).toMatchObject({ status: 'COMPLETED' });
  });

  it('always boots the node from its own disk again, even when the repair found nothing', async () => {
    const { service, order, saved } = make('ovh', {
      repair: 'FLUI_RECOVER_NO_DISK',
    });
    await service.run({
      operationId: 'op1',
      clusterId: 'c1',
      nodeId: 'n1',
      sourceIp: null,
    });
    expect(order).toContain('unrescue');
    expect(order).not.toContain('firewall');
    expect(saved.at(-1)).toMatchObject({ status: 'FAILED' });
    expect(saved.at(-1).metadata.error).toContain('could not be told apart');
  });
});

describe('a rescue system that never takes the key', () => {
  it('boots the node back, and says which image, which key and where its console is', async () => {
    const { service, order, saved } = make('ovh', { refuse: true });
    await service.run({
      operationId: 'op1',
      clusterId: 'c1',
      nodeId: 'n1',
      sourceIp: null,
    });
    expect(order).toContain('unrescue');
    const error = saved.at(-1).metadata.error as string;
    expect(saved.at(-1)).toMatchObject({ status: 'FAILED' });
    expect(error).toContain('Debian 12');
    expect(error).toContain('SHA256:');
    expect(error).toContain('https://console.example/vnc');
    expect(error).toContain('Permission denied (publickey)');
  });

  it('prints the key fingerprint the way OpenSSH does', () => {
    expect(
      keyFingerprint(
        'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILkOTD3HFFmc0q6pbmNuyNMw4Ux9+ehdzlnB94eb+hAy flui',
      ),
    ).toBe('SHA256:gCa/s4qtnCkJrqauqTIOH1UEkTABB1wcmHeQAl3wGDc');
    expect(keyFingerprint('garbage')).toBe('unknown');
  });
});

describe('the repair run from the rescue system', () => {
  const run = (label: string, rootIsLabelled = false) => {
    const dir = mkdtempSync(join(tmpdir(), 'flui-rescue-'));
    const log = join(dir, 'calls');
    const tool = (name: string, body: string) =>
      writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    tool('sudo', `"$@"`);
    tool('blkid', label ? `echo ${label}` : 'exit 2');
    tool('findmnt', `echo ${rootIsLabelled ? label : '/dev/sda1'}`);
    tool('mkdir', `echo "mkdir $@" >> ${log}`);
    tool('mount', `echo "mount $@" >> ${log}`);
    tool('umount', `echo "umount $@" >> ${log}`);
    tool('rm', `echo "rm $@" >> ${log}`);
    const out = execFileSync('sh', ['-c', buildRescueRepairScript()], {
      env: { PATH: `${dir}:/usr/bin:/bin` },
    }).toString();
    return { out, calls: existsSync(log) ? readFileSync(log, 'utf-8') : '' };
  };

  it('mounts the disk labelled as the node root and stops the Flui firewall from loading', () => {
    const r = run('/dev/sdb1');
    expect(r.out).toContain('FLUI_RECOVER_DONE');
    expect(r.calls).toContain('mount /dev/sdb1 /mnt/flui-root');
    expect(r.calls).toContain('multi-user.target.wants/flui-firewall.service');
  });

  it('changes nothing when the labelled disk is the one the rescue booted from', () => {
    const r = run('/dev/sda1', true);
    expect(r.out).toContain('FLUI_RECOVER_NO_DISK');
    expect(r.calls).toBe('');
  });
});
