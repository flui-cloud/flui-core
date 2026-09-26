import { OperationStatus } from '../../servers/entities/infrastructure-operations.entity';
import { purchaseHold, soldOut } from './purchase-hold';

const repo = (row: Record<string, unknown> | null) =>
  ({ findOne: async () => row }) as never;

const failed = (errorMessage: string) => ({
  status: OperationStatus.FAILED,
  createdAt: new Date('2026-09-25T10:00:00Z'),
  updatedAt: new Date('2026-09-25T10:00:00Z'),
  errorMessage,
});

describe('purchaseHold', () => {
  it('holds a real failure until a person asks to try again', async () => {
    const hold = await purchaseHold(
      repo(failed('Invalid SSH key location')),
      'c1',
      null,
      new Date('2026-09-25T12:00:00Z'),
    );
    expect(hold).toMatchObject({ error: 'Invalid SSH key location' });
    expect(hold?.until).toBeUndefined();
  });

  it('holds a sold-out order only for a short pause, then lets availability decide', async () => {
    const row = failed(
      'Operation failed: Hetzner API Error: unavailable (resource_unavailable)',
    );
    const during = await purchaseHold(
      repo(row),
      'c1',
      null,
      new Date('2026-09-25T10:05:00Z'),
    );
    expect(during?.until).toEqual(new Date('2026-09-25T10:10:00Z'));
    const after = await purchaseHold(
      repo(row),
      'c1',
      null,
      new Date('2026-09-25T10:11:00Z'),
    );
    expect(after).toBeNull();
  });

  it('recognises the provider refusals that leave no server behind', () => {
    expect(
      soldOut('Hetzner API Error: error during placement (placement_error)'),
    ).toBe(true);
    expect(soldOut('SSH key with name x already exists on Hetzner')).toBe(
      false,
    );
    expect(soldOut(null)).toBe(false);
  });
});
