jest.mock('@kubernetes/client-node', () => ({}));

import { PlatformUpdateProcessor } from './platform-update.processor';

const run = async (waitsForNewerApi: boolean) => {
  const execute = jest.fn();
  const add = jest.fn();
  const processor = new PlatformUpdateProcessor(
    {} as never,
    {} as never,
    {} as never,
    { waitsForNewerApi: async () => waitsForNewerApi, execute } as never,
  );
  await processor.runUpgrade({
    data: { operationId: 'op-1' },
    queue: { add },
  } as never);
  return { execute, add };
};

describe('continuing a platform update during the rollout', () => {
  it('hands the continuation on when this copy still runs the old version', async () => {
    const { execute, add } = await run(true);
    expect(execute).not.toHaveBeenCalled();
    expect(add).toHaveBeenCalledWith(
      expect.any(String),
      { operationId: 'op-1' },
      expect.objectContaining({
        delay: 15_000,
        jobId: expect.stringMatching(/^platform-upgrade:op-1:handover:/),
      }),
    );
  });

  it('runs it on a copy of the new version', async () => {
    const { execute, add } = await run(false);
    expect(execute).toHaveBeenCalledWith('op-1');
    expect(add).not.toHaveBeenCalled();
  });
});
