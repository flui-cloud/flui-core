import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { ZEPTOMAIL_HOSTS } from '@flui-cloud/mail';
import { MailConnectionConfigDto } from './mail-connection.dto';

/**
 * F-060 of the September 2026 register.
 *
 * `region` is the hostname the installation sends its ZeptoMail token to, in an
 * `Authorization: Zoho-enczapikey <token>` header. As free text that is not a
 * blind SSRF but a way to have the credential delivered, with a body of the
 * caller's shaping. The set of legitimate values is published by the provider
 * and small, so it is an allow-list rather than an egress guard.
 */

const dtoFor = (region: string) =>
  plainToInstance(MailConnectionConfigDto, { region });

const errorsOnRegion = async (region: string) =>
  (await validate(dtoFor(region))).find((e) => e.property === 'region');

describe('the ZeptoMail regional host', () => {
  it.each(Object.values(ZEPTOMAIL_HOSTS))('accepts %s', async (host) => {
    expect(await errorsOnRegion(host)).toBeUndefined();
  });

  it.each([
    'attacker.example.test',
    'api.zeptomail.eu.attacker.test',
    '169.254.169.254',
    'localhost',
    'api.zeptomail.eu/',
    'https://api.zeptomail.eu',
    'API.ZEPTOMAIL.EU',
  ])('refuses %p', async (region) => {
    expect(await errorsOnRegion(region)).toBeDefined();
  });

  it('stays optional, because only one provider uses it', async () => {
    const dto = plainToInstance(MailConnectionConfigDto, {});
    expect(
      (await validate(dto)).find((e) => e.property === 'region'),
    ).toBeUndefined();
  });
});
