/**
 * Local OVH (OpenStack) credential validator.
 *
 * Used by the CLI before storing credentials so the user gets immediate
 * feedback. Mirrors the probe used by OvhCapabilitiesService.validateCredentials:
 * an unscoped Keystone v3 password auth against OVH's public endpoint — a 401
 * means the credential itself is wrong, anything else is treated as transient.
 * Does not resolve/validate the OpenStack project id (that happens later, at
 * provisioning time) — this is a lightweight "is this username/password real"
 * check.
 */
export interface OvhValidationResult {
  success: boolean;
  message: string;
}

const OVH_AUTH_URL = 'https://auth.cloud.ovh.net/v3';

export async function validateOvhCredentials(
  username: string,
  password: string,
): Promise<OvhValidationResult> {
  if (!username || !password) {
    return {
      success: false,
      message: 'Both OpenStack username and password are required',
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(`${OVH_AUTH_URL}/auth/tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        auth: {
          identity: {
            methods: ['password'],
            password: {
              user: {
                name: username,
                domain: { name: 'Default' },
                password,
              },
            },
          },
        },
      }),
      signal: controller.signal,
    });
    if (res.status === 401) {
      return { success: false, message: 'Invalid username or password' };
    }
    if (!res.ok) {
      return {
        success: false,
        message: `OVH Keystone probe returned HTTP ${res.status}`,
      };
    }
    return { success: true, message: 'Credentials are valid' };
  } catch (err) {
    return {
      success: false,
      message: `Validation failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timeout);
  }
}
