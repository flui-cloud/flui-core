import { ALL_TOOLS, assistantDescription, toOpenAiTool } from './tool-registry';

describe('toOpenAiTool', () => {
  // OpenAI's function-schema validator 400s the whole request on these keywords;
  // Scaleway/Mistral tolerate them. They must never reach the wire.
  const FORBIDDEN = ['$schema', 'propertyNames'];

  it.each(ALL_TOOLS.map((d) => d.name))(
    'emits an OpenAI-safe parameters schema for %s',
    (name) => {
      const def = ALL_TOOLS.find((d) => d.name === name)!;
      const json = JSON.stringify(toOpenAiTool(def).function.parameters);
      for (const key of FORBIDDEN) {
        expect(json).not.toContain(`"${key}"`);
      }
    },
  );

  it('keeps z.record dictionaries as additionalProperties (semantics preserved)', () => {
    const install = ALL_TOOLS.find((d) => d.name === 'app_install');
    const params = toOpenAiTool(install!).function.parameters as {
      properties: Record<
        string,
        { type: string; additionalProperties?: unknown }
      >;
    };
    expect(params.properties.options).toEqual({
      type: 'object',
      additionalProperties: { type: 'boolean' },
      description: expect.any(String),
    });
  });

  it('every tool name matches OpenAI’s function-name pattern', () => {
    const pattern = /^[a-zA-Z0-9_-]{1,64}$/;
    for (const def of ALL_TOOLS) {
      expect(def.name).toMatch(pattern);
    }
  });
});

describe('assistantDescription', () => {
  it('uses the summary only when asked for the brief form', () => {
    const def = ALL_TOOLS.find((d) => d.name === 'app_logs')!;
    expect(toOpenAiTool(def, true).function.description).toBe(def.summary);
    expect(toOpenAiTool(def).function.description).toBe(def.description);
  });

  it('cuts a long description on a sentence boundary, never past 320 characters', () => {
    for (const def of ALL_TOOLS) {
      const text = assistantDescription(def);
      expect(text.length).toBeLessThanOrEqual(321);
      if (!def.summary && def.description.length <= 320) {
        expect(text).toBe(def.description);
      }
    }
    const long = ALL_TOOLS.find((d) => d.name === 'scaling_group_set')!;
    expect(assistantDescription(long).endsWith('.')).toBe(true);
  });

  it('keeps every summary short', () => {
    for (const def of ALL_TOOLS.filter((d) => d.summary)) {
      expect(def.summary!.length).toBeLessThanOrEqual(200);
    }
  });
});
