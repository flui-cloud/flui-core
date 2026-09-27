import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CreateScheduledJobDto,
  UpdateScheduledJobDto,
} from './scheduled-job.dto';

async function messages(
  body: Record<string, unknown>,
  cls: any = CreateScheduledJobDto,
) {
  const errors = await validate(plainToInstance(cls, body));
  return errors.flatMap((e) => Object.values(e.constraints ?? {}));
}

const base = { name: 'nightly', command: 'echo ok' };

describe('schedule validation', () => {
  it.each([
    '*/2 * * * *',
    '0 3 * * *',
    '15,45 9-17 * * 1-5',
    '0 0 1 JAN *',
    '0 6 * * SUN',
    '@daily',
  ])('accepts %s', async (schedule) => {
    await expect(messages({ ...base, schedule })).resolves.toEqual([]);
  });

  it.each([
    '*/2 * * *',
    '61 * * * *',
    '* 24 * * *',
    '* * 0 * *',
    '* * * 13 *',
    '* * * * 8',
    'every day',
    '',
  ])('rejects %s in plain words', async (schedule) => {
    const errs = await messages({ ...base, schedule });
    expect(errs.join(' ')).toMatch(/schedule/i);
    expect(errs.join(' ')).not.toMatch(/Invalid value|spec\.schedule/);
  });

  it('accepts a real timezone and rejects an invented one', async () => {
    await expect(
      messages({ ...base, schedule: '0 3 * * *', timezone: 'Europe/Rome' }),
    ).resolves.toEqual([]);
    const errs = await messages({
      ...base,
      schedule: '0 3 * * *',
      timezone: 'Mars/Olympus',
    });
    expect(errs.join(' ')).toContain('Mars/Olympus');
  });

  it('applies the same rules to an update', async () => {
    const errs = await messages(
      { schedule: '*/2 * * *', timezone: 'Mars/Olympus' },
      UpdateScheduledJobDto,
    );
    expect(errs).toHaveLength(2);
  });
});
