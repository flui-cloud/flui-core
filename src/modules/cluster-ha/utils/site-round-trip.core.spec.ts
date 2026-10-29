import {
  parsePingOutput,
  pingScript,
  roundTripPlan,
} from './site-round-trip.core';

describe('round trips between locations', () => {
  const servers = [
    { zone: 'hel1', node: 'w3', address: '10.0.0.4' },
    { zone: 'fsn1', node: 'master', address: '10.0.0.2' },
    { zone: 'fsn1', node: 'w2', address: '10.0.0.5' },
    { zone: 'nbg1', node: 'w1', address: '10.0.0.3' },
  ];

  it('measures each pair of locations once, from one server in each', () => {
    expect(
      roundTripPlan(servers).map((p) => [p.from.node, p.to.map((t) => t.node)]),
    ).toEqual([
      ['master', ['w3', 'w1']],
      ['w3', ['w1']],
    ]);
  });

  it('reads the average of busybox ping, and null when nothing came back', () => {
    const out = [
      '10.0.0.4 round-trip min/avg/max = 34.120/35.004/36.510 ms',
      '10.0.0.3 ',
    ].join('\n');
    expect([...parsePingOutput(out)]).toEqual([
      ['10.0.0.4', 35.004],
      ['10.0.0.3', null],
    ]);
    expect(pingScript(['10.0.0.4'])).toContain('ping -c 3 -W 2 -q 10.0.0.4');
  });
});
