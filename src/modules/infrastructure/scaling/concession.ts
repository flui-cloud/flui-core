/**
 * How much this installation may spend without being asked.
 *
 * Every other limit in a scaling group is the group's own opinion of itself and
 * moves whenever somebody edits it. This one is not: it is granted from outside
 * the product's data, once, by whoever runs the installation, and no API call
 * can widen it. It is the difference between a machine that decides and a
 * machine that spends.
 *
 * There is no "unlimited". An installation whose ceiling cannot be stated has
 * no sentence to put in front of a person before they agree to it, and the
 * whole point of the grant is that the sentence exists.
 */
export interface SpendingConcession {
  granted: boolean;
  /** The monthly ceiling, in euro. Null whenever nothing is granted. */
  monthlyEur: number | null;
  /** What the grant amounts to, in one line, for a reader who never set it. */
  says: string;
}

export const NO_CONCESSION: SpendingConcession = {
  granted: false,
  monthlyEur: null,
  says:
    'Nothing may be bought without being asked: no spending was granted to ' +
    'this installation. Set SCALING_CONCESSION_MONTHLY_EUR to the most it may ' +
    'commit to per month, and scaling groups set to buy automatically will act ' +
    'up to that figure.',
};

/**
 * Absent, unreadable and negative all land in the same place, and deliberately
 * so: the failure that matters is a typo being read as permission. A grant that
 * cannot be parsed is not a grant.
 */
export function readConcession(raw: unknown): SpendingConcession {
  if (typeof raw !== 'string' || raw.trim() === '') return NO_CONCESSION;

  const monthlyEur = Number(raw.trim());
  if (!Number.isFinite(monthlyEur) || monthlyEur < 0) {
    return {
      ...NO_CONCESSION,
      says: `SCALING_CONCESSION_MONTHLY_EUR is set to "${raw}", which is not an amount. Nothing may be bought without being asked until it is a number of euro per month.`,
    };
  }

  if (monthlyEur === 0) {
    return {
      granted: true,
      monthlyEur: 0,
      says: 'This installation may commit €0 a month on its own, so nothing is bought automatically. Groups still decide, and still raise an alarm naming what to buy.',
    };
  }

  return {
    granted: true,
    monthlyEur,
    says: `This installation may commit up to €${monthlyEur} a month on its own, and only through groups set to buy automatically.`,
  };
}
