import { stillCarried } from './deploy-in-flight.util';

const NOW = new Date('2026-10-21T14:30:00Z');

describe('a deploy already in flight for the same image', () => {
  it('is reused while its job is still moving it', () => {
    expect(
      stillCarried(
        {
          createdAt: new Date('2026-10-21T14:13:15Z'),
          updatedAt: new Date('2026-10-21T14:25:00Z'),
        },
        NOW,
      ),
    ).toBe(true);
  });

  it('is not reused once nothing has moved it for a quarter of an hour', () => {
    expect(
      stillCarried(
        {
          createdAt: new Date('2026-10-21T14:13:15Z'),
          updatedAt: new Date('2026-10-21T14:13:19Z'),
        },
        NOW,
      ),
    ).toBe(false);
  });
});
