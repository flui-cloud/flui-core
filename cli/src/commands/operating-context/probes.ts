import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { printContextBanner } from '../../lib/context-banner';
import {
  OperatingContextClient,
  ProbeCard,
} from '../../lib/operating-context/context-client';
import { asksOf } from '../../lib/operating-context/note-draft';

/**
 * What a note may be made to lean on, and what each fact wants asked of it.
 *
 * Printed from the catalogue and from nothing else. Until this command existed
 * the CLI could post a note against a probe and could not ask which probes were
 * offered or what they took, so a premise was written blind and the refusal
 * arrived as a 400 nobody could have prevented — the same defect the dashboard
 * had until the catalogue was published, on the surface nobody had checked.
 */
export default class OperatingContextProbes extends Command {
  static readonly description =
    'The live facts a note can be made to lean on, and what each one is asked for';
  static readonly examples = ['<%= config.bin %> <%= command.id %>'];
  static readonly flags = { json: Flags.boolean({ default: false }) };

  async run(): Promise<void> {
    const { flags } = await this.parse(OperatingContextProbes);
    printContextBanner();

    const cards = await OperatingContextClient.fromConfig().probes();
    if (flags.json) {
      this.log(JSON.stringify(cards, null, 2));
      return;
    }

    if (cards.length === 0) {
      this.log(
        chalk.dim(
          '\n   Nothing on this installation offers a fact a note can lean on.\n',
        ),
      );
      return;
    }

    this.log('');
    for (const card of cards) {
      this.log(`   ${chalk.bold(card.id)}`);
      this.log(`     ${card.describes}`);
      for (const line of asksLines(card)) this.log(line);
      for (const line of answersLines(card)) this.log(line);
      this.log('');
    }
  }
}

function asksLines(card: ProbeCard): string[] {
  const asks = asksOf(card);
  // Said out loud rather than printed as "takes nothing": the two are
  // different instructions to whoever writes the note.
  if (!asks) return [chalk.dim('     it did not publish what it is asked for')];
  if (asks.length === 0) return [chalk.dim('     asked for nothing')];
  return asks.map((ask) => {
    // "optional" is the wrong word for half of a pair: neither is required on
    // its own and one of them is. Saying so here is what keeps somebody from
    // filling the form correctly and being refused anyway.
    const need = ask.orElse
      ? `either this or ${ask.orElse}`
      : ask.required
        ? 'required'
        : 'optional';
    const set = ask.choices ? ` — one of ${ask.choices.join(', ')}` : '';
    return `     ${chalk.cyan(ask.name)}  ${chalk.dim(need)}${set}`;
  });
}

function answersLines(card: ProbeCard): string[] {
  if (card.answers) return [chalk.dim(`     answers a ${card.answers}`)];
  if (!card.answersPer) return [];
  const per = Object.entries(card.answersPer.types)
    .map(([value, type]) => `${value}: ${type}`)
    .join(', ');
  return [chalk.dim(`     answers, by ${card.answersPer.param} — ${per}`)];
}
