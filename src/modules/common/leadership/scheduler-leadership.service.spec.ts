import { SchedulerLeadershipService } from './scheduler-leadership.service';

/** One Postgres advisory lock, shared by every simulated copy of the API. */
class FakeDatabase {
  holder: number | null = null;
  private nextPid = 1;
  failing = new Set<number>();

  runner() {
    const pid = this.nextPid++;
    return {
      isReleased: false,
      async connect() {},
      query: async (sql: string) => {
        if (this.failing.has(pid)) throw new Error('connection reset');
        if (sql.includes('pg_try_advisory_lock')) {
          if (this.holder === null) this.holder = pid;
          return [{ held: this.holder === pid }];
        }
        if (sql.includes('pg_locks')) return this.holder === pid ? [{}] : [];
        if (sql.includes('pg_advisory_unlock')) {
          if (this.holder === pid) this.holder = null;
          return [{}];
        }
        return [];
      },
      async release() {
        this.isReleased = true;
      },
      pid,
    };
  }
}

const job = (callback: () => unknown = () => undefined) => {
  let active = true;
  return {
    _callbacks: [callback],
    fire(this: { _callbacks: Array<() => unknown> }) {
      return this._callbacks[0]();
    },
    get isActive() {
      return active;
    },
    start: jest.fn(() => {
      active = true;
    }),
    stop: jest.fn(() => {
      active = false;
    }),
  };
};

const copy = (db: FakeDatabase, callback?: () => unknown) => {
  const jobs = [job(callback), job()];
  const local = job();
  let runner: ReturnType<FakeDatabase['runner']> | null = null;
  const service = new SchedulerLeadershipService(
    {
      createQueryRunner: () => {
        runner = db.runner();
        return runner;
      },
    } as never,
    {
      getCronJobs: () =>
        new Map([
          ...jobs.map((j, i) => [`job${i}`, j] as const),
          ['local:memory', local] as const,
        ]),
    } as never,
  );
  return { service, jobs, local, pid: () => runner?.pid };
};

describe('one copy of the API runs the scheduled work', () => {
  it('lets one copy lead and stops the jobs of the other', async () => {
    const db = new FakeDatabase();
    const a = copy(db);
    const b = copy(db);
    await a.service.check();
    await b.service.check();
    expect(a.service.isLeader()).toBe(true);
    expect(b.service.isLeader()).toBe(false);
    expect(a.jobs.every((j) => j.isActive)).toBe(true);
    expect(b.jobs.every((j) => !j.isActive)).toBe(true);
    expect(b.local.isActive).toBe(true);
    expect(b.local.stop).not.toHaveBeenCalled();
  });

  it('hands the work over when the leader stops, within one check', async () => {
    const db = new FakeDatabase();
    const a = copy(db);
    const b = copy(db);
    await a.service.check();
    await b.service.check();
    await a.service.onApplicationShutdown();
    expect(a.jobs.every((j) => !j.isActive)).toBe(true);
    await b.service.check();
    expect(b.service.isLeader()).toBe(true);
    expect(b.jobs.every((j) => j.isActive)).toBe(true);
  });

  it('stops its jobs as soon as it loses the database, and lets the lock go', async () => {
    const db = new FakeDatabase();
    const a = copy(db);
    await a.service.check();
    db.failing.add(a.pid()!);
    await a.service.check();
    expect(a.service.isLeader()).toBe(false);
    expect(a.jobs.every((j) => !j.isActive)).toBe(true);
  });

  it('keeps leading across checks without taking the lock again', async () => {
    const db = new FakeDatabase();
    const a = copy(db);
    await a.service.check();
    await a.service.check();
    await a.service.check();
    expect(a.service.isLeader()).toBe(true);
    expect(a.jobs[0].start).not.toHaveBeenCalled();
  });

  it('tells listeners when leadership changes', async () => {
    const db = new FakeDatabase();
    const a = copy(db);
    const seen: boolean[] = [];
    a.service.onChange((l) => seen.push(l));
    await a.service.check();
    await a.service.onApplicationShutdown();
    expect(seen).toEqual([false, true, false]);
  });

  it('keeps the lock until a run already started has finished', async () => {
    const db = new FakeDatabase();
    let finish!: () => void;
    const a = copy(
      db,
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    const b = copy(db);
    await a.service.check();
    void a.jobs[0].fire();

    let stopped = false;
    const stopping = a.service
      .onApplicationShutdown()
      .then(() => (stopped = true));
    await new Promise((r) => setImmediate(r));
    expect(stopped).toBe(false);
    await b.service.check();
    expect(b.service.isLeader()).toBe(false);

    finish();
    await stopping;
    await b.service.check();
    expect(b.service.isLeader()).toBe(true);
  });

  it('does not wait for ever on a run that never ends', async () => {
    const db = new FakeDatabase();
    const a = copy(db, () => new Promise<void>(() => undefined));
    await a.service.check();
    void a.jobs[0].fire();
    const started = Date.now();
    await a.service.drain(50);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('passes a failing run through to the cron library unchanged', async () => {
    const db = new FakeDatabase();
    const a = copy(db, async () => {
      throw new Error('tick failed');
    });
    await a.service.check();
    await expect(a.jobs[0].fire()).rejects.toThrow('tick failed');
    await a.service.drain(50);
  });
});
