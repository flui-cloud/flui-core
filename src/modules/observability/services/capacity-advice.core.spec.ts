import {
  CapacityInput,
  adviseCapacity,
  placedByCluster,
  capacityThresholds,
  measuresFrom,
} from './capacity-advice.core';

const limits = capacityThresholds({});
const quiet = {
  throttledPercent: 2,
  cpuPercent: 30,
  memoryPercent: 40,
  readinessFailures: 0,
  restartsByLiveness: 0,
};
const base: CapacityInput = {
  kind: 'Deployment',
  desired: 1,
  ready: 1,
  autoscaling: { enabled: false, max: 1 },
  waitingForNode: null,
  nextCopy: null,
  measures: quiet,
};

describe('adviseCapacity', () => {
  it('says nothing is needed when the copies keep up', () => {
    expect(adviseCapacity(base, limits)).toMatchObject({
      advice: 'none',
      reasons: [],
    });
  });

  it('asks for another copy when the one there is held back, as on staging under load', () => {
    const verdict = adviseCapacity(
      {
        ...base,
        measures: {
          ...quiet,
          throttledPercent: 91,
          cpuPercent: 100,
          readinessFailures: 15,
        },
        nextCopy: { verdict: 'fits', sentence: 'Fits on worker-1.' },
      },
      limits,
    );
    expect(verdict.advice).toBe('add_replicas');
    expect(verdict.sentence).toContain('Run 2 copies');
    expect(verdict.reasons).toHaveLength(3);
  });

  it('says the scaling group buys the node the next copy needs', () => {
    expect(
      adviseCapacity(
        {
          ...base,
          measures: { ...quiet, cpuPercent: 95 },
          nextCopy: { verdict: 'buys', sentence: 'Buys a cx22.' },
        },
        limits,
      ).sentence,
    ).toContain('buys a node');
  });

  it('asks for a node when the next copy has nowhere to run', () => {
    for (const verdict of ['proposes', 'nothing-hosts']) {
      expect(
        adviseCapacity(
          {
            ...base,
            measures: { ...quiet, cpuPercent: 95 },
            nextCopy: { verdict, sentence: 'No node has room.' },
          },
          limits,
        ).advice,
      ).toBe('add_node');
    }
  });

  it('reports copies already waiting for a node before anything else', () => {
    expect(
      adviseCapacity(
        {
          ...base,
          waitingForNode: {
            replicas: 1,
            says: '2 requested · 1 running · 1 waiting for a new node',
          },
        },
        limits,
      ).advice,
    ).toBe('wait_for_node');
  });

  it('leaves the count to the autoscaler, and asks for a higher maximum once it is reached', () => {
    const busy = { ...base, measures: { ...quiet, cpuPercent: 95 } };
    expect(
      adviseCapacity(
        { ...busy, desired: 2, autoscaling: { enabled: true, max: 4 } },
        limits,
      ).advice,
    ).toBe('autoscaler_adding');
    expect(
      adviseCapacity(
        { ...busy, desired: 4, autoscaling: { enabled: true, max: 4 } },
        limits,
      ).advice,
    ).toBe('raise_autoscale_max');
  });

  it('does not offer copies to an application that keeps data on each one', () => {
    expect(
      adviseCapacity(
        {
          ...base,
          kind: 'StatefulSet',
          measures: { ...quiet, throttledPercent: 60 },
        },
        limits,
      ).advice,
    ).toBe('one_copy_only');
  });

  it('separates memory near its limit from a busy copy', () => {
    expect(
      adviseCapacity(
        { ...base, measures: { ...quiet, memoryPercent: 95 } },
        limits,
      ).advice,
    ).toBe('watch_memory');
  });

  it('does not judge what was not measured', () => {
    expect(
      adviseCapacity(
        {
          ...base,
          measures: {
            throttledPercent: null,
            cpuPercent: null,
            memoryPercent: null,
            readinessFailures: null,
            restartsByLiveness: null,
          },
        },
        limits,
      ).advice,
    ).toBe('unknown');
  });
});

describe('measuresFrom', () => {
  it('takes the median of throttling and CPU, keeps the memory peak, and drops counts it could not read', () => {
    expect(
      measuresFrom(
        [
          {
            cpu_throttled_percent: 80,
            cpu_utilization_percent: 100,
            memory_utilization_percent: 40,
          },
          {
            cpu_throttled_percent: 20,
            cpu_utilization_percent: 60,
            memory_utilization_percent: 70,
          },
          {},
        ],
        { readinessBusy: 4, restartsByLiveness: 1, read: false },
      ),
    ).toEqual({
      throttledPercent: 50,
      cpuPercent: 80,
      memoryPercent: 70,
      readinessFailures: null,
      restartsByLiveness: null,
    });
  });

  it('does not mistake a copy starting up for a busy one', () => {
    const minutes = [
      88, 79, 17, 13, 12, 18, 14, 11, 16, 15, 12, 14, 13, 17, 12,
    ];
    const measures = measuresFrom(
      minutes.map((cpu_throttled_percent) => ({ cpu_throttled_percent })),
      { readinessBusy: 0, restartsByLiveness: 0, read: true },
    );
    expect(measures.throttledPercent).toBe(14);
    expect(
      adviseCapacity({ ...base, measures: { ...quiet, ...measures } }, limits)
        .advice,
    ).toBe('none');
  });

  it('reads thresholds from the environment, with today’s values by default', () => {
    expect(capacityThresholds({})).toEqual({
      windowMinutes: 15,
      throttledPercent: 40,
      cpuPercent: 90,
      memoryPercent: 90,
      readinessFailures: 3,
    });
    expect(
      capacityThresholds({ FLUI_ADVICE_CPU_PERCENT: '75' }).cpuPercent,
    ).toBe(75);
  });
});

describe('placedByCluster', () => {
  const worker = {
    takesWork: true,
    allocatable: { cpuMillicores: 2000, memoryMi: 3800 },
    requested: { cpuMillicores: 1800, memoryMi: 2450 },
  };

  it('places a small copy in what the scaling engine keeps as margin, as the staging worker did', () => {
    expect(
      placedByCluster([worker], { cpuMillicores: 100, memoryMi: 128 }),
    ).toBe(true);
    expect(
      placedByCluster([worker], { cpuMillicores: 300, memoryMi: 128 }),
    ).toBe(false);
  });

  it('never counts a node that takes no work', () => {
    expect(
      placedByCluster([{ ...worker, takesWork: false }], {
        cpuMillicores: 100,
        memoryMi: 128,
      }),
    ).toBe(false);
  });

  it('says there is room, not that a node is bought, when the copy fits in the margin', () => {
    const verdict = adviseCapacity(
      {
        ...base,
        measures: { ...quiet, cpuPercent: 95 },
        nextCopy: { verdict: 'margin', sentence: '…' },
        fitsInMargin: true,
      },
      limits,
    );
    expect(verdict.advice).toBe('add_replicas');
    expect(verdict.sentence).not.toContain('buys');
  });
});
