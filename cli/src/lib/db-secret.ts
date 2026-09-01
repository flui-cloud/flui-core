/** Whatever can run a command on the master. Structural so a spec can stand in for it. */
export interface SecretReader {
  sshExec(
    host: string,
    command: string,
    username?: string,
    port?: number,
  ): Promise<string>;
}

/** Where to run it. `user`/`port` matter on BYOS, where the endpoint is not root@22. */
export interface SecretHost {
  host: string;
  user?: string;
  port?: number;
}

/**
 * Read one key out of an in-cluster Secret, over SSH to the master (kubectl).
 * The value deliberately never travels through the HTTP API — only the CLI,
 * which already has cluster SSH access, can extract it. That holds for the
 * platform's own foundations too: the API names the database and the role, and
 * never the Secret the password lives in.
 */
export async function readSecretKey(
  ssh: SecretReader,
  target: SecretHost,
  namespace: string,
  secretName: string,
  secretKeys: string[],
): Promise<string> {
  for (const secretKey of secretKeys) {
    const cmd = `kubectl -n ${namespace} get secret ${secretName} -o jsonpath='{.data.${secretKey}}'`;
    const b64 = (
      await ssh.sshExec(target.host, cmd, target.user, target.port)
    ).trim();
    if (b64) return Buffer.from(b64, 'base64').toString('utf8');
  }
  throw new Error(
    `none of [${secretKeys.join(', ')}] found in secret ${secretName} (namespace ${namespace})`,
  );
}

/**
 * A building block's owner password, whose Secret is named after the block's
 * slug. The foundations are not named that way — theirs are `flui-secrets` and
 * `zitadel-secrets` — which is why the name is a parameter one level down.
 */
export async function readDbPassword(
  ssh: SecretReader,
  masterIp: string,
  namespace: string,
  slug: string,
  secretKeys: string[],
): Promise<string> {
  return readSecretKey(
    ssh,
    { host: masterIp },
    namespace,
    `${slug}-secret`,
    secretKeys,
  );
}
