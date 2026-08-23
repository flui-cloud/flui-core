import chalk from 'chalk';

/** The shape `GET /iam/grants/:id/revocation-preview` and the grant routes return. */
export interface AccessDelta {
  principal: { type: string; ref: string };
  summary: string;
  losesNothing: boolean;
  losesEverything: boolean;
  principalIsPlatformAdmin: boolean;
  sectionsClosed: { key: string }[];
  sectionsDowngraded: { key: string }[];
  sectionsOpened: { key: string }[];
  coverage: 'exact' | 'snapshot' | 'unknown';
  applicationsLost: {
    id: string;
    name: string;
    slug: string;
    clusterName: string;
  }[];
  applicationsLostCount: number;
  applicationsGained: { slug: string; clusterName: string }[];
  applicationsGainedCount: number;
  permissionsLost: string[];
  permissionsGained: string[];
  note?: string;
}

/**
 * What an access change takes away, on a terminal.
 *
 * The arithmetic is the API's — the CLI only reads it out. That is the whole
 * point of computing it server-side: the same words appear here, on the access
 * screen and in an agent's answer, and none of the three can be wrong on its
 * own.
 *
 * The one rule that must not be softened: `coverage: 'unknown'` is printed as
 * a warning and never as an empty list. An empty list because nothing is lost
 * and an empty list because nothing could be read are not the same sentence.
 */
export function printAccessDelta(delta: AccessDelta, indent = '  '): void {
  const i = indent;

  if (delta.coverage === 'unknown') {
    console.log(chalk.yellow(`${i}${delta.summary}`));
    if (delta.note) console.log(chalk.yellow(`${i}${delta.note}`));
    console.log('');
    return;
  }

  if (delta.principalIsPlatformAdmin) {
    console.log(chalk.yellow(`${i}${delta.summary}`));
    console.log('');
    return;
  }

  if (delta.losesNothing) {
    console.log(chalk.green(`${i}${delta.summary}`));
    printGains(delta, i);
    console.log('');
    return;
  }

  console.log(chalk.red(`${i}${delta.summary}`));
  console.log('');

  printApplicationsLost(delta, i);
  printLosses(delta, i);
  if (delta.losesEverything) {
    console.log(chalk.red(`${i}They are left with no access at all.`));
  }
  printGains(delta, i);
  console.log('');
}

function printApplicationsLost(delta: AccessDelta, i: string): void {
  if (delta.applicationsLostCount === 0) return;

  console.log(
    `${i}${chalk.bold('No longer reaches')} ${chalk.bold(
      String(delta.applicationsLostCount),
    )} application${delta.applicationsLostCount === 1 ? '' : 's'}:`,
  );
  for (const app of delta.applicationsLost) {
    const cluster = app.clusterName ? `  (${app.clusterName})` : '';
    console.log(`${i}  ${app.slug}${chalk.dim(cluster)}`);
  }
  const hidden = delta.applicationsLostCount - delta.applicationsLost.length;
  if (hidden > 0) console.log(chalk.dim(`${i}  …and ${hidden} more`));
  if (delta.coverage === 'snapshot') {
    console.log(
      chalk.yellow(
        `${i}  …plus anything matching that scope from now on — this list is today's, not the whole rule.`,
      ),
    );
  }
  console.log('');
}

function printLosses(delta: AccessDelta, i: string): void {
  if (delta.sectionsClosed.length) {
    console.log(
      `${i}${chalk.bold('Sections that close:')} ${delta.sectionsClosed
        .map((s) => s.key)
        .join(', ')}`,
    );
  }
  if (delta.sectionsDowngraded.length) {
    console.log(
      `${i}${chalk.bold('Sections that become read-only:')} ${delta.sectionsDowngraded
        .map((s) => s.key)
        .join(', ')}`,
    );
  }
  if (delta.permissionsLost.length) {
    console.log(
      `${i}${chalk.bold('Permissions given up:')} ${chalk.dim(
        delta.permissionsLost.join(', '),
      )}`,
    );
  }
}

function printGains(delta: AccessDelta, i: string): void {
  if (delta.applicationsGainedCount > 0) {
    console.log(
      `${i}${chalk.bold('Now reaches')} ${delta.applicationsGainedCount} application${
        delta.applicationsGainedCount === 1 ? '' : 's'
      }${
        delta.applicationsGained.length
          ? chalk.dim(
              `: ${delta.applicationsGained
                .slice(0, 5)
                .map((a) => a.slug)
                .join(', ')}`,
            )
          : ''
      }`,
    );
  }
  if (delta.sectionsOpened.length) {
    console.log(
      `${i}${chalk.bold('Sections that open:')} ${delta.sectionsOpened
        .map((s) => s.key)
        .join(', ')}`,
    );
  }
}
