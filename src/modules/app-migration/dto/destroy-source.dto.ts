import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

export class DestroySourceDto {
  @ApiPropertyOptional({
    description:
      'Close an open bridge now, even if DNS answers cached before the switch may still point at the source.',
  })
  @IsOptional()
  @IsBoolean()
  closeBridge?: boolean;
}
