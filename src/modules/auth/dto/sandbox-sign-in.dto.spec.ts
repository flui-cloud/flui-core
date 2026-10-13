import { DECORATORS } from '@nestjs/swagger/dist/constants';
import { SensitivityRegistry } from '../../mask/sensitivity.registry';
import { Sensitivity } from '../../mask/constants/sensitivity';
import {
  ConnectSignInProviderDto,
  SignInProviderStatusDto,
  SignInProvidersDto,
} from './sandbox-sign-in.dto';

describe('the sign-in provider DTOs under mask mode', () => {
  const registry = new SensitivityRegistry();

  it('classifies the client secret as a credential and documents it as write-only', () => {
    expect(
      registry.sensitivityOf(ConnectSignInProviderDto, 'clientSecret'),
    ).toBe(Sensitivity.CREDENTIAL);
    const swagger = Reflect.getMetadata(
      DECORATORS.API_MODEL_PROPERTIES,
      ConnectSignInProviderDto.prototype,
      'clientSecret',
    ) as { writeOnly?: boolean };
    expect(swagger.writeOnly).toBe(true);
  });

  it('has no secret anywhere in what it answers', () => {
    const answered = [
      ...registry.getSensitivities(SignInProviderStatusDto).keys(),
      ...registry.getSensitivities(SignInProvidersDto).keys(),
    ];
    expect(answered).not.toContain('clientSecret');
    expect(registry.sensitivityOf(SignInProviderStatusDto, 'connectedBy')).toBe(
      Sensitivity.TENANT_IDENTITY,
    );
  });
});
