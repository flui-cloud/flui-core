import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class PublishShowcaseDto {
  @ApiPropertyOptional({
    description:
      'The line shown next to the application, stored as its description. Say what it actually is — the rule of the showcase is that nothing in it is dressed up as something else. Omitted, the description it already has stands.',
    example: 'Measures flui.cloud. Real visitors, no sample data.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  note?: string;
}
