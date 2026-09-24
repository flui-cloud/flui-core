import { serverLocation } from './server-location';

describe('where a Hetzner server runs', () => {
  it('reads the location the server carries today', () => {
    expect(serverLocation({ location: { name: 'fsn1' } })?.name).toBe('fsn1');
  });

  it('still reads the datacenter shape a response may carry', () => {
    expect(
      serverLocation({ datacenter: { location: { name: 'nbg1' } } })?.name,
    ).toBe('nbg1');
  });

  it('answers nothing, not a guess, when neither is there', () => {
    expect(serverLocation({})).toBeNull();
  });
});
