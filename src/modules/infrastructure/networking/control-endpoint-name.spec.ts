import { endpointNameProblem } from './control-endpoint-name';
import { controlEndpoint } from './services/wireguard-peer-render';

const env = { FLUI_WG_ENDPOINT_NAME: 'wg.example.org' };
const dns =
  (table: Record<string, string[]>) =>
  async (name: string): Promise<string[]> => {
    if (!table[name]) throw new Error('ENOTFOUND');
    return table[name];
  };

describe('the name members dial the control master by', () => {
  it('says nothing when no name is declared', async () => {
    const resolve = jest.fn();
    expect(await endpointNameProblem('1.1.1.1', {}, resolve)).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });

  it('is fine when it leads to the master alone', async () => {
    expect(
      await endpointNameProblem(
        '1.1.1.1',
        env,
        dns({ 'wg.example.org': ['1.1.1.1'] }),
      ),
    ).toBeNull();
  });

  it('compares with what a master declared by name resolves to', async () => {
    expect(
      await endpointNameProblem(
        'master.example.org',
        env,
        dns({
          'wg.example.org': ['1.1.1.1'],
          'master.example.org': ['1.1.1.1'],
        }),
      ),
    ).toBeNull();
  });

  it('warns when it also leads to another control node', async () => {
    const problem = await endpointNameProblem(
      '1.1.1.1',
      env,
      dns({ 'wg.example.org': ['1.1.1.1', '2.2.2.2'] }),
    );
    expect(problem).toContain('wg.example.org resolves to 1.1.1.1, 2.2.2.2');
    expect(problem).toContain('control master (1.1.1.1)');
  });

  it('warns when it leads somewhere else entirely', async () => {
    expect(
      await endpointNameProblem(
        '1.1.1.1',
        env,
        dns({ 'wg.example.org': ['2.2.2.2'] }),
      ),
    ).toContain('resolves to 2.2.2.2');
  });

  it('warns when it does not resolve', async () => {
    expect(await endpointNameProblem('1.1.1.1', env, dns({}))).toContain(
      'does not resolve (ENOTFOUND)',
    );
  });
});

describe('which control row members dial by the declared name', () => {
  it('is only the row flagged primary, or the one with no node', () => {
    const at = (row: object) => controlEndpoint(row, env);
    expect(at({ endpointHost: '1.1.1.1', isPrimary: true, nodeId: 'm' })).toBe(
      'wg.example.org:51821',
    );
    expect(at({ endpointHost: '1.1.1.1', nodeId: null })).toBe(
      'wg.example.org:51821',
    );
    expect(at({ endpointHost: '2.2.2.2', isPrimary: false, nodeId: 'w' })).toBe(
      '2.2.2.2:51821',
    );
    expect(at({ endpointHost: '2.2.2.2', nodeId: 'w' })).toBe('2.2.2.2:51821');
  });
});
