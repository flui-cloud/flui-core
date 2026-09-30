import {
  otherFluiProcesses,
  parsePsOutput,
  redactCommand,
} from './flui-processes';

const PS = [
  '    1 /sbin/launchd',
  '  100 /usr/local/bin/flui dev tunnel --retry',
  '  101 node /Users/me/Project/flui/flui-core/cli/bin/run env status',
  '  102 /opt/homebrew/bin/node /Users/me/.flui/cli/bin/run vault agent --stdin',
  '  103 node /Users/me/flui-core/cli/lib/cli/src/background/cluster-worker.js create-cluster {}',
  '  104 /bin/sh /usr/local/bin/flui vault unlock',
  '  105 node /usr/local/bin/flui vault unlock',
  '  106 vim /Users/me/Project/flui/flui.yaml',
  '  107 tail -f /Users/me/.flui/logs/op.log',
  '  108 node ./cli/bin/run app list',
  '  109 /Users/me/.nvm/versions/node/v22.13.0/bin/node /Users/me/Project/flui/vops/bin/run ui --no-open',
  '  110 node /Users/me/Library/pnpm/../../Project/flui/vops/bin/run mcp serve --transport stdio',
  '  111 node /Users/me/Library/pnpm/../../Project/flui/flui-core/cli/bin/run dev tunnel --retry',
  '  112 node /usr/local/lib/node_modules/@flui-cloud/cli/bin/run app list',
].join('\n');

describe('otherFluiProcesses', () => {
  it('lists flui commands and workers, not the agent, this process or its launcher', () => {
    const found = otherFluiProcesses({ ps: () => PS, exclude: [104, 105] });

    expect(found.map((p) => p.pid)).toEqual([100, 101, 103, 108, 111, 112]);
  });

  it('leaves out other tools kept in a folder called flui', () => {
    const found = otherFluiProcesses({ ps: () => PS, exclude: [104, 105] });

    expect(found.map((p) => p.pid)).not.toContain(109);
    expect(found.map((p) => p.pid)).not.toContain(110);
  });

  it('lists nothing when ps is unavailable', () => {
    expect(
      otherFluiProcesses({
        ps: () => {
          throw new Error('ps: not found');
        },
      }),
    ).toEqual([]);
  });
});

describe('redactCommand', () => {
  it('does not echo credential-looking flag values', () => {
    expect(
      redactCommand(
        'flui config set hetzner --token abc123 --api-key=xyz --region fsn1',
      ),
    ).toBe('flui config set hetzner --token *** --api-key=*** --region fsn1');
  });
});

describe('redactCommand edge cases', () => {
  it.each([
    ['flui x --token=', 'flui x --token='],
    ['flui x --token= abc', 'flui x --token= abc'],
    ['flui x --token', 'flui x --token'],
    ['flui --foo --token=abc', 'flui --foo --token=***'],
    ['flui --token --secret x', 'flui --token *** x'],
    ['flui --API-KEY=Abc', 'flui --API-KEY=***'],
    ['flui abc-def--token v', 'flui abc-def--token ***'],
    ['flui tokenx-a=1', 'flui tokenx-a=1'],
    ['flui --monkey=banana', 'flui --monkey=***'],
    ['flui --key\tval rest', 'flui --key\t*** rest'],
    ['flui "--password=p w"', 'flui "--password=*** w"'],
    ['flui key=abc', 'flui key=abc'],
  ])('%j becomes %j', (command, expected) => {
    expect(redactCommand(command)).toBe(expected);
  });

  it('truncates long commands after redacting', () => {
    expect(
      redactCommand(`--token=${'a'.repeat(20)} ${'b'.repeat(20)}`, 12),
    ).toBe('--token=***…');
  });
});

describe('parsePsOutput', () => {
  it('reads the pid and the trimmed command of each line', () => {
    expect(parsePsOutput('  12   node run  \n7 x\n')).toEqual([
      { pid: 12, command: 'node run' },
      { pid: 7, command: 'x' },
    ]);
  });

  it.each([['12'], ['12 '], ['12x run'], ['  run 12'], [''], ['12 run\r']])(
    'ignores %j',
    (line) => {
      expect(parsePsOutput(line)).toEqual([]);
    },
  );

  it('keeps a line whose separator holds a carriage return', () => {
    expect(parsePsOutput('12 \r run')).toEqual([{ pid: 12, command: 'run' }]);
  });

  it('keeps a pid followed only by blanks as an empty command', () => {
    expect(parsePsOutput('12   ')).toEqual([{ pid: 12, command: '' }]);
  });
});
