import {
  KnownVolumeRefs,
  normalizeVolumeRef,
  sameVolumeRef,
} from './provider-volume-ref';

/**
 * The rule that a delete of a paid-for disk rests on. Everything here is about
 * one thing: two spellings of the same volume must never read as two volumes.
 */
describe('reading a provider volume id', () => {
  it('reads the zoned form and the bare form as the same volume', () => {
    expect(sameVolumeRef('fr-par-1:5e6f', '5e6f')).toBe(true);
    expect(sameVolumeRef('5e6f', 'fr-par-1:5e6f')).toBe(true);
    expect(sameVolumeRef('nl-ams-1:5e6f', 'fr-par-1:5e6f')).toBe(true);
  });

  it('reads a server reference with its family prefix as the same tail', () => {
    expect(sameVolumeRef('instance:fr-par-1:5e6f', '5e6f')).toBe(true);
  });

  it('leaves a Hetzner numeric id alone', () => {
    expect(normalizeVolumeRef('102938')).toBe('102938');
    expect(sameVolumeRef('102938', '102938')).toBe(true);
    expect(sameVolumeRef('102938', '102939')).toBe(false);
  });

  it('ignores case and surrounding blanks, which a hand-typed id carries', () => {
    expect(sameVolumeRef(' FR-PAR-1:5E6F ', '5e6f')).toBe(true);
  });

  it('still tells two different volumes apart', () => {
    expect(sameVolumeRef('fr-par-1:5e6f', 'fr-par-1:5e6a')).toBe(false);
  });

  /**
   * An id with no readable tail is not "no match" — it is "cannot be read", and
   * the caller must turn that into a refusal instead of a green light.
   */
  it('refuses to read an empty, blank or tail-less id', () => {
    for (const bad of ['', '   ', ':', 'fr-par-1:', null, undefined]) {
      expect(normalizeVolumeRef(bad)).toBeNull();
      expect(sameVolumeRef(bad, bad)).toBe(false);
    }
  });
});

describe('the volumes the registry still points at', () => {
  it('answers to any spelling of an id it was given in another', () => {
    const known = new KnownVolumeRefs();
    known.add('fr-par-1:5e6f');
    expect(known.has('5e6f')).toBe(true);
    expect(known.has('fr-par-1:5e6f')).toBe(true);
    expect(known.has('nl-ams-1:5e6f')).toBe(true);
    expect(known.has('5e6a')).toBe(false);
  });

  it('drops ids it cannot read instead of storing a phantom', () => {
    const known = new KnownVolumeRefs();
    known.add(null);
    known.add('');
    known.add('fr-par-1:');
    expect(known.size).toBe(0);
    expect(known.has('')).toBe(false);
  });
});
