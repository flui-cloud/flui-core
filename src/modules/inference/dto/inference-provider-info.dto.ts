import { ApiProperty } from '@nestjs/swagger';
import { CloudProvider } from '../../providers/enums/cloud-provider.enum';

export class InferenceProviderInfoDto {
  @ApiProperty({ enum: CloudProvider })
  provider: CloudProvider;

  @ApiProperty({ description: 'OpenAI-compatible base URL' })
  baseUrl: string;

  @ApiProperty()
  euDataResidency: boolean;

  @ApiProperty({ description: 'Whether a usable inference credential exists' })
  configured: boolean;

  @ApiProperty({
    type: [String],
    description: 'Live model ids when configured',
  })
  models: string[];

  @ApiProperty({
    description: 'Default chat model used when none is specified',
    required: false,
  })
  defaultModel?: string;
}
