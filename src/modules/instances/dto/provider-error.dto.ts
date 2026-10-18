import { Sensitivity } from '../../mask/decorators/sensitivity.decorator';
import { ApiProperty } from '@nestjs/swagger';

export class ProviderErrorDto {
  @ApiProperty({
    description: 'Provider identifier',
    example: 'hetzner',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  provider: string;

  @ApiProperty({
    description: 'Error message',
    example: 'Authentication failed',
  })
  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  message: string;

  constructor(provider: string, message: string) {
    this.provider = provider;
    this.message = message;
  }
}
