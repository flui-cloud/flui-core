jest.mock('chalk', () => {
  const same = (text: string) => text;
  return { __esModule: true, default: { dim: same, bold: same } };
});

import { recordedSchedule } from './backup-enable';

describe('recordedSchedule', () => {
  const client = (activity: () => Promise<unknown>) =>
    ({ getPolicyActivity: jest.fn(activity) }) as any;

  it('says so when the API saved no schedule, instead of claiming a default', async () => {
    const c = client(async () => {
      throw new Error('not called');
    });
    const text = await recordedSchedule(c, { id: 'p' } as any);
    expect(text).toContain('on demand only');
    expect(c.getPolicyActivity).not.toHaveBeenCalled();
  });

  it('describes the schedule the API recorded in words', async () => {
    const c = client(async () => ({
      schedule: { description: 'Every day at 02:30 UTC' },
    }));
    const text = await recordedSchedule(c, {
      id: 'p',
      cronSchedule: '30 2 * * *',
    } as any);
    expect(text).toBe('Every day at 02:30 UTC (30 2 * * *)');
  });

  it('falls back to the expression when the words cannot be fetched', async () => {
    const c = client(async () => {
      throw new Error('404');
    });
    const text = await recordedSchedule(c, {
      id: 'p',
      cronSchedule: '30 3 * * *',
    } as any);
    expect(text).toBe('cron 30 3 * * * (UTC)');
  });
});
