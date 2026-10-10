/** A range-query step that is safe to put inside a selector window. */
export function safeStep(step: string): string {
  return /^\d{1,4}[smh]$/.test(step) ? step : '60s';
}
