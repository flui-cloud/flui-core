import { humanBytes, importLines } from './db-import-view';

const view = {
  id: 'i',
  engine: 'postgres' as const,
  status: 'streaming' as const,
  source: { host: 'db.example.com', port: 5432, database: 'shop', user: 'rep' },
  tablesTotal: 12,
  tablesCopied: 12,
  lagBytes: 2048,
  lagSeconds: null,
  tablesWithoutKey: ['public.events'],
  detail: null,
};

describe('db import in the CLI', () => {
  it('says how far it got and what comes next', () => {
    const text = importLines(view, 'pg-1').join('\n');
    expect(text).toContain('12 of 12 copied');
    expect(text).toContain('2.0 KB of changes not yet applied');
    expect(text).toContain('public.events');
    expect(text).toContain('flui db import pg-1 --switch');
  });

  it('does not offer the switch once it is over', () => {
    const text = importLines(
      { ...view, status: 'completed', lagBytes: null },
      'pg-1',
    ).join('\n');
    expect(text).not.toContain('--switch');
    expect(text).not.toContain('Behind');
  });

  it('shows a MariaDB copy behind in seconds', () => {
    const text = importLines(
      {
        ...view,
        engine: 'mariadb',
        lagBytes: null,
        lagSeconds: 4,
        tablesWithoutKey: [],
      },
      'db',
    ).join('\n');
    expect(text).toContain('Behind: 4 s');
  });

  it('sizes bytes for people', () => {
    expect(humanBytes(512)).toBe('512 B');
    expect(humanBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(humanBytes(300 * 1024 * 1024)).toBe('300 MB');
  });
});
