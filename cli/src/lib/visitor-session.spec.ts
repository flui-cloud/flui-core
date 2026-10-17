jest.mock('chalk', () => {
  const same = (text: string) => text;
  const chalk: any = new Proxy(same, { get: () => chalk });
  return { __esModule: true, default: chalk };
});

import { ApiClient, ApiError } from './api-client';
import { ConfigStorage } from './config-storage';
import { controlPlaneHint } from './control-plane-api';
import {
  clearVisitorSession,
  errorCodeOf,
  markVisitorSession,
  visitorErrorMessage,
  visitorKeyGroups,
  visitorSessionOf,
} from './visitor-session';

function storageStub(): ConfigStorage {
  const prefs: Record<string, unknown> = {};
  return {
    getPreference: (k: string) => (k in prefs ? prefs[k] : null),
    setPreference: (k: string, v: unknown) => {
      prefs[k] = v;
    },
    removePreference: (k: string) => {
      delete prefs[k];
    },
  } as unknown as ConfigStorage;
}

function normalize(status: number, data: unknown): ApiError {
  const client = new ApiClient({ baseUrl: 'http://api.test' });
  return (
    client as unknown as { normalizeError: (e: unknown) => ApiError }
  ).normalizeError({ message: 'Request failed', response: { status, data } });
}

describe('what the CLI says to a visitor', () => {
  it.each([
    [
      'SANDBOX_SIGN_IN_REQUIRED',
      'You are looking around a read-only demo. Install Flui on your own server to do this: https://flui.cloud/#install',
    ],
    [
      'VISITOR_GONE',
      'Your visit has ended. Start a new one with flui login --try',
    ],
    [
      'VISITOR_MERGED',
      'This visit now belongs to your account. Sign in with flui login',
    ],
  ])('%s', (code, text) => {
    expect(visitorErrorMessage(code)).toBe(text);
    expect(normalize(401, { code, message: 'server text' }).message).toBe(text);
  });

  it('leaves a blocked account and every other error with the server text', () => {
    expect(visitorErrorMessage('ACCOUNT_BLOCKED')).toBeNull();
    expect(
      normalize(403, {
        code: 'ACCOUNT_BLOCKED',
        message: 'This account has been blocked by an administrator.',
      }).message,
    ).toBe('This account has been blocked by an administrator.');
    expect(normalize(400, { message: 'bad' }).message).toBe('bad');
    expect(errorCodeOf('text')).toBeNull();
  });

  it('never tells a visitor to run `flui auth login` on a 401', () => {
    const gone = normalize(401, { code: 'VISITOR_GONE', message: 'x' });
    expect(controlPlaneHint(gone)).toBeNull();
    const raw = new ApiError('server text', 401, { code: 'VISITOR_MERGED' });
    expect(controlPlaneHint(raw)).toBe(
      'This visit now belongs to your account. Sign in with flui login',
    );
    expect(controlPlaneHint(new ApiError('x', 401, {}))).toContain(
      'flui auth login',
    );
  });
});

describe('the visitor marker on a profile', () => {
  it('is set by a visit and cleared by a normal sign-in', () => {
    const storage = storageStub();
    expect(visitorSessionOf(storage)).toBeNull();
    markVisitorSession(
      storage,
      '2026-10-20T10:00:00.000Z',
      new Date('2026-10-13T10:00:00.000Z'),
    );
    expect(visitorSessionOf(storage)).toEqual({
      since: '2026-10-13T10:00:00.000Z',
      until: '2026-10-20T10:00:00.000Z',
    });
    clearVisitorSession(storage);
    expect(visitorSessionOf(storage)).toBeNull();
  });
});

describe('the groups a visitor puts on its key', () => {
  it('names only the read groups it may hand on', () => {
    expect(
      visitorKeyGroups([
        { key: 'apps:look', depth: 'look', grantable: true },
        { key: 'apps:change', depth: 'change', grantable: false },
        { key: 'backups:look', depth: 'look', grantable: false },
        { key: 'observability:look', depth: 'look', grantable: true },
      ]),
    ).toEqual(['apps:look', 'observability:look']);
  });
});
