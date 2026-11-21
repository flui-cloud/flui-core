import {
  X509Certificate,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
} from 'node:crypto';
import {
  generateRsaPrivateKey,
  selfSignedCertificate,
} from './self-signed-certificate.util';

describe('self-signed certificate', () => {
  const key = generateRsaPrivateKey(2048);

  it('generates an RSA private key of the asked size in PKCS#8 PEM', () => {
    const parsed = createPrivateKey(key);
    expect(key.startsWith('-----BEGIN PRIVATE KEY-----')).toBe(true);
    expect(parsed.asymmetricKeyType).toBe('rsa');
    expect(parsed.asymmetricKeyDetails?.modulusLength).toBe(2048);
  });

  it('writes the key as PKCS#1 when asked, and still certifies it', () => {
    const pkcs1 = generateRsaPrivateKey(2048, 'pkcs1');
    expect(pkcs1.startsWith('-----BEGIN RSA PRIVATE KEY-----')).toBe(true);
    const cert = new X509Certificate(
      selfSignedCertificate(pkcs1, { commonName: 'x', validDays: 1 }),
    );
    expect(cert.checkPrivateKey(createPrivateKey(pkcs1))).toBe(true);
  });

  it('issues a certificate that belongs to the key and verifies itself', () => {
    const now = new Date('2026-11-20T10:00:00.000Z');
    const cert = new X509Certificate(
      selfSignedCertificate(key, {
        commonName: 'harbor-token-ca',
        validDays: 3650,
        now,
      }),
    );

    expect(cert.subject).toBe('CN=harbor-token-ca');
    expect(cert.issuer).toBe('CN=harbor-token-ca');
    expect(cert.ca).toBe(true);
    expect(cert.checkPrivateKey(createPrivateKey(key))).toBe(true);
    expect(cert.verify(createPublicKey(key))).toBe(true);
    expect(new Date(cert.validFrom).toISOString()).toBe(now.toISOString());
    expect(new Date(cert.validTo).toISOString()).toBe(
      '2036-11-17T10:00:00.000Z',
    );
  });

  it('writes validity past 2049 as generalized time', () => {
    const cert = new X509Certificate(
      selfSignedCertificate(key, {
        commonName: 'long-lived',
        validDays: 365 * 40,
        now: new Date('2026-01-01T00:00:00.000Z'),
      }),
    );
    expect(new Date(cert.validTo).getUTCFullYear()).toBe(2065);
  });

  it('gives every certificate its own serial number', () => {
    const options = { commonName: 'x', validDays: 1 };
    const a = new X509Certificate(selfSignedCertificate(key, options));
    const b = new X509Certificate(selfSignedCertificate(key, options));
    expect(a.serialNumber).not.toBe(b.serialNumber);
  });

  it('refuses a key that is not RSA', () => {
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
    expect(() =>
      selfSignedCertificate(ec, { commonName: 'x', validDays: 1 }),
    ).toThrow('RSA');
  });
});
