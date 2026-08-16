import { Command, Flags } from '@oclif/core';
import { VaultFile } from '../../lib/vault/vault-file';
import { VaultAgent } from '../../lib/vault/vault-agent';
import { resolveLimits } from '../../lib/vault/vault-session';
import { stdinValue } from '../../lib/stdin-value';

/**
 * The process that holds the unlocked key. Started by `flui vault unlock`, not
 * run by hand — it is listed as a command only because that is how the CLI
 * spawns a copy of itself.
 *
 * It reads the passphrase from standard input and never echoes, logs or stores
 * it. When the session closes, the key is overwritten and the process exits, so
 * there is nothing left to find.
 */
export default class VaultAgentCommand extends Command {
  static readonly hidden = true;
  static readonly description =
    'Internal: hold the unlocked vault key for this session. Started by "flui vault unlock".';

  static readonly flags = {
    stdin: Flags.boolean({ hidden: true, default: false }),
  };

  async run(): Promise<void> {
    await this.parse(VaultAgentCommand);

    // Captured at import time rather than read here. oclif attaches to standard
    // input while parsing, so by the time this line runs the descriptor is
    // drained and the passphrase is gone — which presents as an agent that
    // starts and immediately dies with no explanation.
    const passphrase = stdinValue();
    if (!passphrase) {
      this.error(
        'The vault agent expects a passphrase on standard input, with --stdin.',
        { exit: 1 },
      );
    }

    const master = new VaultFile().unlock(passphrase);
    const agent = new VaultAgent(undefined, resolveLimits(), () =>
      process.exit(0),
    );
    await agent.listen(master);

    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
      process.on(signal, () => agent.close(`received ${signal}`));
    }
  }
}
