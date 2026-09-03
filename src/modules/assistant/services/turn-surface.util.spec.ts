import { SurfaceSnapshot } from '@flui-cloud/semantic-surface';
import { acceptTurnSurface } from './turn-surface.util';

function snapshot(
  overrides: Partial<SurfaceSnapshot['surface']> = {},
): SurfaceSnapshot {
  return {
    schemaVersion: '0.2',
    app: { id: 'flui-dashboard', version: '0.13.0' },
    surface: {
      id: 'app-detail:abc-123',
      route: '/apps/abc-123',
      revision: 3,
      generatedAt: '2026-08-24T10:00:00Z',
      ...overrides,
    },
    attention: [
      {
        scopeId: 'app-detail:abc-123',
        entityRef: 'flui://application/abc-123',
        reason: 'route',
      },
    ],
    scopes: [
      {
        id: 'app-detail:abc-123',
        kind: 'page',
        entities: [{ ref: 'flui://application/abc-123', role: 'primary' }],
        observations: [
          {
            key: 'flui.application.status',
            presentedAs: { text: 'running' },
            source: 'ui',
          },
        ],
      },
    ],
  };
}

describe('acceptTurnSurface', () => {
  it('returns undefined when no surface is sent', () => {
    expect(acceptTurnSurface(undefined)).toBeUndefined();
  });

  it('returns undefined for null', () => {
    expect(acceptTurnSurface(null)).toBeUndefined();
  });

  it('accepts a well-formed snapshot with no revision echo', () => {
    expect(acceptTurnSurface(snapshot())).toEqual(snapshot());
  });

  it('accepts a well-formed snapshot whose echoed revision matches', () => {
    expect(acceptTurnSurface(snapshot(), 3)).toEqual(snapshot());
  });

  it('drops the snapshot when the echoed revision disagrees (client state muddled)', () => {
    expect(acceptTurnSurface(snapshot(), 4)).toBeUndefined();
  });

  it('drops a snapshot failing schema validation (missing required field)', () => {
    const bad = snapshot() as unknown as Record<string, unknown>;
    delete bad.scopes;
    expect(acceptTurnSurface(bad)).toBeUndefined();
  });

  it('drops a snapshot failing schema validation (wrong type)', () => {
    const bad = { ...snapshot(), attention: 'not-an-array' };
    expect(acceptTurnSurface(bad)).toBeUndefined();
  });

  it('drops a snapshot with a semantic error (attention points at a missing scope)', () => {
    const bad = snapshot();
    bad.attention = [{ scopeId: 'does-not-exist', reason: 'route' }];
    expect(acceptTurnSurface(bad)).toBeUndefined();
  });

  it('drops an oversized snapshot', () => {
    const bad = snapshot();
    bad.scopes[0].observations = Array.from({ length: 5000 }, (_, i) => ({
      key: `flui.probe.${i}`,
      presentedAs: { text: 'x'.repeat(50) },
    }));
    expect(acceptTurnSurface(bad)).toBeUndefined();
  });

  it('never throws on a malformed / circular input', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => acceptTurnSurface(circular)).not.toThrow();
    expect(acceptTurnSurface(circular)).toBeUndefined();
  });
});
