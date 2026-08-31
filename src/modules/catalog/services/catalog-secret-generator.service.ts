import { Injectable } from '@nestjs/common';
import {
  generateRandomSecret,
  RandomSecretFormat,
} from '../../../common/utils/random-secret.util';

export type CatalogSecretFormat = RandomSecretFormat;

@Injectable()
export class CatalogSecretGeneratorService {
  generate(length: number, format: CatalogSecretFormat = 'base64url'): string {
    return generateRandomSecret(length, format);
  }
}
