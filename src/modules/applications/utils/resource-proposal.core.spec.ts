import { engineMemoryNote, proposeMemory } from './resource-proposal.core';

describe('proposeMemory', () => {
  it('proposes nothing for an app that fits what it asked for', () => {
    expect(
      proposeMemory({ requestMi: 256, limitMi: 512, p95Mi: 200, oom: null }),
    ).toBeNull();
  });

  it('takes the limit an out-of-memory diagnosis proposes', () => {
    expect(
      proposeMemory({
        requestMi: 256,
        limitMi: 512,
        p95Mi: null,
        oom: { limitMi: 1024, diagnosisId: 'd1' },
      }),
    ).toEqual({
      requestMi: 256,
      limitMi: 1024,
      diagnosisId: 'd1',
      reasons: [
        {
          kind: 'oom',
          sentence:
            'It was stopped for running out of memory at its 512Mi limit.',
        },
      ],
    });
  });

  it('gives headroom to an app that lives near its limit', () => {
    const out = proposeMemory({
      requestMi: 400,
      limitMi: 512,
      p95Mi: 480,
      oom: null,
    });
    expect(out?.limitMi).toBe(768);
    expect(out?.requestMi).toBe(400);
    expect(out?.reasons.map((r) => r.kind)).toEqual(['near-limit']);
  });

  it('raises the reservation of an app using far more than it reserves, and keeps the limit above it', () => {
    const out = proposeMemory({
      requestMi: 64,
      limitMi: 256,
      p95Mi: 300,
      oom: null,
    });
    expect(out?.requestMi).toBe(320);
    expect(out?.limitMi).toBe(512);
    expect(out?.reasons.map((r) => r.kind)).toEqual([
      'near-limit',
      'above-request',
    ]);
  });

  it('ignores a diagnosis the limit has already outgrown', () => {
    expect(
      proposeMemory({
        requestMi: 256,
        limitMi: 2048,
        p95Mi: 200,
        oom: { limitMi: 1024, diagnosisId: 'd1' },
      }),
    ).toBeNull();
  });
});

describe('engineMemoryNote', () => {
  it('names the setting for a known engine, and asks to check one otherwise', () => {
    expect(engineMemoryNote('postgres')).toContain('shared_buffers');
    expect(engineMemoryNote(null)).toContain('its own memory settings');
  });
});
