import chalk from 'chalk';
import { MailIdentityStatus, mailIdentityLines } from './mail-identity';

export function printMailIdentity(
  log: (line: string) => void,
  status: MailIdentityStatus,
): void {
  const [headline, ...rest] = mailIdentityLines(status);
  const colour =
    status.state === 'active'
      ? chalk.green
      : status.state === 'error'
        ? chalk.red
        : chalk.yellow;
  log('');
  log(`  ${colour(headline)}`);
  for (const line of rest) log(`  ${chalk.dim(line)}`);
  log('');
}
