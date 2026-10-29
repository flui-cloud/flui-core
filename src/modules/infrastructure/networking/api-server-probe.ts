import * as https from 'node:https';

/**
 * Whether an API server answers at this address with a certificate the
 * cluster's own CA vouches for, under this address. Any HTTP answer proves the
 * path: 401 is what an unauthenticated probe gets, and getting it means TCP,
 * TLS and the certificate's names all worked. Only silence is a failure.
 */
export function apiServerAnswers(
  host: string,
  port: string,
  caBase64: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    let ca: Buffer;
    try {
      ca = Buffer.from(caBase64, 'base64');
    } catch {
      resolve(false);
      return;
    }
    const req = https.request(
      { host, port, path: '/readyz', method: 'GET', timeout: 5000, ca },
      (res) => {
        res.resume();
        resolve(true);
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
    req.end();
  });
}
