import { readDbPassword, readSecretKey, SecretReader } from './db-secret';

const b64 = (value: string): string => Buffer.from(value).toString('base64');

function reader(values: Record<string, string>): SecretReader & {
  calls: Array<{ host: string; command: string; user?: string; port?: number }>;
} {
  const calls: Array<{
    host: string;
    command: string;
    user?: string;
    port?: number;
  }> = [];
  return {
    calls,
    sshExec: async (host, command, user, port) => {
      calls.push({ host, command, user, port });
      const key = /jsonpath='\{\.data\.([^}]+)\}'/.exec(command)?.[1] ?? '';
      const secret = /get secret (\S+)/.exec(command)?.[1] ?? '';
      return values[`${secret}/${key}`] ?? '';
    },
  };
}

/**
 * The whole point of this file is that the password is read from the cluster
 * and never from the API, so what the specs pin is the command it runs and the
 * host it runs it on — the two things a mistake here would get wrong silently.
 */
describe('reading a key out of an in-cluster Secret', () => {
  it('decodes the value the cluster hands back', async () => {
    const ssh = reader({ 'flui-secrets/DB_PASSWORD': b64('s3cr3t') });
    await expect(
      readSecretKey(ssh, { host: '10.0.0.1' }, 'flui-system', 'flui-secrets', [
        'DB_PASSWORD',
      ]),
    ).resolves.toBe('s3cr3t');
    expect(ssh.calls[0].command).toBe(
      "kubectl -n flui-system get secret flui-secrets -o jsonpath='{.data.DB_PASSWORD}'",
    );
  });

  it('takes the first key that is actually present', async () => {
    const ssh = reader({ 'zitadel-secrets/db-user-password': b64('zpw') });
    await expect(
      readSecretKey(
        ssh,
        { host: '10.0.0.1' },
        'flui-system',
        'zitadel-secrets',
        ['db-admin-password', 'db-user-password'],
      ),
    ).resolves.toBe('zpw');
    expect(ssh.calls).toHaveLength(2);
  });

  /**
   * A BYOS master is not root@22, and a tunnel that silently tries to be would
   * fail at the SSH layer with nothing pointing at the reason.
   */
  it('honours a host that is not root on 22', async () => {
    const ssh = reader({ 'flui-secrets/DB_PASSWORD': b64('x') });
    await readSecretKey(
      ssh,
      { host: 'box.example', user: 'flui', port: 2222 },
      'flui-system',
      'flui-secrets',
      ['DB_PASSWORD'],
    );
    expect(ssh.calls[0]).toMatchObject({
      host: 'box.example',
      user: 'flui',
      port: 2222,
    });
  });

  it('names the Secret it could not find a key in, rather than answering empty', async () => {
    const ssh = reader({});
    await expect(
      readSecretKey(ssh, { host: '10.0.0.1' }, 'flui-system', 'flui-secrets', [
        'DB_PASSWORD',
      ]),
    ).rejects.toThrow('found in secret flui-secrets (namespace flui-system)');
  });
});

/**
 * The building-block form is now one line on top of the general one, and the
 * `<slug>-secret` convention it encodes is exactly what the foundations do not
 * follow — theirs are `flui-secrets` and `zitadel-secrets`.
 */
describe('a building block owner password', () => {
  it('still looks in the Secret named after the slug', async () => {
    const ssh = reader({
      'postgres-815796-secret/POSTGRES_PASSWORD': b64('p'),
    });
    await expect(
      readDbPassword(ssh, '10.0.0.1', 'user-dawit', 'postgres-815796', [
        'POSTGRES_PASSWORD',
      ]),
    ).resolves.toBe('p');
    expect(ssh.calls[0].command).toContain('get secret postgres-815796-secret');
  });
});
