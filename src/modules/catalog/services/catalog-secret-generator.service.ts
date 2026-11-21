import { Injectable } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import {
  generateRandomSecret,
  RandomSecretFormat,
} from '../../../common/utils/random-secret.util';
import {
  generateRsaPrivateKey,
  RsaKeyBits,
  RsaKeyFormat,
  selfSignedCertificate,
} from '../../../common/utils/self-signed-certificate.util';

export type CatalogSecretFormat = RandomSecretFormat;

const BCRYPT_ROUNDS = 10;

@Injectable()
export class CatalogSecretGeneratorService {
  generate(length: number, format: CatalogSecretFormat = 'base64url'): string {
    return generateRandomSecret(length, format);
  }

  rsaPrivateKey(bits: RsaKeyBits, format: RsaKeyFormat): string {
    return generateRsaPrivateKey(bits, format);
  }

  bcrypt(value: string): string {
    return bcrypt.hashSync(value, BCRYPT_ROUNDS);
  }

  certificate(
    privateKeyPem: string,
    commonName: string,
    validDays: number,
  ): string {
    return selfSignedCertificate(privateKeyPem, { commonName, validDays });
  }
}
