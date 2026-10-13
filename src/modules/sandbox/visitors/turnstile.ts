const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export type Fetch = typeof fetch;

/** Cloudflare's answer to "did a person's browser solve this?". Anything but a clear yes is a no. */
export async function verifyTurnstile(
  secret: string,
  token: string,
  ip: string | null,
  fetchImpl: Fetch = fetch,
): Promise<boolean> {
  const body = new URLSearchParams({ secret, response: token });
  if (ip) body.set('remoteip', ip);
  const resp = await fetchImpl(SITEVERIFY, {
    method: 'POST',
    body,
    signal: AbortSignal.timeout(5000),
  });
  if (!resp.ok) return false;
  const data = (await resp.json()) as { success?: unknown };
  return data.success === true;
}
