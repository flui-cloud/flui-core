import chalk from 'chalk';
import {
  IdentityConsoleStatus,
  identityConsoleLines,
} from './identity-console';

export function printIdentityConsole(
  log: (line: string) => void,
  status: IdentityConsoleStatus,
): void {
  const [headline, ...rest] = identityConsoleLines(status);
  let colour = status.state === 'open' ? chalk.yellow : chalk.green;
  if (!status.enforced) colour = chalk.red;
  log('');
  log(`  ${colour(headline)}`);
  for (const line of rest) log(`  ${chalk.dim(line)}`);
  log('');
}
