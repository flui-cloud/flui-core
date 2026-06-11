import { ALL_TOOLS, toOpenAiTool } from './tool-registry';

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
    });
  });

  it('every tool name matches OpenAI’s function-name pattern', () => {
    const pattern = /^[a-zA-Z0-9_-]{1,64}$/;
    for (const def of ALL_TOOLS) {
      expect(def.name).toMatch(pattern);
    }
  });
});
