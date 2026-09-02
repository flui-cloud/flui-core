import { CallHandler, Controller, ExecutionContext, Get } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiProperty,
  ApiPropertyOptional,
} from '@nestjs/swagger';
import { firstValueFrom, of } from 'rxjs';
import { MaskResponseInterceptor } from './mask-response.interceptor';
import { SensitivityRegistry } from '../sensitivity.registry';
import { Sensitivity } from '../decorators/sensitivity.decorator';
import { CREDENTIAL_PLACEHOLDER } from '../utils/fake-value.util';

class NestedDto {
  @Sensitivity(Sensitivity.TENANT_IDENTITY)
  @ApiProperty()
  email: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  label: string;
}

class TestObjectDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  id: string;

  @Sensitivity(Sensitivity.CREDENTIAL)
  @ApiProperty()
  secret: string;

  @Sensitivity(Sensitivity.CREDENTIAL)
  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' } })
  kv: Record<string, string>;

  @Sensitivity(Sensitivity.CREDENTIAL, { conditional: true })
  @ApiProperty()
  mintedKey: string;

  @Sensitivity(Sensitivity.NETWORK_IDENTIFIER)
  @ApiProperty()
  ip: string;

  @Sensitivity(Sensitivity.NETWORK_IDENTIFIER)
  @ApiPropertyOptional({ type: [String] })
  extraIps?: string[];

  @ApiProperty({ type: [NestedDto] })
  people: NestedDto[];
}

// A real class + real @ApiOkResponse decorator, so the interceptor reads the
// metadata @nestjs/swagger itself would put there in production.
@Controller('test')
class TestController {
  @Get('one')
  @ApiOkResponse({ type: TestObjectDto })
  one() {
    return null;
  }

  @Get('many')
  @ApiOkResponse({ type: [TestObjectDto] })
  many() {
    return null;
  }

  @Get('unclassified')
  unclassified() {
    return null;
  }
}

function context(
  handler: () => unknown,
  headerValue?: string,
): ExecutionContext {
  return {
    getType: () => 'http',
    getHandler: () => handler,
    switchToHttp: () => ({
      getRequest: () => ({
        headers:
          headerValue === undefined ? {} : { 'x-mask-mode': headerValue },
        user: { userId: 'user-1', iat: 1000 },
      }),
    }),
  } as unknown as ExecutionContext;
}

const next = (body: unknown): CallHandler =>
  ({ handle: () => of(body) }) as CallHandler;

const config = { get: () => 'test-mask-salt-secret' } as any;

describe('MaskResponseInterceptor', () => {
  const interceptor = new MaskResponseInterceptor(
    new SensitivityRegistry(),
    config,
  );

  it('passes a route with no declared response DTO straight through', async () => {
    const body = { anything: 'goes', secretLooking: 'unmasked-on-purpose' };
    const out = await firstValueFrom(
      interceptor.intercept(
        context(TestController.prototype.unclassified, 'on'),
        next(body),
      ),
    );
    expect(out).toBe(body);
  });

  it('masks credential fields unconditionally, header off', async () => {
    const body = {
      id: 'i-1',
      secret: 'sk-real-value',
      kv: { PASSWORD: 'hunter2', TOKEN: 'abc123' },
      ip: '203.0.113.250', // already looks masked-shaped, but this is the *real* input value
      people: [{ email: 'real@customer.example', label: 'x' }],
    };
    const out = (await firstValueFrom(
      interceptor.intercept(context(TestController.prototype.one), next(body)),
    )) as typeof body;

    expect(out.id).toBe('i-1');
    expect(out.secret).toBe(CREDENTIAL_PLACEHOLDER);
    expect(out.kv).toEqual({
      PASSWORD: CREDENTIAL_PLACEHOLDER,
      TOKEN: CREDENTIAL_PLACEHOLDER,
    });
    // header off: network-identifier / tenant-identity pass through untouched
    expect(out.ip).toBe('203.0.113.250');
    expect(out.people[0].email).toBe('real@customer.example');
    expect(out.people[0].label).toBe('x');
  });

  it('a conditional credential field (e.g. a one-time key mint) shows the real value when the header is off', async () => {
    const body = { id: 'i-1', secret: 's', kv: {}, mintedKey: 'sk-real-mint' };
    const out = (await firstValueFrom(
      interceptor.intercept(context(TestController.prototype.one), next(body)),
    )) as typeof body;

    expect(out.mintedKey).toBe('sk-real-mint');
  });

  it('a conditional credential field masks with the opaque placeholder when the header is on, never a realistic fake', async () => {
    const body = { id: 'i-1', secret: 's', kv: {}, mintedKey: 'sk-real-mint' };
    const out = (await firstValueFrom(
      interceptor.intercept(
        context(TestController.prototype.one, 'on'),
        next(body),
      ),
    )) as typeof body;

    expect(out.mintedKey).toBe(CREDENTIAL_PLACEHOLDER);
  });

  it('also masks network-identifier and tenant-identity fields when the header says on', async () => {
    const body = {
      id: 'i-1',
      secret: 'sk-real-value',
      kv: { PASSWORD: 'hunter2' },
      ip: '198.51.100.7',
      extraIps: ['1.2.3.4', '5.6.7.8'],
      people: [{ email: 'real@customer.example', label: 'x' }],
    };
    const out = (await firstValueFrom(
      interceptor.intercept(
        context(TestController.prototype.one, 'on'),
        next(body),
      ),
    )) as typeof body;

    expect(out.secret).toBe(CREDENTIAL_PLACEHOLDER);
    expect(out.ip).not.toBe('198.51.100.7');
    expect(out.ip).toMatch(/^203\.0\.113\.\d{1,3}$/);
    expect(out.extraIps).toHaveLength(2);
    expect(out.extraIps![0]).not.toBe('1.2.3.4');
    expect(out.extraIps![0]).toMatch(/^203\.0\.113\.\d{1,3}$/);
    expect(out.people[0].email).not.toBe('real@customer.example');
    expect(out.people[0].email).toMatch(/^user-[0-9a-f]{8}@example\.com$/);
    expect(out.people[0].label).toBe('x'); // public sibling untouched
  });

  it('is deterministic for the same session and the same real value', async () => {
    const body = { id: 'a', secret: 's', kv: {}, ip: '10.1.2.3', people: [] };
    const [a, b] = await Promise.all([
      firstValueFrom(
        interceptor.intercept(
          context(TestController.prototype.one, 'on'),
          next(body),
        ),
      ),
      firstValueFrom(
        interceptor.intercept(
          context(TestController.prototype.one, 'on'),
          next(body),
        ),
      ),
    ]);
    expect((a as { ip: string }).ip).toBe((b as { ip: string }).ip);
  });

  it('masks every element of an array-of-DTO route response', async () => {
    const body = [
      { id: 'a', secret: 's1', kv: {}, ip: '1.1.1.1', people: [] },
      { id: 'b', secret: 's2', kv: {}, ip: '2.2.2.2', people: [] },
    ];
    const out = (await firstValueFrom(
      interceptor.intercept(
        context(TestController.prototype.many, 'on'),
        next(body),
      ),
    )) as typeof body;

    expect(out).toHaveLength(2);
    expect(out[0].secret).toBe(CREDENTIAL_PLACEHOLDER);
    expect(out[1].secret).toBe(CREDENTIAL_PLACEHOLDER);
    expect(out[0].ip).not.toBe('1.1.1.1');
  });
});
