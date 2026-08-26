import {
  ACTION_PROPOSAL_CODE,
  PROPOSAL_STATUS,
  argsDigest,
  bindingOf,
  composeSentence,
  concessionCovers,
  isProposalLive,
  readProposalRefusal,
  renderRoute,
  renderSentence,
  stripApiPrefix,
} from './action-cycle.core';

describe('action cycle — the vocabulary a concession is written in', () => {
  describe('the edge a request can state', () => {
    it('binds the parameters a declaration names', () => {
      expect(bindingOf(['id'], { id: 'c-1', other: 'x' })).toEqual({
        id: 'c-1',
      });
    });

    it('states no edge at all rather than half of one', () => {
      // Fail-closed: a partially known resource is a WIDER standing permission
      // than anybody agreed to, so the answer is "no edge", never "this much".
      expect(
        bindingOf(['clusterId', 'nodeId'], { clusterId: 'c-1' }),
      ).toBeUndefined();
      expect(bindingOf(['id'], {})).toBeUndefined();
      expect(bindingOf(undefined, { id: 'c-1' })).toBeUndefined();
    });
  });

  describe('does a standing concession cover this call', () => {
    const concession = {
      action: 'POST /infrastructure/clusters/:id/workers',
      binding: { id: 'cluster-a' },
      keyId: 'key-1',
      revokedAt: null,
    };

    it('covers the resource it was pinned to', () => {
      expect(
        concessionCovers(concession, {
          method: 'POST',
          path: '/infrastructure/clusters/cluster-a/workers',
          binding: { id: 'cluster-a' },
          keyId: 'key-1',
        }),
      ).toBe(true);
    });

    it('does not cover a second cluster — that is the door/floor difference', () => {
      expect(
        concessionCovers(concession, {
          method: 'POST',
          path: '/infrastructure/clusters/cluster-b/workers',
          binding: { id: 'cluster-b' },
          keyId: 'key-1',
        }),
      ).toBe(false);
    });

    it('does not cover another route of the same shape family', () => {
      expect(
        concessionCovers(concession, {
          method: 'DELETE',
          path: '/infrastructure/clusters/cluster-a/workers',
          binding: { id: 'cluster-a' },
          keyId: 'key-1',
        }),
      ).toBe(false);
      expect(
        concessionCovers(concession, {
          method: 'POST',
          path: '/infrastructure/clusters/cluster-a/workers/extra',
          binding: { id: 'cluster-a' },
          keyId: 'key-1',
        }),
      ).toBe(false);
    });

    it('is given to one credential, not to a person', () => {
      expect(
        concessionCovers(concession, {
          method: 'POST',
          path: '/infrastructure/clusters/cluster-a/workers',
          binding: { id: 'cluster-a' },
          keyId: 'key-2',
        }),
      ).toBe(false);
      expect(
        concessionCovers(concession, {
          method: 'POST',
          path: '/infrastructure/clusters/cluster-a/workers',
          binding: { id: 'cluster-a' },
        }),
      ).toBe(false);
    });

    it('stops covering the instant it is revoked', () => {
      expect(
        concessionCovers(
          { ...concession, revokedAt: new Date() },
          {
            method: 'POST',
            path: '/infrastructure/clusters/cluster-a/workers',
            binding: { id: 'cluster-a' },
            keyId: 'key-1',
          },
        ),
      ).toBe(false);
    });
  });

  describe('the identity of one attempt', () => {
    it('is stable under key order, so a retry asks once', () => {
      const a = argsDigest('POST /x', { id: '1' }, { b: 2, a: 1 });
      const b = argsDigest('POST /x', { id: '1' }, { a: 1, b: 2 });
      expect(a).toBe(b);
    });

    it('changes when the resource or the arguments change', () => {
      const base = argsDigest('POST /x', { id: '1' }, { count: 1 });
      expect(argsDigest('POST /x', { id: '2' }, { count: 1 })).not.toBe(base);
      expect(argsDigest('POST /x', { id: '1' }, { count: 5 })).not.toBe(base);
      expect(argsDigest('POST /y', { id: '1' }, { count: 1 })).not.toBe(base);
    });

    it('keeps no trace of the arguments themselves', () => {
      // A catalog install carries `userInputs`, and that is where an admin
      // password lands. Only the hash is stored, so the secret cannot be read
      // back out of a table built to be shown to a person.
      const digest = argsDigest('POST /x', undefined, {
        userInputs: { adminPassword: 'hunter2-correct-horse' },
      });
      expect(digest).not.toContain('hunter2');
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  it('renders the sentence a person reads from the bound resource', () => {
    expect(
      renderSentence('add worker nodes to cluster {id}', { id: 'c-1' }),
    ).toBe('add worker nodes to cluster c-1');
    // No binding means no substitution — and such a request never offers
    // "always" anyway, so the template is never shown as a standing sentence.
    expect(renderSentence('deploy {id}', undefined)).toBe('deploy {id}');
  });

  describe('the half of the sentence the route parameters cannot say', () => {
    const level = (body: unknown) =>
      (body as { level?: string } | undefined)?.level === 'global'
        ? 'every tenant reads it'
        : undefined;

    it('adds what the body says to what the template says', () => {
      expect(
        composeSentence('write a note', undefined, level, { level: 'global' }),
      ).toBe('write a note — every tenant reads it');
    });

    it('leaves the sentence exactly as declared when there is no clause', () => {
      expect(
        composeSentence('deploy {id}', { id: 'a-1' }, undefined, {
          level: 'global',
        }),
      ).toBe('deploy a-1');
    });

    it('says only what it can when the body does not say', () => {
      expect(composeSentence('write a note', undefined, level, {})).toBe(
        'write a note',
      );
      expect(composeSentence('write a note', undefined, () => '   ', {})).toBe(
        'write a note',
      );
    });

    /**
     * Guards run before validation, so the body here is whatever was posted.
     * Half a sentence is a worse answer than the whole one; refusing the call
     * because the prose failed would be worse than either.
     */
    it('keeps the sentence when the clause throws', () => {
      expect(
        composeSentence(
          'write a note',
          undefined,
          () => {
            throw new Error('unvalidated body');
          },
          { level: 42 },
        ),
      ).toBe('write a note');
    });
  });

  it('fills an estimate route, or refuses to invent one', () => {
    expect(
      renderRoute('/infrastructure/clusters/:id/capacity-plan', { id: 'c-1' }),
    ).toBe('/infrastructure/clusters/c-1/capacity-plan');
    expect(renderRoute('/clusters/:id/plan', {})).toBeUndefined();
  });

  it('strips the API prefix so patterns match what is declared', () => {
    expect(stripApiPrefix('/api/v1/applications/a-1/deploy')).toBe(
      '/applications/a-1/deploy',
    );
    expect(stripApiPrefix('/applications/a-1/deploy')).toBe(
      '/applications/a-1/deploy',
    );
  });

  describe('a proposal is only answerable while it is live', () => {
    it('is live while pending and unexpired', () => {
      expect(
        isProposalLive({
          status: PROPOSAL_STATUS.PENDING,
          expiresAt: new Date(Date.now() + 60_000),
        }),
      ).toBe(true);
    });

    it('is not live once the estimate on it has gone stale', () => {
      expect(
        isProposalLive({
          status: PROPOSAL_STATUS.PENDING,
          expiresAt: new Date(Date.now() - 1),
        }),
      ).toBe(false);
    });

    it('is not live once answered', () => {
      expect(isProposalLive({ status: PROPOSAL_STATUS.APPROVED })).toBe(false);
      expect(isProposalLive({ status: PROPOSAL_STATUS.DENIED })).toBe(false);
    });
  });

  describe('reading a wait off a refusal', () => {
    it('reads the fields a client shows a person', () => {
      expect(
        readProposalRefusal({
          code: ACTION_PROPOSAL_CODE,
          proposalId: 'p-1',
          action: 'POST /applications/:id/deploy',
          sentence: 'deploy application a-1',
          offersAlways: true,
          decideUrl: 'https://example.test/settings/agents/requests/p-1',
        }),
      ).toEqual({
        proposalId: 'p-1',
        action: 'POST /applications/:id/deploy',
        sentence: 'deploy application a-1',
        offersAlways: true,
        decideUrl: 'https://example.test/settings/agents/requests/p-1',
        expiresAt: undefined,
        estimateWithheld: false,
      });
    });

    /**
     * The price reaches the person and not the agent, and the fix is not to
     * widen the reader by one more field: `estimateRef` is an API path, and a
     * path handed to a model is an invitation to a call no tool publishes. What
     * crosses is the bit — there is a price here, you are not seeing it — and
     * the route stays behind the guard, which is what the narrow reader is for.
     */
    it('carries that a price exists, and never the route that serves it', () => {
      const read = readProposalRefusal({
        code: ACTION_PROPOSAL_CODE,
        proposalId: 'p-1',
        action: 'POST /infrastructure/clusters/:id/workers',
        sentence: 'add a worker node to cluster c-1',
        offersAlways: true,
        estimateRef: '/infrastructure/clusters/c-1/capacity-plan',
      });
      expect(read?.estimateWithheld).toBe(true);
      expect(JSON.stringify(read)).not.toContain('capacity-plan');
    });

    it('says nothing is withheld when nothing prices the action', () => {
      const read = readProposalRefusal({
        code: ACTION_PROPOSAL_CODE,
        proposalId: 'p-2',
        sentence: 'enable the firewall on cluster c-1',
        estimateRef: '',
      });
      expect(read?.estimateWithheld).toBe(false);
    });

    it('reads nothing off any other refusal', () => {
      expect(
        readProposalRefusal({ code: 'SANDBOX_ROUTE_FORBIDDEN' }),
      ).toBeUndefined();
      expect(
        readProposalRefusal({ code: ACTION_PROPOSAL_CODE, proposalId: 'p-1' }),
      ).toBeUndefined();
      expect(readProposalRefusal('nope')).toBeUndefined();
      expect(readProposalRefusal(undefined)).toBeUndefined();
    });
  });
});
