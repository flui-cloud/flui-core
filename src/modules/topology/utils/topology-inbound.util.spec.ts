import { inboundOf } from './topology-inbound.util';

describe('inboundOf', () => {
  const rule = (over: Record<string, unknown>) => ({
    direction: 'in' as const,
    protocol: 'tcp' as const,
    port: '443',
    sourceIps: ['0.0.0.0/0', '::/0'],
    description: 'HTTPS',
    ...over,
  });

  it('says nothing is known when Flui manages no firewall for the cluster', () => {
    expect(inboundOf(undefined)).toBeNull();
  });

  it('lists what is let in, by port, without the address ranges', () => {
    const inbound = inboundOf({
      lastAppliedRules: [
        rule({
          port: '6443',
          sourceIps: ['10.0.0.0/16'],
          description: 'API, inside',
        }),
        rule({ direction: 'out', port: '53' }),
        rule({}),
        rule({ protocol: 'icmp', port: undefined, description: 'Ping' }),
      ] as never,
    });
    expect(inbound).toEqual([
      {
        protocol: 'tcp',
        port: '443',
        description: 'HTTPS',
        fromAnywhere: true,
        sourceCount: 2,
      },
      {
        protocol: 'tcp',
        port: '6443',
        description: 'API, inside',
        fromAnywhere: false,
        sourceCount: 1,
      },
      {
        protocol: 'icmp',
        port: null,
        description: 'Ping',
        fromAnywhere: true,
        sourceCount: 2,
      },
    ]);
    expect(JSON.stringify(inbound)).not.toContain('10.0.0.0');
  });

  it('falls back to the rules asked for until some have been applied', () => {
    expect(
      inboundOf({
        lastAppliedRules: [],
        desiredRules: [rule({ port: '80' })] as never,
      })?.[0].port,
    ).toBe('80');
  });
});
