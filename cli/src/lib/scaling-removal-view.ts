import chalk from 'chalk';
import type { RemovalPreviewDto } from 'src/modules/infrastructure/scaling/dto/scaling-response.dto';

/** What lower limits would give back, printed where the person decides. */
export function printRemoval(preview: RemovalPreviewDto): void {
  const mark = preview.proceeds ? chalk.yellow('!') : chalk.cyan('•');
  console.log(`\n  ${mark} ${preview.sentence}`);
  for (const reason of preview.waitsFor) {
    console.log(chalk.dim(`    ${reason.title}: ${reason.fix}`));
  }
}

/** The line that asks for --yes before a machine is given back. */
export function removalNeedsYes(preview: RemovalPreviewDto): string {
  return preview.proceeds
    ? `This gives back ${preview.node}. Run again with --yes to save it.`
    : 'The removal would wait with nothing touched until the reason above is gone. Run again with --yes to save the new limits anyway.';
}
