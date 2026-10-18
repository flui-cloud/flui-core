/**
 * Checks a Hetzner Cloud token before it is stored, the way the Scaleway and
 * OVH keys already are, so a mistyped token is caught where it was typed and
 * not three commands later. A read of the locations list is enough: 401 means
 * the token is wrong; anything else not 2xx is reported as it is.
 */
import * as https from 'node:https';

export interface HetznerValidationResult {
  success: boolean;
  message: string;
}

export async function validateHetznerToken(
  token: string,
): Promise<HetznerValidationResult> {
  if (!token) return { success: false, message: 'The API token is empty' };

  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: 'api.hetzner.cloud',
        path: '/v1/locations',
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, Connection: 'close' },
        timeout: 10_000,
        agent: false,
      },
      (res) => {
        res.resume();
        const status = res.statusCode ?? 0;
        if (status >= 200 && status < 300) {
          resolve({ success: true, message: 'Token is valid' });
        } else if (status === 401) {
          resolve({
            success: false,
            message:
              'Hetzner does not recognise this token. Copy it again from the project: Security → API tokens',
          });
        } else {
          resolve({
            success: false,
            message: `Hetzner answered HTTP ${status}`,
          });
        }
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) =>
      resolve({
        success: false,
        message: `Could not reach Hetzner: ${err.message}`,
      }),
    );
    req.end();
  });
}
