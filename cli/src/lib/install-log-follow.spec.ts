import { InstallLogChunk, followInstallLog } from './install-log-follow';

const chunk = (over: Partial<InstallLogChunk>): InstallLogChunk => ({
  operationId: 'op-1',
  status: 'IN_PROGRESS',
  text: '',
  since: 0,
  next: 0,
  more: false,
  captured: true,
  truncated: false,
  done: false,
  note: null,
  ...over,
});

const script = (answers: InstallLogChunk[]) => {
  const asked: number[] = [];
  const read = jest.fn(async (since: number) => {
    asked.push(since);
    const next = answers.shift();
    if (!next) throw new Error('read past the script');
    return next;
  });
  return { read, asked };
};

describe('following a node install log', () => {
  it('reads once and stops without --follow, draining what is already there', async () => {
    const { read, asked } = script([
      chunk({ text: 'a', next: 1, more: true }),
      chunk({ text: 'b', since: 1, next: 2 }),
    ]);
    const out: string[] = [];
    await followInstallLog({
      read,
      write: (t) => out.push(t),
      follow: false,
      intervalMs: 1000,
    });
    expect(out.join('')).toBe('ab');
    expect(asked).toEqual([0, 1]);
  });

  it('keeps reading from the cursor until done, waiting only when caught up', async () => {
    const { read, asked } = script([
      chunk({ text: 'one\n', next: 4 }),
      chunk({ since: 4, next: 4 }),
      chunk({ text: 'two\n', since: 4, next: 8, more: true }),
      chunk({
        text: 'end\n',
        since: 8,
        next: 12,
        status: 'COMPLETED',
        done: true,
      }),
    ]);
    const sleep = jest.fn(async () => undefined);
    const out: string[] = [];
    const last = await followInstallLog({
      read,
      write: (t) => out.push(t),
      follow: true,
      intervalMs: 3000,
      sleep,
    });
    expect(out.join('')).toBe('one\ntwo\nend\n');
    expect(asked).toEqual([0, 4, 4, 8]);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(last.status).toBe('COMPLETED');
  });

  it('stops on a finished operation that never captured anything', async () => {
    const { read } = script([
      chunk({ captured: false, done: true, status: 'FAILED', note: 'none' }),
    ]);
    const last = await followInstallLog({
      read,
      write: () => undefined,
      follow: true,
      intervalMs: 3000,
      sleep: async () => undefined,
    });
    expect(last.note).toBe('none');
  });
});
