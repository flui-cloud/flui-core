import { describeRunFailure } from './run-failure.util';

const failedJob = {
  status: {
    conditions: [
      { type: 'Failed', status: 'True', reason: 'BackoffLimitExceeded' },
    ],
  },
};

describe('describeRunFailure', () => {
  it('says the image has no shell when /bin/sh cannot start', () => {
    const pod = {
      status: {
        containerStatuses: [
          {
            state: {
              terminated: {
                reason: 'StartError',
                exitCode: 128,
                message:
                  'failed to create containerd task: exec: "/bin/sh": stat /bin/sh: no such file or directory',
              },
            },
          },
        ],
      },
    };
    expect(describeRunFailure(failedJob, [pod])).toMatch(/no shell/);
  });

  it('names the exit code, memory and image problems', () => {
    const term = (t: any) => [
      { status: { containerStatuses: [{ state: { terminated: t } }] } },
    ];
    expect(describeRunFailure(failedJob, term({ exitCode: 3 }))).toBe(
      'The command exited with code 3.',
    );
    expect(
      describeRunFailure(
        failedJob,
        term({ reason: 'OOMKilled', exitCode: 137 }),
      ),
    ).toMatch(/memory/);
    expect(
      describeRunFailure(failedJob, [
        {
          status: {
            containerStatuses: [
              { state: { waiting: { reason: 'ImagePullBackOff' } } },
            ],
          },
        },
      ]),
    ).toMatch(/image could not be downloaded/);
  });

  it('says so when the run left nothing behind', () => {
    expect(describeRunFailure(failedJob, [])).toMatch(
      /no longer on the cluster/,
    );
  });
});
