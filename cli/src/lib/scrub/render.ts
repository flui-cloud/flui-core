import type { ScrubPlan, ScrubVerdict } from './plan';

/**
 * The plan, as the customer reads it.
 *
 * Separated from the command so the wording is testable: this is the only place
 * that tells someone their provider account is about to lose a server, and a
 * line that says "remove" next to something the plan will not remove would be
 * worse than no output at all. Colour arrives as an argument for the same
 * reason — the palette is the command's business, the sentences are not.
 */
export interface Palette {
  bold(text: string): string;
  dim(text: string): string;
  cyan(text: string): string;
  warn(text: string): string;
  danger(text: string): string;
}

const PLAIN: Palette = {
  bold: (text) => text,
  dim: (text) => text,
  cyan: (text) => text,
  warn: (text) => text,
  danger: (text) => text,
};

const MARKERS: Readonly<Record<ScrubVerdict, string>> = {
  remove: 'remove      ',
  refused: 'refused     ',
  'already-gone': 'already gone',
  released: 'released    ',
};

function paint(palette: Palette, verdict: ScrubVerdict): string {
  const marker = MARKERS[verdict];
  if (verdict === 'remove') return palette.danger(marker);
  if (verdict === 'refused') return palette.warn(marker);
  return palette.dim(marker);
}

export function renderPlan(
  plan: ScrubPlan,
  blind: readonly string[],
  palette: Palette = PLAIN,
): string[] {
  const lines: string[] = [];

  for (const { entry, match, verdict, reason } of plan.decisions) {
    const where = match
      ? palette.dim(` ${match.provider}/${match.providerId}`)
      : '';
    lines.push(
      `   ${paint(palette, verdict)}  ${palette.bold(entry.kind)} ${palette.cyan(entry.name)}${where}`,
      `   ${' '.repeat(12)}  ${palette.dim(reason)}`,
    );
  }

  if (plan.unclaimed.length > 0) {
    lines.push(
      '',
      palette.dim(
        `   ${plan.unclaimed.length} other Flui-managed resource(s) on this account are not in your list and will not be touched:`,
      ),
    );
    for (const resource of plan.unclaimed) {
      lines.push(
        palette.dim(
          `     ${resource.kind} ${resource.name} (${resource.provider}/${resource.providerId})`,
        ),
      );
    }
  }

  for (const failure of blind) {
    lines.push('', palette.warn(`   ⚠  ${failure}`));
  }

  return lines;
}
