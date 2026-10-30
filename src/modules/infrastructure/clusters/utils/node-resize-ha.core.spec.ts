import {
  growCopiesScript,
  resizeHaRefusal,
  switchoverTarget,
} from './node-resize-ha.core';

describe('resizing a node of a cluster across three locations', () => {
  const base = {
    clusterName: 'lab',
    nodeName: 'w1',
    serversNotReady: [],
    otherResizeRunning: null,
    staleCopies: [],
  };

  it('lets one healthy node at a time go', () => {
    expect(resizeHaRefusal(base)).toBeNull();
    expect(resizeHaRefusal({ ...base, serversNotReady: ['w1'] })).toBeNull();
  });

  it('refuses a second node at once, a server already down, or a copy behind', () => {
    expect(resizeHaRefusal({ ...base, otherResizeRunning: 'w3' })).toContain(
      'one node is switched off at a time',
    );
    expect(resizeHaRefusal({ ...base, serversNotReady: ['w3'] })).toContain(
      'w3 is not ready',
    );
    expect(
      resizeHaRefusal({
        ...base,
        staleCopies: [
          'The copy of p/data on w2 is not up to date (Inconsistent): until it is, losing w1 stops the volume.',
        ],
      }),
    ).toContain('once every copy is up to date');
  });

  it('hands a primary on the node to a ready copy elsewhere, in a location for data first', () => {
    const zoneOf = new Map([
      ['w1', 'nbg1'],
      ['m', 'fsn1'],
      ['w3', 'hel1'],
    ]);
    const instances = [
      { name: 'db-1', node: 'w1', ready: true },
      { name: 'db-2', node: 'w3', ready: true },
      { name: 'db-3', node: 'm', ready: true },
    ];
    expect(
      switchoverTarget({
        primary: 'db-1',
        nodeName: 'w1',
        instances,
        zoneOf,
        preferredZones: ['fsn1', 'nbg1'],
      }),
    ).toBe('db-3');
    expect(
      switchoverTarget({
        primary: 'db-2',
        nodeName: 'w1',
        instances,
        zoneOf,
        preferredZones: ['fsn1', 'nbg1'],
      }),
    ).toBeNull();
  });

  it('grows the space for copies without ever shrinking it', () => {
    const script = growCopiesScript(
      '/var/lib/flui/replicated.img',
      'flui-replicated',
      40,
    );
    expect(script).toContain('[ "$WANT" -gt "$NOW" ] || { echo "UNCHANGED');
    expect(script).toContain('losetup -c "$DEV"');
    expect(script).toContain('pvresize -q "$DEV"');
    expect(() => growCopiesScript('/f', 'vg', 0)).toThrow();
  });
});
