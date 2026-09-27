import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AddGatewayRouteDto, SetGatewayPolicyDto } from './gateway-route.dto';

async function allowIpsErrors(allowIps: string[]): Promise<string[]> {
  const dto = plainToInstance(SetGatewayPolicyDto, { allowIps });
  const errors = await validate(dto);
  return errors.flatMap((e) => Object.values(e.constraints ?? {}));
}

describe('gateway allowIps validation', () => {
  it.each([
    '203.0.113.7',
    '203.0.113.0/24',
    '0.0.0.0/0',
    '2001:db8::/32',
    '::1',
    '::/0',
  ])('accepts %s', async (value) => {
    await expect(allowIpsErrors([value])).resolves.toEqual([]);
  });

  it.each([
    '999.1.1.1/40',
    '::::',
    '10.0.0.0/33',
    '2001:db8::/129',
    '10.0.0.0/',
    '10.0.0/8',
    '1.2.3.4/8/8',
    '',
  ])('rejects %s and names it', async (value) => {
    const errors = await allowIpsErrors(['10.0.0.0/8', value]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(`"${value}"`);
  });

  it('applies the same rule when a route is added', async () => {
    const dto = plainToInstance(AddGatewayRouteDto, {
      host: 'api.example.com',
      allowIps: ['999.1.1.1/40'],
    });
    const errors = await validate(dto);
    expect(errors.map((e) => e.property)).toContain('allowIps');
  });
});
