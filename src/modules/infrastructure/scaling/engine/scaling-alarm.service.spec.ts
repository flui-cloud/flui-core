import { ScalingAlarmService } from './scaling-alarm.service';
import { AlertEventsService } from '../../../observability/services/alert-events.service';
import { ScalingGroupEntity } from '../entities/scaling-group.entity';

const group = {
  id: 'g-1',
  name: 'default',
  clusterId: 'c-1',
} as ScalingGroupEntity;

const alerted = {
  outcome: 'alerted',
  saw: 'A pod waited 40s',
  did: 'asked for a cx33',
  why: 'no room',
};
const quiet = {
  outcome: 'declined',
  saw: 'Every pod placed',
  did: 'nothing to do',
  why: 'settled',
};

function makeService() {
  const record = jest.fn().mockResolvedValue([]);
  const service = new ScalingAlarmService({
    record,
  } as unknown as AlertEventsService);
  return { service, record };
}

describe('ScalingAlarmService', () => {
  it('sends nothing while the engine is deciding quietly', async () => {
    const { service, record } = makeService();
    await service.publish(group, quiet);
    expect(record).not.toHaveBeenCalled();
  });

  it('raises an alarm carrying what was seen and what it asks for', async () => {
    const { service, record } = makeService();
    await service.publish(group, alerted);

    const [[[alert]]] = record.mock.calls;
    expect(alert.status).toBe('firing');
    expect(alert.alertname).toBe('FluiScalingNeedsPerson');
    expect(alert.clusterId).toBe('c-1');
    expect(alert.annotations.description).toBe('A pod waited 40s');
    expect(alert.annotations.asks).toBe('asked for a cx33');
  });

  it('keeps a repeat the same alarm, so how long it has gone unanswered survives', async () => {
    const { service, record } = makeService();
    await service.publish(group, alerted);
    await service.publish(group, alerted);

    const first = record.mock.calls[0][0][0];
    const second = record.mock.calls[1][0][0];
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.startsAt).toEqual(first.startsAt);
  });

  it('clears itself once a later decision asks for nothing', async () => {
    const { service, record } = makeService();
    await service.publish(group, alerted);
    await service.publish(group, quiet);

    const resolved = record.mock.calls[1][0][0];
    expect(resolved.status).toBe('resolved');
    expect(resolved.endsAt).toBeInstanceOf(Date);
  });

  it('still says what it asked for once it is resolved', async () => {
    const { service, record } = makeService();
    await service.publish(group, alerted);
    await service.publish(group, quiet);

    const resolved = record.mock.calls[1][0][0];
    expect(resolved.status).toBe('resolved');
    expect(resolved.annotations.description).toBe('A pod waited 40s');
    expect(resolved.annotations.asks).toBe('asked for a cx33');
  });

  it('does not clear an alarm it never raised', async () => {
    const { service, record } = makeService();
    await service.publish(group, quiet);
    await service.publish(group, quiet);
    expect(record).not.toHaveBeenCalled();
  });

  it('swallows a broken rail rather than stopping the loop that found the alarm', async () => {
    const record = jest
      .fn()
      .mockRejectedValue(new Error('alert store is away'));
    const service = new ScalingAlarmService({
      record,
    } as unknown as AlertEventsService);
    await expectAsync(service.publish(group, alerted)).toBeResolved();
  });
});

/** jest has no expectAsync; this keeps the intent readable. */
function expectAsync(promise: Promise<unknown>) {
  return {
    toBeResolved: async () => {
      await expect(promise).resolves.toBeUndefined();
    },
  };
}
