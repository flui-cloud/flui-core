import { parseReplicatedPoolOutput } from './replicated-volumes.core';
import {
  missingVoteWarnings,
  replicatedVoteHostScript,
} from './replicated-votes.core';

describe('replicated-votes.core', () => {
  describe('missingVoteWarnings', () => {
    const nodes = (list: object[]) => JSON.stringify([list]);

    it('names a tie-breaker the volume engine does not list', () => {
      const warnings = missingVoteWarnings(
        ['ha-hz-worker-2'],
        nodes([
          { name: 'ha-hz-master', connection_status: 'ONLINE' },
          { name: 'ha-hz-worker-1', connection_status: 'ONLINE' },
        ]),
      );
      expect(warnings).toEqual([
        expect.stringMatching(
          /^ha-hz-worker-2 does not hold the tie-breaking vote yet/,
        ),
      ]);
    });

    it('names one listed but not online, and says nothing for one that is', () => {
      expect(
        missingVoteWarnings(
          ['a', 'b'],
          nodes([
            { name: 'a', connection_status: 'OFFLINE' },
            { name: 'b', connection_status: 'ONLINE' },
          ]),
        ),
      ).toHaveLength(1);
    });

    it('says nothing when it cannot read the answer', () => {
      expect(missingVoteWarnings(['a'], 'not json')).toEqual([]);
    });
  });

  describe('replicatedVoteHostScript', () => {
    it('installs the headers the vote needs, and nothing that holds data', () => {
      const script = replicatedVoteHostScript();
      expect(script).toContain('linux-headers-$KREL');
      expect(script).toContain('KFLAVOUR="linux-headers-${KREL##*-}"');
      expect(script).toContain('! dpkg -s "$KFLAVOUR"');
      expect(script).toContain('echo "HEADERS $KREL"');
      expect(script).not.toMatch(/vgcreate|fallocate|losetup/);
    });

    it('is read as ready, or as missing headers', () => {
      expect(parseReplicatedPoolOutput('HEADERS 6.8.0-138-generic')).toEqual({
        kind: 'ready',
        sizeGiB: 0,
      });
      expect(parseReplicatedPoolOutput('NOHEADERS 6.8.0-138-generic')).toEqual({
        kind: 'no-headers',
        kernel: '6.8.0-138-generic',
      });
    });
  });
});
