import { isOclifExit, refusedKeyHint } from './provider-refusal';

describe('a provider turning the key down', () => {
  it.each([
    'Request failed with status code 401',
    'the token you have provided is invalid (unauthorized)',
    'Invalid API token',
  ])('names the fix for "%s"', (message) => {
    expect(refusedKeyHint(message, 'hetzner')).toBe(
      'Hetzner refused the stored key. Store a valid one with:  flui config set hetzner',
    );
  });

  it('says nothing about an unrelated failure', () => {
    expect(
      refusedKeyHint('Request failed with status code 500', 'hetzner'),
    ).toBeUndefined();
    expect(
      refusedKeyHint('connect ETIMEDOUT 1.2.3.4:443', 'ovh'),
    ).toBeUndefined();
  });

  it('tells oclif’s own exit apart from an error', () => {
    expect(isOclifExit({ oclif: { exit: 1 } })).toBe(true);
    expect(isOclifExit(new Error('boom'))).toBe(false);
  });
});
