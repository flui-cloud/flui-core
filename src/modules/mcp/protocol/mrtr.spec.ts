import {
  InputResponses,
  acceptedContent,
  inputRequired,
  inputResponse,
  isInputRequired,
  readRequestState,
  readRound,
} from './mrtr';

/**
 * These no longer test an implementation of ours — section 7 reconducted the
 * seam onto `@modelcontextprotocol/server@2.0.0`, so what runs underneath is
 * the package's. They test the two things a re-export can still get wrong:
 * that the seam exposes the behaviour the tools were written against, and that
 * our own policy on top of it (elicitation only, unverified state given no
 * authority) is still the policy in force.
 */
describe('MRTR builders (MCP 2026-07-28, via the package)', () => {
  it('refuses a result that asks for nothing', () => {
    // Neither requests nor state means "retry, but change nothing" — a loop that
    // reads to the client as a working protocol. The specification's
    // at-least-one rule, enforced by the package's builder.
    expect(() => inputRequired({})).toThrow(TypeError);
    expect(() => inputRequired({ inputRequests: {} })).toThrow(TypeError);
  });

  it('accepts state alone, without any embedded request', () => {
    const result = inputRequired({ requestState: 'opaque' });
    expect(result).toEqual({
      resultType: 'input_required',
      requestState: 'opaque',
    });
  });

  it('builds a form elicitation in the wire shape', () => {
    const result = inputRequired({
      inputRequests: {
        secret: inputRequired.elicit({
          message: 'Value for DB_PASSWORD',
          requestedSchema: {
            type: 'object',
            properties: { value: { type: 'string', title: 'Value' } },
            required: ['value'],
          },
        }),
      },
      requestState: 'app-1/DB_PASSWORD',
    });

    expect(result.resultType).toBe('input_required');
    const ask = result.inputRequests?.secret;
    expect(ask?.method).toBe('elicitation/create');
    expect(ask?.params).toMatchObject({ mode: 'form' });
    expect(isInputRequired(result)).toBe(true);
  });

  it('builds a URL elicitation, and mints no elicitationId', () => {
    // 2026-07-28 drops the 2025-era `elicitationId`: correlation across retries
    // is the server's own identifier, carried in requestState.
    const req = inputRequired.elicitUrl({
      message: 'Finish in your browser',
      url: 'https://example.invalid/deliver',
    });
    expect(req.params).toEqual({
      mode: 'url',
      message: 'Finish in your browser',
      url: 'https://example.invalid/deliver',
    });
  });

  it('offers no builder for the two deprecated embedded requests', () => {
    // The package's own builder can also emit `sampling/createMessage` and
    // `roots/list`; SEP-2577 deprecates both. The seam's type hides them, and
    // this asserts the narrowing is real rather than a comment: the keys exist
    // on the runtime object (it IS the package's) but are unreachable through
    // the exported type, so a tool cannot reach for one by accident.
    const surface = inputRequired as unknown as Record<string, unknown>;
    expect(typeof surface.elicit).toBe('function');
    expect(typeof surface.elicitUrl).toBe('function');
    // @ts-expect-error — deliberately absent from the seam's type.
    expect(inputRequired.createMessage).toBeDefined();
    // @ts-expect-error — deliberately absent from the seam's type.
    expect(inputRequired.listRoots).toBeDefined();
  });

  it('does not mistake an ordinary result for an input request', () => {
    expect(isInputRequired({ ok: true })).toBe(false);
    expect(isInputRequired(null)).toBe(false);
    expect(isInputRequired({ resultType: 'complete' })).toBe(false);
  });
});

describe('MRTR retry leg', () => {
  const responses = { secret: { action: 'accept', content: { value: 'v' } } };

  it('reads the round off the SDK request context', () => {
    // The `_meta` bridge section 3 needed is gone with the SDK that forced it:
    // the 2026-07-28 codec lifts `inputResponses`/`requestState` out of the
    // params itself and hands them over here.
    const round = readRound({
      inputResponses: responses,
      requestState: <T>() => 'state-1' as T,
    });
    expect(round.inputResponses).toBe(responses);
    expect(round.requestState).toBe('state-1');
    expect(readRequestState(round)).toBe('state-1');
  });

  it('is empty on a first call', () => {
    expect(readRound({ requestState: () => undefined })).toEqual({});
    // A tool called from the assistant loop has no MCP request behind it.
    expect(readRound()).toEqual({});
  });

  it('drops a non-string state instead of trusting it', () => {
    // With no verify hook configured the accessor yields the raw wire value.
    // Anything that is not a string never becomes one here.
    const round = readRound({
      requestState: <T>() => ({ app: 'a' }) as T,
    });
    expect(round.requestState).toBeUndefined();
  });

  it('reads accepted content, and nothing else', () => {
    expect(acceptedContent(responses, 'secret')).toEqual({ value: 'v' });
    expect(
      acceptedContent({ secret: { action: 'decline' } }, 'secret'),
    ).toBeUndefined();
    expect(
      acceptedContent({ secret: { action: 'cancel' } }, 'secret'),
    ).toBeUndefined();
    expect(acceptedContent(responses, 'absent')).toBeUndefined();
    const firstCall: InputResponses | undefined = undefined;
    expect(acceptedContent(firstCall, 'secret')).toBeUndefined();
  });

  it('distinguishes declined from missing, which acceptedContent cannot', () => {
    expect(inputResponse({ secret: { action: 'decline' } }, 'secret')).toEqual({
      kind: 'elicit',
      action: 'decline',
    });
    expect(inputResponse(responses, 'absent')).toEqual({ kind: 'missing' });
    // A shape that is none of the three response kinds reads as missing — the
    // package collapses it, where the hand-written seam used to report it as
    // `unknown`. Recorded because it is a real difference, not an oversight.
    expect(inputResponse({ secret: 42 }, 'secret')).toEqual({
      kind: 'missing',
    });
  });
});
