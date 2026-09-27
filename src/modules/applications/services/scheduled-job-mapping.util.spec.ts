import { resourceName, runStatus, toDto } from './scheduled-job-mapping.util';

describe('scheduled job mapping', () => {
  it('names the CronJob after the app and a DNS-safe schedule name', () => {
    const name = resourceName({ slug: 'shop' } as any, 'Nightly Report!');
    expect(name).toBe('shop-nightly-report');
    expect(
      resourceName({ slug: 'a'.repeat(60) } as any, 'x').length,
    ).toBeLessThanOrEqual(52);
  });

  it('reads a CronJob back as the schedule it was written from', () => {
    const dto = toDto({
      metadata: {
        name: 'shop-nightly',
        labels: { 'flui.cloud/scheduled-job': 'nightly' },
      },
      spec: {
        schedule: '0 3 * * *',
        suspend: true,
        jobTemplate: {
          spec: {
            template: { spec: { containers: [{ args: ['-c', 'date'] }] } },
          },
        },
      },
    });
    expect(dto).toMatchObject({
      name: 'nightly',
      resourceName: 'shop-nightly',
      command: 'date',
      enabled: false,
    });
  });

  it('tells a run’s outcome from its status', () => {
    expect(runStatus({ succeeded: 1 })).toBe('Succeeded');
    expect(runStatus({ failed: 1 })).toBe('Failed');
    expect(runStatus({ active: 1 })).toBe('Running');
    expect(runStatus({})).toBe('Unknown');
  });
});
