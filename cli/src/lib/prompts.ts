import chalk from 'chalk';
import * as readline from 'node:readline';
import { NodeSizeDto } from '../../../src/modules/providers/dto/node-size.dto';
import { ServerTypeValidatorService } from '../services/server-type-validator.service';
import { ConfigStorage } from './config-storage';
import { getCredentialSchema } from './provider-credential-schemas';
import { validateScalewayCredentials } from './scaleway-validator';

const validator = new ServerTypeValidatorService();

function makeStdinCleanup(onData: (data: Buffer) => void): () => void {
  return () => {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdin.removeListener('data', onData);
    // Resumed stdin is a referenced handle: without this the event loop stays
    // alive and the command never exits after its last line of output.
    process.stdin.pause();
  };
}

interface ProviderOption {
  id: 'hetzner' | 'scaleway';
  label: string;
  available: boolean;
  unavailableReason?: string;
}

const SUPPORTED_PROVIDERS: ProviderOption[] = [
  { id: 'hetzner', label: 'Hetzner Cloud', available: true },
  { id: 'scaleway', label: 'Scaleway', available: true },
];

interface ArrowSelectItem {
  label: string;
  disabled?: boolean;
  disabledReason?: string;
}

/**
 * Generic arrow-key interactive selector.
 * Returns the selected index, or -1 if cancelled (Ctrl+C / ESC).
 */
export async function selectWithArrows(
  title: string,
  items: ArrowSelectItem[],
): Promise<number> {
  return new Promise((resolve) => {
    let cursor = items.findIndex((i) => !i.disabled);
    if (cursor === -1) cursor = 0;

    const ARROW_UP = '\u001B\u005B\u0041';
    const ARROW_DOWN = '\u001B\u005B\u0042';
    const ENTER = '\r';
    const CTRL_C = '\u0003';
    const ESC = '\u001B';

    const renderLine = (item: ArrowSelectItem, selected: boolean): string => {
      const pointer = selected ? chalk.cyan('❯') : ' ';
      if (item.disabled) {
        const reason = item.disabledReason
          ? chalk.dim(` (${item.disabledReason})`)
          : '';
        return `  ${pointer} ${chalk.dim(item.label)}${reason}`;
      }
      return selected
        ? `  ${pointer} ${chalk.cyan(item.label)}`
        : `  ${pointer} ${chalk.white(item.label)}`;
    };

    const render = (firstRender = false) => {
      if (!firstRender) {
        // Move cursor up to overwrite previous render
        process.stdout.write(`\u001B[${items.length}A`);
      }
      items.forEach((item, i) => {
        process.stdout.write(`\u001B[2K${renderLine(item, i === cursor)}\n`);
      });
    };

    const titleLine = chalk.bold(`   ${title}`);
    const hintLine = chalk.dim(
      'Use ↑ ↓ arrows, Enter to confirm, ESC to cancel',
    );
    process.stdout.write(`\n${titleLine}\n   ${hintLine}\n\n`);
    render(true);

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();

    const onData = (data: Buffer) => {
      const key = data.toString();

      if (key === CTRL_C || key === ESC) {
        cleanup();
        resolve(-1);
        return;
      }

      if (key === ENTER) {
        if (!items[cursor]?.disabled) {
          cleanup();
          resolve(cursor);
        }
        return;
      }

      if (key === ARROW_UP || key === ARROW_DOWN) {
        const direction = key === ARROW_UP ? -1 : 1;
        let next = cursor;
        let attempts = items.length;
        do {
          next = (next + direction + items.length) % items.length;
          attempts--;
        } while (items[next]?.disabled && attempts > 0);

        if (!items[next]?.disabled) {
          cursor = next;
          render();
        }
      }
    };

    const cleanup = makeStdinCleanup(onData);

    process.stdin.on('data', onData);
  });
}

/**
 * Prompt for masked/hidden input (for API tokens).
 * Shows a blinking cursor while empty, asterisks once input arrives.
 * Supports both typing and paste (Cmd+V), including bracketed paste mode.
 */
export async function promptMaskedInput(message: string): Promise<string> {
  return new Promise((resolve) => {
    let token = '';
    let hasInput = false;
    let cursorOn = true;

    process.stdout.write(`${message}: `);
    process.stdout.write(chalk.dim('│'));
    process.stdout.write('\u001B[1D');

    const blink = setInterval(() => {
      if (!hasInput) {
        cursorOn = !cursorOn;
        process.stdout.write(cursorOn ? chalk.dim('│') : ' ');
        process.stdout.write('\u001B[1D');
      }
    }, 530);

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();

    const onData = (chunk: Buffer) => {
      // Strip bracketed paste wrappers (macOS terminal paste mode)
      let str = chunk
        .toString()
        .replaceAll('\x1b[200~', '')
        .replaceAll('\x1b[201~', '');

      let i = 0;
      while (i < str.length) {
        const c = str[i];

        // Skip ANSI escape sequences (e.g. arrow keys, function keys)
        if (c === '\x1b') {
          i++;
          if (str[i] === '[') {
            i++;
            while (i < str.length && !/[A-Za-z~]/.test(str[i])) i++;
          }
          i++;
          continue;
        }

        if (c === '\r' || c === '\n') {
          clearInterval(blink);
          cleanup();
          process.stdout.write('\n');
          resolve(token);
          return;
        }

        if (c === '\u0003') {
          clearInterval(blink);
          cleanup();
          process.stdout.write('\n');
          resolve('');
          return;
        }

        if (c === '\u007F' || c === '\b') {
          if (token.length > 0) {
            token = token.slice(0, -1);
            process.stdout.write('\b \b');
          }
          i++;
          continue;
        }

        // Printable character
        if (!hasInput) {
          hasInput = true;
          clearInterval(blink);
          process.stdout.write(' \u001B[1D');
        }
        token += c;
        process.stdout.write('*');
        i++;
      }
    };

    const cleanup = makeStdinCleanup(onData);

    process.stdin.on('data', onData);
  });
}

/** Pick among already-configured providers (no token prompt). Returns the chosen id, or null if cancelled. */
export async function selectConfiguredProvider(
  configuredIds: string[],
): Promise<string | null> {
  const options = SUPPORTED_PROVIDERS.filter((p) =>
    configuredIds.includes(p.id),
  );
  if (options.length === 0) return null;
  if (options.length === 1) return options[0].id;

  console.log(chalk.cyan('\nℹ  Multiple cloud providers are configured.'));
  const index = await selectWithArrows(
    'Select the provider to use:',
    options.map((p) => ({ label: p.label })),
  );
  if (index === -1) {
    console.log(chalk.dim('\n   Cancelled.\n'));
    return null;
  }
  return options[index].id;
}

async function pickProviderToConfigure(
  preselectedProviderId?: string,
): Promise<ProviderOption | null> {
  // When the target provider is already known (explicit --provider, or a
  // single-provider profile with missing creds), configure it directly.
  const preselected = preselectedProviderId
    ? SUPPORTED_PROVIDERS.find(
        (p) => p.id === preselectedProviderId && p.available,
      )
    : undefined;
  if (preselected) {
    console.log(
      chalk.yellow(`\n⚠  No ${preselected.label} API token configured.`),
    );
    return preselected;
  }

  console.log(chalk.yellow('\n⚠  No cloud provider API token configured.'));
  const items: ArrowSelectItem[] = SUPPORTED_PROVIDERS.map((p) => ({
    label: p.label,
    disabled: !p.available,
    disabledReason: p.unavailableReason,
  }));
  const index = await selectWithArrows(
    'Select a provider to configure:',
    items,
  );
  if (index === -1) {
    console.log(
      chalk.dim('\n   Cancelled. Run: flui config set hetzner YOUR_TOKEN\n'),
    );
    return null;
  }
  return SUPPORTED_PROVIDERS[index];
}

async function collectProviderCredentials(
  schema: NonNullable<ReturnType<typeof getCredentialSchema>>,
): Promise<Record<string, string> | null> {
  const collected: Record<string, string> = {};
  for (const field of schema.fields) {
    const label = `   ${field.label}`;
    const value = field.secret
      ? await promptMaskedInput(label)
      : (
          await promptInput({
            message:
              field.label + (field.hint ? chalk.dim(` (${field.hint})`) : ''),
          })
        ).trim();
    if (!value.trim()) {
      console.log(
        chalk.red(`\n   ${field.label} is required. Setup cancelled.\n`),
      );
      return null;
    }
    collected[field.key] = value.trim();
  }
  return collected;
}

export async function runProviderSetupWizard(
  preselectedProviderId?: string,
): Promise<string | null> {
  const selectedProvider = await pickProviderToConfigure(preselectedProviderId);
  if (!selectedProvider) return null;

  const schema = getCredentialSchema(selectedProvider.id);
  if (!schema) {
    console.log(
      chalk.red(
        `\n   Missing credential schema for ${selectedProvider.label}\n`,
      ),
    );
    return null;
  }

  console.log(
    chalk.dim(
      `\n   Enter your ${selectedProvider.label} credentials below.\n   They will be stored encrypted on disk.\n`,
    ),
  );

  const collected = await collectProviderCredentials(schema);
  if (!collected) return null;

  if (selectedProvider.id === 'scaleway') {
    process.stdout.write(
      chalk.dim('\n   Validating credentials with Scaleway IAM...'),
    );
    const result = await validateScalewayCredentials(
      collected.accessKey,
      collected.secretKey,
    );
    process.stdout.write('\r\u001B[2K');
    if (!result.success) {
      console.log(chalk.red(`   ✖ ${result.message}\n`));
      return null;
    }
    console.log(chalk.green(`   ✔ ${result.message}`));
  }

  try {
    const storage = new ConfigStorage();
    if (schema.type === 'access_key_secret') {
      storage.saveCredentials(selectedProvider.id, collected);
    } else {
      storage.saveToken(selectedProvider.id, collected[schema.fields[0].key]);
    }
    console.log(
      chalk.green(
        `\n   ✔ ${selectedProvider.label} credentials saved (AES-256-GCM encrypted)\n`,
      ),
    );
    return selectedProvider.id;
  } catch (err) {
    console.log(
      chalk.red(
        `\n   Failed to save credentials: ${err instanceof Error ? err.message : String(err)}\n`,
      ),
    );
    return null;
  }
}

/**
 * Prompt user for yes/no confirmation
 */
export async function confirmPrompt(
  message: string,
  defaultValue = true,
): Promise<boolean> {
  if (!process.stdin.isTTY) {
    throw new Error(
      `Refusing to prompt for "${message}" in non-TTY mode. Pass --yes to confirm non-interactively.`,
    );
  }
  return new Promise((resolve) => {
    process.stdout.write(`${message} (${defaultValue ? 'Y/n' : 'y/N'}): `);

    let answer = '';

    process.stdin.setRawMode(true);
    process.stdin.resume();

    const onData = (char: Buffer) => {
      const c = char.toString();

      if (c === '\r' || c === '\n') {
        cleanup();
        process.stdout.write('\n');
        const normalized = answer.trim().toLowerCase();
        resolve(
          normalized === ''
            ? defaultValue
            : normalized === 'y' || normalized === 'yes',
        );
      } else if (c === '\u0003') {
        cleanup();
        process.stdout.write('\n');
        resolve(false);
      } else if (c === '\u007F' || c === '\b') {
        if (answer.length > 0) {
          answer = answer.slice(0, -1);
          process.stdout.write('\b \b');
        }
      } else {
        answer += c;
        process.stdout.write(c);
      }
    };

    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.removeListener('data', onData);
      process.stdin.pause();
    };

    process.stdin.on('data', onData);
  });
}

export interface PromptInputOptions {
  message: string;
  default?: string;
  /** Returns an error message string when invalid, or null when valid. */
  validate?: (value: string) => string | null;
  /**
   * Accept an empty answer and hand back `''`.
   *
   * For a question that is genuinely optional — a probe parameter the catalogue
   * published as not required, say. Without it the loop insists, which turns
   * "you may leave this out" into a prompt with no way forward.
   */
  allowEmpty?: boolean;
}

/**
 * Free-text prompt with optional default and per-character validation loop.
 *
 * Use this whenever a required value must come from the user — e.g. the
 * preferences resolver falls through here when nothing is set at any layer.
 *
 * Fails loudly in non-TTY contexts (CI, piped stdin) so commands break instead
 * of hanging on input that never arrives. For yes/no use `confirmPrompt`,
 * for destructive type-the-name use `confirmByTypingPrompt`, for masked
 * tokens use `promptMaskedInput`.
 */
export async function promptInput(opts: PromptInputOptions): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error(
      `Missing required value for "${opts.message}". Set it via flag, env var, or \`flui config set\` — interactive prompts are disabled in non-TTY mode.`,
    );
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const suffix = opts.default ? chalk.dim(` [${opts.default}]`) : '';
  const prefix = chalk.cyan('?') + ' ';

  const ask = (): Promise<string> =>
    new Promise((resolve) => {
      rl.question(`${prefix}${opts.message}${suffix}: `, (answer) => {
        resolve(answer.trim());
      });
    });

  try {
    while (true) {
      const raw = await ask();
      const value =
        raw === '' && opts.default !== undefined ? opts.default : raw;

      if (value === '') {
        if (opts.allowEmpty) return '';
        console.log(chalk.red('  A value is required.'));
        continue;
      }

      if (opts.validate) {
        const err = opts.validate(value);
        if (err) {
          console.log(chalk.red(`  ${err}`));
          continue;
        }
      }

      return value;
    }
  } finally {
    rl.close();
  }
}

/**
 * Prompt the user to type an exact string to confirm a destructive action.
 * Returns true only when the input matches `expected` verbatim.
 */
export async function confirmByTypingPrompt(
  message: string,
  expected: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    process.stdout.write(`${message}: `);

    let answer = '';

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();

    const onData = (char: Buffer) => {
      const c = char.toString();

      if (c === '\r' || c === '\n') {
        cleanup();
        process.stdout.write('\n');
        resolve(answer.trim() === expected);
      } else if (c === '\u0003' || c === '\u001B') {
        cleanup();
        process.stdout.write('\n');
        resolve(false);
      } else if (c === '\u007F' || c === '\b') {
        if (answer.length > 0) {
          answer = answer.slice(0, -1);
          process.stdout.write('\b \b');
        }
      } else {
        answer += c;
        process.stdout.write(c);
      }
    };

    const cleanup = makeStdinCleanup(onData);

    process.stdin.on('data', onData);
  });
}

/**
 * Prompt user to select from a list of server types using arrow keys
 */
export async function selectServerTypePrompt(
  serverTypes: NodeSizeDto[],
  message = 'Select a server type:',
): Promise<NodeSizeDto | null> {
  const items: ArrowSelectItem[] = serverTypes.map((type) => {
    const price = validator.getFormattedPrice(type);
    let priceStr = '';
    if (price.monthly) priceStr = `€${price.monthly}/mo`;
    else if (price.hourly) priceStr = `€${price.hourly}/hr`;
    return {
      label: `${type.name.padEnd(10)} — ${type.cores} vCPU, ${type.memory}GB RAM, ${type.disk}GB ${type.storageType.padEnd(7)} ${priceStr}`,
    };
  });

  const index = await selectWithArrows(message, items);

  if (index === -1) return null;
  return serverTypes[index];
}

/**
 * Display a warning message about deprecated server type
 */
export function displayDeprecationWarning(
  deprecatedType: string,
  suggestedType: NodeSizeDto,
  originalPrice?: string,
): void {
  console.log(`\n⚠️  Server type '${deprecatedType}' is no longer available\n`);
  console.log(
    `   Recommended alternative: ${suggestedType.name} (${suggestedType.cores} vCPU, ${suggestedType.memory}GB RAM)`,
  );

  const price = validator.getFormattedPrice(suggestedType);
  if (price.monthly) {
    const priceInfo = originalPrice
      ? `€${price.monthly}/mo (was €${originalPrice}/mo)`
      : `€${price.monthly}/mo`;
    console.log(`   • Monthly cost: ${priceInfo}`);
  }
  if (price.hourly) {
    console.log(`   • Hourly cost: €${price.hourly}`);
  }

  const regions = validator.getAvailableRegions(suggestedType);
  if (regions.length > 0) {
    console.log(`   • Available in: ${regions.join(', ')}`);
  }

  console.log('');
}

/**
 * Display server type not found error
 */
export function displayServerTypeNotFoundError(
  requestedType: string,
  provider: string,
): void {
  console.log(
    `\n❌ Server type '${requestedType}' not found for provider '${provider}'\n`,
  );
  console.log(`   Run: flui server-types list --provider=${provider}\n`);
}

/**
 * Prompt user to confirm alternative server type
 */
export async function confirmAlternativeServerType(
  deprecatedType: string,
  suggestedType: NodeSizeDto,
  originalPrice?: string,
): Promise<boolean> {
  displayDeprecationWarning(deprecatedType, suggestedType, originalPrice);
  return confirmPrompt(`Proceed with ${suggestedType.name}?`, true);
}
