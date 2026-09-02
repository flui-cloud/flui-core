import { Sensitivity as SensitivityLevel } from './constants/sensitivity';
import { SensitivityRegistry } from './sensitivity.registry';
import { IpAddressConfigDto, InstanceDto } from '../instances/dto/instance.dto';
import { CreateApiKeyResultDto } from '../auth/dto/api-key-response.dto';
import { IdentityUserResponseDto } from '../auth/dto/identity-user-response.dto';
import { SecretReadResponseDto } from '../database-console/dto/secret-read-response.dto';

/**
 * The runtime twin of `sensitivity-sentinel.spec.ts`'s static check: this one
 * imports the real DTO classes and asks `SensitivityRegistry` for what it
 * resolves, the same way `MaskResponseInterceptor` does at request time.
 */
describe('SensitivityRegistry, against the four named target surfaces', () => {
  const registry = new SensitivityRegistry();

  it('classifies the instance public IP as network-identifier', () => {
    expect(registry.sensitivityOf(IpAddressConfigDto, 'ip')).toBe(
      SensitivityLevel.NETWORK_IDENTIFIER,
    );
  });

  it('classifies additionalIps as network-identifier and leaves an unrelated field public', () => {
    expect(registry.sensitivityOf(InstanceDto, 'additionalIps')).toBe(
      SensitivityLevel.NETWORK_IDENTIFIER,
    );
    expect(registry.sensitivityOf(InstanceDto, 'id')).toBe(
      SensitivityLevel.PUBLIC,
    );
  });

  it('classifies the minted agent API key as credential', () => {
    expect(registry.sensitivityOf(CreateApiKeyResultDto, 'key')).toBe(
      SensitivityLevel.CREDENTIAL,
    );
  });

  it('classifies the identity-directory email as tenant-identity', () => {
    expect(registry.sensitivityOf(IdentityUserResponseDto, 'email')).toBe(
      SensitivityLevel.TENANT_IDENTITY,
    );
    expect(registry.sensitivityOf(IdentityUserResponseDto, 'id')).toBe(
      SensitivityLevel.PUBLIC,
    );
  });

  it('classifies the OpenBao KV pairs as credential', () => {
    expect(registry.sensitivityOf(SecretReadResponseDto, 'data')).toBe(
      SensitivityLevel.CREDENTIAL,
    );
  });

  it('returns undefined for a field nothing ever classified', () => {
    class Untouched {
      value: string;
    }
    expect(registry.sensitivityOf(Untouched, 'value')).toBeUndefined();
  });
});
