/**
 * The API address an agent outside this instance must use. The process knows
 * the port it listens on and nothing about the name it is reached by, so the
 * public address is read from the same three variables the mail webhook
 * registrar reads, in the same order; localhost last, so a development
 * instance gets a usable URL instead of one that is confidently wrong.
 */
export function publicApiBaseUrl(
  read: (key: string) => string | undefined,
): string {
  const configured = ['PUBLIC_API_URL', 'FLUI_API_ENDPOINT', 'API_BASE_URL']
    .map((key) => read(key)?.trim())
    .find((value) => !!value);
  let base = configured || `http://localhost:${read('PORT') ?? '3000'}`;
  while (base.endsWith('/')) base = base.slice(0, -1);
  return `${base}/api/v1`;
}
