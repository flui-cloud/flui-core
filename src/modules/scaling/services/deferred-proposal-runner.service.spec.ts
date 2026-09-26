jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jose', () => ({}));

import { DeferredProposalRunnerService } from './deferred-proposal-runner.service';

const row = {
  id: 'd1',
  kind: 'apply-resource-proposal',
  applicationId: 'a1',
  requestedBy: 'ana@example.test',
};

function build(proposal: unknown) {
  const maintenance = {
    due: jest.fn().mockResolvedValue([row]),
    settle: jest.fn().mockResolvedValue({}),
  };
  const proposals = {
    proposalOf: jest.fn().mockResolvedValue({ proposal }),
    apply: jest.fn().mockResolvedValue({}),
  };
  return {
    service: new DeferredProposalRunnerService(
      maintenance as never,
      proposals as never,
    ),
    maintenance,
    proposals,
  };
}

const withPlacement = (verdict: string) => ({
  consequence: {
    problem: null,
    placement: {
      verdict,
      sentence: 'The group would name a cx33 and buy nothing.',
    },
  },
});

describe('DeferredProposalRunnerService', () => {
  it('applies a change that still has room, and says who asked', async () => {
    const t = build(withPlacement('fits'));
    await t.service.runDue();
    expect(t.proposals.apply).toHaveBeenCalledWith('a1', {
      name: 'ana@example.test (held for the maintenance window)',
    });
    expect(t.maintenance.settle).toHaveBeenCalledWith(
      row,
      'applied',
      expect.stringContaining('ana@example.test'),
    );
  });

  it('drops a change nothing asks for any more', async () => {
    const t = build(null);
    await t.service.runDue();
    expect(t.proposals.apply).not.toHaveBeenCalled();
    expect(t.maintenance.settle).toHaveBeenCalledWith(
      row,
      'discarded',
      expect.any(String),
    );
  });

  it('raises instead of applying when the app would have nowhere to run', async () => {
    const t = build(withPlacement('proposes'));
    await t.service.runDue();
    expect(t.proposals.apply).not.toHaveBeenCalled();
    expect(t.maintenance.settle).toHaveBeenCalledWith(
      row,
      'alerted',
      expect.stringContaining('nowhere to run'),
    );
  });

  it('records a failure instead of throwing', async () => {
    const t = build(withPlacement('fits'));
    t.proposals.apply.mockRejectedValue(new Error('cluster unreachable'));
    await t.service.runDue();
    expect(t.maintenance.settle).toHaveBeenLastCalledWith(
      row,
      'failed',
      'Not applied: cluster unreachable',
    );
  });
});
