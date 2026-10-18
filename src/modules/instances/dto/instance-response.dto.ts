import { Sensitivity } from '../../mask/decorators/sensitivity.decorator';
import { ApiProperty } from '@nestjs/swagger';
import { InstanceDto } from './instance.dto';
import { ProviderErrorDto } from './provider-error.dto';

// ProviderError.ts - Struttura minima per gli errori
export class ProviderError {
  provider: string;
  message: string;

  constructor(provider: string, message: string) {
    this.provider = provider;
    this.message = message;
  }
}

export class InstanceResponseDto {
  @ApiProperty({
    description: 'List of instances',
    type: [InstanceDto],
  })
  @Sensitivity(Sensitivity.PUBLIC)
  data: InstanceDto[];

  @ApiProperty({
    description: 'Partial errors from providers',
    type: [ProviderErrorDto],
    required: false,
  })
  @Sensitivity(Sensitivity.PUBLIC)
  partialErrors?: ProviderErrorDto[];

  constructor(instances: InstanceDto[], errors?: ProviderErrorDto[]) {
    this.data = instances;

    if (errors && errors.length > 0) {
      this.partialErrors = errors;
    }
  }
}
