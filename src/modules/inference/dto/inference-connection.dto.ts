import { ApiProperty } from '@nestjs/swagger';
import { InferenceConnectionEntity } from '../entities/inference-connection.entity';

export class InferenceConnectionDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  label: string;

  @ApiProperty()
  baseUrl: string;

  @ApiProperty({ type: [String] })
  models: string[];

  @ApiProperty()
  isDefault: boolean;

  @ApiProperty()
  createdAt: Date;

  static fromEntity(e: InferenceConnectionEntity): InferenceConnectionDto {
    return {
      id: e.id,
      label: e.label,
      baseUrl: e.base_url,
      models: e.models ?? [],
      isDefault: e.is_default,
      createdAt: e.created_at,
    };
  }
}
