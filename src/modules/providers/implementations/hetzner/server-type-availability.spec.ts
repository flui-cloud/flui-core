import { serverTypeAvailability } from './server-type-availability';

describe('where a Hetzner server type can be bought', () => {
  it('reads it from the server type, location by location', () => {
    expect(
      serverTypeAvailability({
        locations: [
          { name: 'fsn1', available: true, recommended: true },
          { name: 'hel1', available: false },
        ],
      }),
    ).toEqual([
      {
        location: 'fsn1',
        available: true,
        availabilityKnown: true,
        deprecated: false,
      },
      {
        location: 'hel1',
        available: false,
        availabilityKnown: true,
        deprecated: false,
      },
    ]);
  });

  it('says it does not know, rather than sold out, where no answer is given', () => {
    const [fsn1] = serverTypeAvailability({ locations: [{ name: 'fsn1' }] });
    expect(fsn1).toMatchObject({ available: true, availabilityKnown: false });
  });

  it('carries a location being retired', () => {
    const [old] = serverTypeAvailability({
      locations: [
        { name: 'fsn1', available: true, deprecation: { announced: 'x' } },
      ],
    });
    expect(old.deprecated).toBe(true);
  });
});
