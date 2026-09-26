import { ApplicationStatus } from '../enums/application-status.enum';
import { applicationAvailability, refusalOf } from './app-availability.util';

describe('what an application offers in the state it is in', () => {
  it('switches off what needs a running app while it waits for room, and says why', () => {
    const entries = applicationAvailability({
      status: ApplicationStatus.WAITING_FOR_ROOM,
      previousGoodRelease: false,
    });
    expect(refusalOf(entries, 'logs')).toBe(
      'It waits for a node with room and has not started yet: nothing has run, so there are no logs.',
    );
    expect(refusalOf(entries, 'restart')).toContain(
      'nothing is running to restart',
    );
    expect(entries.find((e) => e.key === 'rollback')?.state).toBe('hidden');
  });

  it('offers everything to a running app with an earlier good release', () => {
    const entries = applicationAvailability({
      status: ApplicationStatus.RUNNING,
      previousGoodRelease: true,
    });
    expect(entries.every((e) => e.state === 'available')).toBe(true);
  });

  it('keeps logs for a failed app — that is where the failure is', () => {
    const entries = applicationAvailability({
      status: ApplicationStatus.FAILED,
      previousGoodRelease: true,
    });
    expect(refusalOf(entries, 'logs')).toBeNull();
    expect(refusalOf(entries, 'restart')).toBeNull();
  });

  it('tells a stopped app to start rather than restart', () => {
    const entries = applicationAvailability({
      status: ApplicationStatus.STOPPED,
      previousGoodRelease: true,
    });
    expect(refusalOf(entries, 'restart')).toContain('start it instead');
  });
});
