import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { OpenIdentityConsoleDto } from './identity-console.dto';

async function errorsFor(reason: unknown): Promise<string[]> {
  const dto = plainToInstance(OpenIdentityConsoleDto, { reason });
  return (await validate(dto)).map((e) => e.property);
}

describe('OpenIdentityConsoleDto', () => {
  it('measures the reason without its surrounding spaces', async () => {
    await expect(errorsFor('   a    ')).resolves.toEqual(['reason']);
    await expect(errorsFor('  fix org policy ')).resolves.toEqual([]);
    expect(
      plainToInstance(OpenIdentityConsoleDto, { reason: '  why  ' }).reason,
    ).toBe('why');
  });

  it('still refuses a reason that is not text', async () => {
    await expect(errorsFor(42)).resolves.toEqual(['reason']);
  });
});
