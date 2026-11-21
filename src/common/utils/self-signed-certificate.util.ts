import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
} from 'node:crypto';

export const RSA_KEY_BITS = [2048, 3072, 4096] as const;
export type RsaKeyBits = (typeof RSA_KEY_BITS)[number];
export const RSA_KEY_FORMATS = ['pkcs8', 'pkcs1'] as const;
export type RsaKeyFormat = (typeof RSA_KEY_FORMATS)[number];

export interface SelfSignedCertificateOptions {
  commonName: string;
  validDays: number;
  now?: Date;
}

const OID_COMMON_NAME = '2.5.4.3';
const OID_SHA256_WITH_RSA = '1.2.840.113549.1.1.11';
const OID_BASIC_CONSTRAINTS = '2.5.29.19';
const OID_KEY_USAGE = '2.5.29.15';
const KEY_USAGE_DIGITAL_SIGNATURE_AND_CERT_SIGN = Buffer.from([0x02, 0x84]);
const UTC_TIME_LAST_YEAR = 2049;

/** PKCS#8 (`BEGIN PRIVATE KEY`) by default; PKCS#1 (`BEGIN RSA PRIVATE KEY`) for software that reads only that. */
export function generateRsaPrivateKey(
  bits: RsaKeyBits = 4096,
  format: RsaKeyFormat = 'pkcs8',
): string {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: bits });
  return privateKey.export({ type: format, format: 'pem' }).toString();
}

/** A self-signed X.509 v3 certificate for an RSA private key, PEM encoded. */
export function selfSignedCertificate(
  privateKeyPem: string,
  options: SelfSignedCertificateOptions,
): string {
  const privateKey = createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== 'rsa') {
    throw new Error('A self-signed certificate needs an RSA private key');
  }
  const spki = createPublicKey(privateKey).export({
    type: 'spki',
    format: 'der',
  });
  const notBefore = options.now ?? new Date();
  const notAfter = new Date(notBefore.getTime() + options.validDays * 86400000);
  const name = sequence(
    set(sequence(oid(OID_COMMON_NAME), utf8(options.commonName))),
  );
  const algorithm = sequence(
    oid(OID_SHA256_WITH_RSA),
    tlv(0x05, Buffer.alloc(0)),
  );

  const tbs = sequence(
    tlv(0xa0, integer(Buffer.from([2]))),
    integer(serialNumber()),
    algorithm,
    name,
    sequence(time(notBefore), time(notAfter)),
    name,
    spki,
    tlv(
      0xa3,
      sequence(
        sequence(
          oid(OID_BASIC_CONSTRAINTS),
          tlv(0x01, Buffer.from([0xff])),
          tlv(0x04, sequence(tlv(0x01, Buffer.from([0xff])))),
        ),
        sequence(
          oid(OID_KEY_USAGE),
          tlv(0x01, Buffer.from([0xff])),
          tlv(0x04, tlv(0x03, KEY_USAGE_DIGITAL_SIGNATURE_AND_CERT_SIGN)),
        ),
      ),
    ),
  );
  const signature = sign('sha256', tbs, privateKey);
  const der = sequence(
    tbs,
    algorithm,
    tlv(0x03, Buffer.concat([Buffer.from([0]), signature])),
  );
  return pem('CERTIFICATE', der);
}

function serialNumber(): Buffer {
  const bytes = randomBytes(16);
  bytes[0] &= 0x7f;
  bytes[0] |= 0x01;
  return bytes;
}

function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), length(content.length), content]);
}

function length(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let rest = n; rest > 0; rest = Math.floor(rest / 256)) {
    bytes.unshift(rest % 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function sequence(...parts: Buffer[]): Buffer {
  return tlv(0x30, Buffer.concat(parts));
}

function set(...parts: Buffer[]): Buffer {
  return tlv(0x31, Buffer.concat(parts));
}

function integer(value: Buffer): Buffer {
  return tlv(
    0x02,
    value[0] & 0x80 ? Buffer.concat([Buffer.from([0]), value]) : value,
  );
}

function utf8(value: string): Buffer {
  return tlv(0x0c, Buffer.from(value, 'utf8'));
}

function oid(dotted: string): Buffer {
  const [first, second, ...rest] = dotted.split('.').map(Number);
  const bytes = [first * 40 + second];
  for (const arc of rest) {
    const chunk = [arc & 0x7f];
    for (let v = Math.floor(arc / 128); v > 0; v = Math.floor(v / 128)) {
      chunk.unshift((v & 0x7f) | 0x80);
    }
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

function time(date: Date): Buffer {
  const iso = date.toISOString().replaceAll(/[-:T]/g, '').slice(0, 14);
  return date.getUTCFullYear() <= UTC_TIME_LAST_YEAR
    ? tlv(0x17, Buffer.from(`${iso.slice(2)}Z`))
    : tlv(0x18, Buffer.from(`${iso}Z`));
}

function pem(label: string, der: Buffer): string {
  const body = der.toString('base64').replaceAll(/.{1,64}/g, '$&\n');
  return `-----BEGIN ${label}-----\n${body}-----END ${label}-----\n`;
}
