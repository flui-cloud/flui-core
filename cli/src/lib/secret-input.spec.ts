import { readSecret, readSecrets, SECRET_FLAG_NOTE } from './secret-input';

jest.mock('./stdin-value', () => ({
  stdinRequested: jest.fn(() => false),
  stdinValue: jest.fn(() => ''),
}));

import { stdinRequested, stdinValue } from './stdin-value';

const requested = stdinRequested as jest.MockedFunction<typeof stdinRequested>;
const piped = stdinValue as jest.MockedFunction<typeof stdinValue>;

function reader(answer: string) {
  return jest.fn(async () => answer);
}

describe('where a secret comes from', () => {
  beforeEach(() => {
    requested.mockReturnValue(false);
    piped.mockReturnValue('');
  });

  it('takes the flag when one was passed, without asking', async () => {
    const ask = reader('typed');
    await expect(
      readSecret({ label: 'Token', provided: 'from-flag' }, ask),
    ).resolves.toBe('from-flag');
    expect(ask).not.toHaveBeenCalled();
  });

  /**
   * A flag declared but left empty is the same as absent. oclif hands back `''`
   * for `--secret ""`, and treating that as a supplied credential would store
   * an empty string as somebody's API key.
   */
  it('treats an empty flag as no flag', async () => {
    await expect(
      readSecret({ label: 'Token', provided: '   ' }, reader('typed')),
    ).resolves.toBe('typed');
  });

  it('reads standard input when the command allows it and it was piped', async () => {
    requested.mockReturnValue(true);
    piped.mockReturnValue('  from-pipe  ');
    const ask = reader('typed');
    await expect(
      readSecret({ label: 'Token', fromStdin: true }, ask),
    ).resolves.toBe('from-pipe');
    expect(ask).not.toHaveBeenCalled();
  });

  /**
   * `--stdin` on a command that never declared this ask as its stdin consumer
   * must not silently feed it: the pipe belongs to some other field, or to
   * nothing.
   */
  it('ignores standard input for an ask that did not claim it', async () => {
    requested.mockReturnValue(true);
    piped.mockReturnValue('from-pipe');
    await expect(readSecret({ label: 'Token' }, reader('typed'))).resolves.toBe(
      'typed',
    );
  });

  it('asks the person when nothing else has it', async () => {
    const ask = reader('  typed  ');
    await expect(readSecret({ label: 'Token' }, ask)).resolves.toBe('typed');
    expect(ask).toHaveBeenCalledWith('Token');
  });
});

describe('several secrets in one command', () => {
  beforeEach(() => {
    requested.mockReturnValue(false);
    piped.mockReturnValue('');
  });

  it('asks for each in the order given', async () => {
    const answers = ['one', 'two'];
    const ask = jest.fn(async () => answers.shift() ?? '');
    await expect(
      readSecrets([{ label: 'Access key' }, { label: 'Secret key' }], ask),
    ).resolves.toEqual(['one', 'two']);
  });

  /**
   * The failure this refuses is silent and expensive: with two asks both
   * claiming the single stream, the second would receive the first one's value
   * and a secret key would be stored as an access key.
   */
  it('refuses two asks that both claim standard input', async () => {
    await expect(
      readSecrets(
        [
          { label: 'Access key', fromStdin: true },
          { label: 'Secret key', fromStdin: true },
        ],
        reader('x'),
      ),
    ).rejects.toThrow('single stream');
  });
});

describe('what the flag says in --help', () => {
  it('tells the reader why leaving it out is better', () => {
    expect(SECRET_FLAG_NOTE).toContain('shell history');
  });
});
