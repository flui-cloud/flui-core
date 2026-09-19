// The mailer imports the sender for its type, and one package in that chain is
// ESM. Same cut the mail module's own specs make.
jest.mock('../../mail/services/mail-send.service', () => ({
  MailSendService: class MailSendService {},
}));
// Reading cluster capacity pulls in the Kubernetes client, which is ESM-only
// and beyond what ts-jest transforms. Same cut the capacity service's own spec
// makes; nothing from it is ever constructed here.
jest.mock('@kubernetes/client-node', () => ({}));

import { SandboxCapacityAlertService } from './sandbox-capacity-alert.service';

const build = (rooms: boolean[]) => {
  const recorded: Array<{ status: string; startsAt: Date }> = [];
  const mailed: string[] = [];
  let call = 0;

  const clusters = {
    // The same gate that refuses a guest's install; here it simply says yes or no.
    checkResourceAvailability: async () => ({
      canDeploy: rooms[Math.min(call++, rooms.length - 1)],
      available: { cpu: 1200, memory: 2048 },
    }),
  };
  const alerts = {
    // Stands in for the recorder's own job: news only on a change of state.
    record: async (incoming: Record<string, unknown>[]) => {
      const alert = incoming[0];
      const status = alert.status as string;
      const previous = recorded.at(-1)?.status;
      recorded.push({ status, startsAt: alert.startsAt as Date });
      if (status === previous) return [];
      return [
        {
          kind: status === 'firing' ? 'fired' : 'resolved',
          event: { alertname: alert.alertname, severity: alert.severity },
        },
      ];
    },
  };
  const mail = {
    deliver: async (kind: string) => {
      mailed.push(kind);
      return true;
    },
  };

  return {
    recorded,
    mailed,
    service: new SandboxCapacityAlertService(
      clusters as never,
      alerts as never,
      mail as never,
    ),
  };
};

describe('SandboxCapacityAlertService', () => {
  /**
   * An area holds nothing until its guest deploys something, so "how many areas
   * fit" — free resources divided by what an average area holds — divides by
   * nearly zero and reports room for thousands. An alert built on it can never
   * fire.
   */
  it('asks whether one more area’s worth of work could start, not how many areas fit', async () => {
    const asked: Array<[string, number, number]> = [];
    const service = new SandboxCapacityAlertService(
      {
        checkResourceAvailability: async (
          clusterId: string,
          cpu: number,
          memory: number,
        ) => {
          asked.push([clusterId, cpu, memory]);
          return { canDeploy: true, available: { cpu: 1, memory: 1 } };
        },
      } as never,
      { record: async () => [] } as never,
      { deliver: async () => true } as never,
    );

    await service.check('c1');

    expect(asked).toEqual([['c1', 1500, 2048]]);
  });

  it('says nothing at all when the demo has no cluster', async () => {
    const { service, recorded } = build([false]);

    await service.check(null);

    expect(recorded).toHaveLength(0);
  });
  it('says nothing while there is room', async () => {
    const { service, recorded, mailed } = build([true]);

    await service.check('c1');

    expect(recorded).toHaveLength(0);
    expect(mailed).toHaveLength(0);
  });

  it('raises it once when the room runs out', async () => {
    const { service, mailed } = build([false]);

    await service.check('c1');

    expect(mailed).toEqual(['fired']);
  });

  /**
   * The reason this goes through the recorder at all: the pass runs every five
   * minutes, and an incident that is still going is not news a second time.
   */
  it('does not say it again while it is still full', async () => {
    const { service, mailed } = build([false, false, false]);

    await service.check('c1');
    await service.check('c1');
    await service.check('c1');

    expect(mailed).toEqual(['fired']);
  });

  it('keeps the start time of an incident that is still going', async () => {
    const { service, recorded } = build([false, false]);

    await service.check('c1');
    await service.check('c1');

    expect(recorded[0].startsAt).toEqual(recorded[1].startsAt);
  });

  it('announces the recovery, then goes quiet again', async () => {
    const { service, mailed } = build([false, true, true]);

    await service.check('c1');
    await service.check('c1');
    await service.check('c1');

    expect(mailed).toEqual(['fired', 'resolved']);
  });

  // A demo that cannot describe its own capacity must still serve the people
  // already inside it.
  it('never throws when the cluster cannot be read', async () => {
    const service = new SandboxCapacityAlertService(
      {
        checkResourceAvailability: async () => {
          throw new Error('api server down');
        },
      } as never,
      { record: async () => [] } as never,
      { deliver: async () => true } as never,
    );

    await expect(service.check('c1')).resolves.toBeUndefined();
  });
});
