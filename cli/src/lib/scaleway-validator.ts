/**
 * Local Scaleway credential validator.
 *
 * Used by the CLI before storing credentials so the user gets immediate
 * feedback. Mirrors the probe used by ScalewayCapabilitiesService.validateCredentials:
 * call IAM listSSHKeys with X-Auth-Token. Anything other than 401/403 is treated
 * as a transient error.
 */
import * as https from 'node:https';

export interface ScalewayValidationResult {
  success: boolean;
  message: string;
}

export async function validateScalewayCredentials(
  accessKey: string,
  secretKey: string,
): Promise<ScalewayValidationResult> {
  if (!accessKey || !secretKey) {
    return {
      success: false,
      message: 'Both Access Key ID and Secret Key are required',
    };
  }

  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: 'api.scaleway.com',
        path: '/iam/v1alpha1/ssh-keys?page_size=1',
        method: 'GET',
        headers: { 'X-Auth-Token': secretKey, Connection: 'close' },
        timeout: 10_000,
        // No keep-alive pooling: leave no lingering socket that would keep the
        // event loop alive and hang the CLI after validation returns.
        agent: false,
      },
      (res) => {
        res.resume();
        const status = res.statusCode ?? 0;
        if (status >= 200 && status < 300) {
          resolve({ success: true, message: 'Credentials are valid' });
          return;
        }
        if (status === 401 || status === 403) {
          resolve({ success: false, message: 'Invalid Secret Key' });
          return;
        }
        resolve({
          success: false,
          message: `Scaleway IAM probe returned HTTP ${status}`,
        });
      },
    );

    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });
    req.on('error', (err) => {
      resolve({
        success: false,
        message: `Validation failed: ${err.message}`,
      });
    });
    req.end();
  });
}
