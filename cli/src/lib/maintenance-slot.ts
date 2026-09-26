import type { MaintenanceWindow } from './services/cli-app.service';

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

/**
 * `tue,thu 02:00 2h` → one slot. The duration takes `90m`, `2h`, `1h30m` or a
 * bare number of minutes. Throws a sentence a person can act on.
 */
export function parseSlot(text: string): MaintenanceWindow['slots'][number] {
  const parts = text.trim().split(/\s+/);
  if (parts.length !== 3) {
    throw new Error(
      `"${text}" is not a slot: write days, start and length, e.g. "tue,thu 02:00 2h".`,
    );
  }
  const [daysText, start, length] = parts;
  const days = daysText.toLowerCase().split(',').filter(Boolean);
  const wrong = days.filter((d) => !DAYS.includes(d));
  if (!days.length || wrong.length) {
    throw new Error(
      `"${daysText}": days are ${DAYS.join(', ')}, separated by commas.`,
    );
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(start)) {
    throw new Error(`"${start}" is not a start time: write HH:MM, e.g. 02:00.`);
  }
  const durationMinutes = minutesOf(length);
  if (durationMinutes === null) {
    throw new Error(
      `"${length}" is not a length: write 90m, 2h, 1h30m or minutes.`,
    );
  }
  return { days, start, durationMinutes };
}

export function windowOf(slots: string[], timezone: string): MaintenanceWindow {
  return { timezone, slots: slots.map(parseSlot) };
}

function minutesOf(text: string): number | null {
  if (/^\d+$/.test(text)) return Number(text);
  const m = /^(?:(\d+)h)?(?:(\d+)m)?$/.exec(text);
  if (!m || (!m[1] && !m[2])) return null;
  return Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0);
}
