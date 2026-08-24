import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
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

  /**
   * NULL for the installation's connection, a user id for a personal one — the
   * two levels of decision 104, said out loud so a screen can label the row
   * instead of guessing. Never a key, and never anything about the key.
   */
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      "Owner of a personal connection; null when the connection is the installation's",
  })
  ownerUserId: string | null;

  @ApiProperty()
  createdAt: Date;

  static fromEntity(e: InferenceConnectionEntity): InferenceConnectionDto {
    return {
      id: e.id,
      label: e.label,
      baseUrl: e.base_url,
      models: e.models ?? [],
      isDefault: e.is_default,
      ownerUserId: e.owner_user_id ?? null,
      createdAt: e.created_at,
    };
  }
}
