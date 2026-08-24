import { z } from 'zod';
import {
  REDACTED,
  redactToolArgs,
  startedOperationId,
} from './tool-arg-redaction';
import { coerceBoolean, coerceNumber } from '../tools/mcp-tool.util';

describe('redactToolArgs', () => {
  it('keeps only values drawn from a set written in the source', () => {
    const shape = {
      id: z.string(),
      exposure: z.enum(['public', 'internal']),
      kind: z.literal('database'),
      enabled: z.boolean(),
      replicas: z.number(),
    };
    expect(
      redactToolArgs(shape, {
        id: 'app-1',
        exposure: 'internal',
        kind: 'database',
        enabled: true,
        replicas: 3,
      }),
    ).toEqual({
      id: REDACTED,
      exposure: 'internal',
      kind: 'database',
      enabled: true,
      replicas: 3,
    });
  });

  it('withholds a value that does not belong to its declared set', () => {
    // The assistant surface records before validation, so a field typed as an
    // enum can still be holding whatever the model put there.
    const shape = { exposure: z.enum(['public', 'internal']) };
    expect(redactToolArgs(shape, { exposure: 'sk_live_51H8xQ' })).toEqual({
      exposure: REDACTED,
    });
  });

  it('records nothing at all when the schema is unknown', () => {
    expect(redactToolArgs(undefined, { id: 'a' })).toBeNull();
    expect(redactToolArgs({ id: z.string() }, 'not-an-object')).toBeNull();
  });

  it('drops keys the schema never declared, names included', () => {
    // A key name is model-supplied text like any other, and a model that puts a
    // token where an argument name belongs must not have it written down.
    const out = redactToolArgs({ id: z.string() }, {
      id: 'a',
      sk_live_51H8xQ: true,
    } as Record<string, unknown>);
    expect(out).toEqual({ id: REDACTED });
    expect(JSON.stringify(out)).not.toContain('sk_live');
  });

  it('recurses into declared objects and withholds their free-form leaves', () => {
    const shape = {
      overrides: z
        .object({
          name: z.string(),
          exposure: z.enum(['public', 'internal']).optional(),
          domain: z.object({ tls: z.boolean() }).optional(),
        })
        .strict(),
    };
    expect(
      redactToolArgs(shape, {
        overrides: {
          name: 'my-secret-name',
          exposure: 'public',
          domain: { tls: true },
        },
      }),
    ).toEqual({
      overrides: {
        name: REDACTED,
        exposure: 'public',
        domain: { tls: true },
      },
    });
  });

  it('sees through optional, default and coercion wrappers', () => {
    const shape = {
      mode: z.enum(['live', 'restore']).optional(),
      tls: coerceBoolean().optional(),
      limit: coerceNumber(z.number().int()).optional(),
      note: z.string().default('x'),
    };
    expect(
      redactToolArgs(shape, {
        mode: 'restore',
        tls: true,
        limit: 50,
        note: 'anything',
      }),
    ).toEqual({ mode: 'restore', tls: true, limit: 50, note: REDACTED });
  });

  it('withholds an array unless every element is itself a declared case', () => {
    const shape = {
      tags: z.array(z.string()),
      modes: z.array(z.enum(['a', 'b'])),
      mixed: z.array(z.enum(['a', 'b'])),
    };
    expect(
      redactToolArgs(shape, {
        tags: ['prod', 'eu'],
        modes: ['a', 'b'],
        mixed: ['a', 'hunter2'],
      }),
    ).toEqual({ tags: REDACTED, modes: ['a', 'b'], mixed: REDACTED });
  });

  it('never lets a record through — this is where a password lands', () => {
    // The exact shape `app_install` declares. `userInputs` is what a person is
    // asked to fill in at install time, and an admin password is one of them.
    const shape = {
      slug: z.string(),
      userInputs: z.record(z.string(), z.string()).optional(),
      envOverrides: z.record(z.string(), z.string()).optional(),
      options: z.record(z.string(), z.boolean()).optional(),
    };
    const out = redactToolArgs(shape, {
      slug: 'nextcloud',
      userInputs: { ADMIN_PASSWORD: 'hunter2-correct-horse' },
      envOverrides: { STRIPE_SECRET_KEY: 'sk_live_51H8xQabcdef' },
      options: { smtp: true },
    });
    const written = JSON.stringify(out);
    expect(written).not.toContain('hunter2');
    expect(written).not.toContain('sk_live');
    expect(written).not.toContain('ADMIN_PASSWORD');
    expect(out).toEqual({
      slug: REDACTED,
      userInputs: REDACTED,
      envOverrides: REDACTED,
      options: REDACTED,
    });
  });

  it('withholds a whole manifest passed as one string', () => {
    const yaml = 'env:\n  STRIPE_SECRET_KEY: sk_live_51H8xQabcdef\n';
    const out = redactToolArgs({ yaml: z.string() }, { yaml });
    expect(JSON.stringify(out)).not.toContain('sk_live');
    expect(out).toEqual({ yaml: REDACTED });
  });

  it('distinguishes an argument passed as null from one withheld', () => {
    expect(redactToolArgs({ id: z.string().nullable() }, { id: null })).toEqual(
      {
        id: null,
      },
    );
  });

  it('omits an argument that was not passed', () => {
    expect(
      redactToolArgs(
        { id: z.string(), mode: z.enum(['a']).optional() },
        { id: 'x' },
      ),
    ).toEqual({ id: REDACTED });
  });
});

describe('startedOperationId', () => {
  const uuid = '3f1a9b0e-2c4d-4e6f-8a1b-9c0d1e2f3a4b';

  it('reads the handle of an operation the call started', () => {
    expect(startedOperationId({ operationId: uuid, status: 'PENDING' })).toBe(
      uuid,
    );
  });

  it('reads nothing else off a result', () => {
    expect(startedOperationId({ id: uuid, token: 'sk_live_x' })).toBeNull();
    expect(startedOperationId({ operationId: 'not-a-uuid' })).toBeNull();
    expect(startedOperationId('done')).toBeNull();
    expect(startedOperationId(null)).toBeNull();
  });
});
