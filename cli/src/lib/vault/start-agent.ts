import { spawn } from 'node:child_process';
import { askAgent } from './vault-agent';

/**
 * Starts the agent that holds the vault open for this session, and waits for
 * it to answer. The passphrase goes in on standard input: an argument or an
 * environment variable is readable by other processes on the machine.
 */
export async function startVaultAgent(passphrase: string): Promise<boolean> {
  const child = spawn(
    process.argv[0],
    [process.argv[1], 'vault', 'agent', '--stdin'],
    { detached: true, stdio: ['pipe', 'ignore', 'ignore'] },
  );
  child.stdin?.end(passphrase);
  child.unref();

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const status = await askAgent({ op: 'status' });
    if (status?.ok) return true;
  }
  return false;
}
