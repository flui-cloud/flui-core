jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jose', () => ({}));
jest.mock('ip-cidr', () => ({}));

import { BackupPoliciesService } from './backup-policies.service';
import { BackupEngineClass } from '../enums/backup-engine-class.enum';

describe('the heartbeat address on the platform backup', () => {
  const make = (heartbeat?: { url: string }) => {
    const updates: any[] = [];
    const policy = {
      id: 'p1',
      engineClass: BackupEngineClass.PLATFORM,
      metadata: { platform: { recipient: 'age1old', heartbeat } },
    };
    const repo = {
      findById: jest.fn(async () => policy),
      update: jest.fn(async (_id: string, patch: any) => {
        updates.push(patch);
      }),
    };
    const service = new BackupPoliciesService(
      repo as any,
      {} as any,
      {} as any,
      {} as any,
    );
    return { service, updates };
  };

  it('keeps the current address when none is given', async () => {
    const { service, updates } = make({ url: 'https://hc-ping.com/a' });
    await service.setPlatformConfig('p1', { recipient: 'age1new' });
    expect(updates[0].metadata.platform.heartbeat).toEqual({
      url: 'https://hc-ping.com/a',
    });
  });

  it('forgets it when asked to, so the heartbeat stops', async () => {
    const { service, updates } = make({ url: 'https://hc-ping.com/a' });
    await service.setPlatformConfig('p1', {
      recipient: 'age1old',
      clearHeartbeat: true,
    });
    expect(updates[0].metadata.platform.heartbeat).toBeUndefined();
    expect(updates[0].metadata.platform.recipient).toBe('age1old');
  });

  it('takes a new address over a request to forget', async () => {
    const { service, updates } = make();
    await service.setPlatformConfig('p1', {
      recipient: 'age1old',
      heartbeatUrl: 'https://hc-ping.com/b',
      clearHeartbeat: true,
    });
    expect(updates[0].metadata.platform.heartbeat).toEqual({
      url: 'https://hc-ping.com/b',
    });
  });
});
