/**
 * Read a building-block database's owner password straight from its in-cluster Secret,
 * over SSH to the master (kubectl). The password deliberately never travels through the
 * HTTP API — only the CLI, which already has cluster SSH access, can extract it.
 */
export async function readDbPassword(
  ssh: { sshExec(host: string, command: string): Promise<string> },
  masterIp: string,
  namespace: string,
  slug: string,
  secretKeys: string[],
): Promise<string> {
  for (const secretKey of secretKeys) {
    const cmd = `kubectl -n ${namespace} get secret ${slug}-secret -o jsonpath='{.data.${secretKey}}'`;
    const b64 = (await ssh.sshExec(masterIp, cmd)).trim();
    if (b64) return Buffer.from(b64, 'base64').toString('utf8');
  }
  throw new Error(
    `none of [${secretKeys.join(', ')}] found in secret ${slug}-secret (namespace ${namespace})`,
  );
}
