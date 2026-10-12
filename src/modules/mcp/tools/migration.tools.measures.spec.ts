import { MIGRATION_TOOLS } from './migration.tools';
import { ToolDef } from './mcp-tool.util';

const tool = (name: string) =>
  MIGRATION_TOOLS.find((t) => t.name === name) as ToolDef;

const physicalFull = {
  id: 'fm1',
  status: 'completed',
  kind: 'physical',
  link: { state: 'closed', handshakeSeen: true },
  fence: { appliedAt: '2026-10-11T10:00:00.000Z', released: false },
  baseBackup: { phase: 'done', lagBytes: null },
  writePauseMs: 6500,
  writePauseEndedBy: 'bridge',
  interruptionMs: 42000,
  nextSteps: [{ key: 'protect-database', text: 'Protect the new database.' }],
  rewirePlan: { env: [] },
};

describe('migration tools and the measures', () => {
  it("shows the model the API's kind, link, fence, copy, measures and next steps", () => {
    const view = tool('migration_get').forModel?.(physicalFull) as Record<
      string,
      unknown
    >;
    for (const key of [
      'kind',
      'link',
      'fence',
      'baseBackup',
      'writePauseMs',
      'writePauseEndedBy',
      'interruptionMs',
      'nextSteps',
    ]) {
      expect(view[key]).toEqual((physicalFull as Record<string, unknown>)[key]);
    }
    expect(view.rewirePlan).toBeUndefined();
  });

  it('keeps them in the list view too', () => {
    const list = tool('migration_list').forModel?.({
      app: [],
      db: [],
      full: [physicalFull],
    }) as { full: Record<string, unknown>[] };
    expect(list.full[0].writePauseMs).toBe(6500);
    expect(list.full[0].nextSteps).toEqual(physicalFull.nextSteps);
  });
});
