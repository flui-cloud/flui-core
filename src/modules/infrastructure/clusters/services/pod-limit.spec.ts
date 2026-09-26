jest.mock('@kubernetes/client-node', () => ({}));

import { podLimit } from './unschedulable-pods.service';

const parse = {
  parseCpu: (v: string) =>
    v.endsWith('m') ? Number(v.slice(0, -1)) : Number(v) * 1000,
  parseMemory: (v: string) => Number(v.replace('Mi', '')),
};

describe('podLimit', () => {
  it('adds each container at its limit, and at its request where it sets none', () => {
    const pod = {
      spec: {
        containers: [
          {
            resources: {
              requests: { cpu: '50m', memory: '64Mi' },
              limits: { cpu: '200m', memory: '128Mi' },
            },
          },
          { resources: { requests: { cpu: '100m', memory: '32Mi' } } },
          {},
        ],
      },
    };
    expect(podLimit(pod as never, parse as never)).toEqual({
      cpuMillicores: 300,
      memoryMi: 160,
    });
  });
});
