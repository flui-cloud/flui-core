import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SandboxTenantState } from '../entities/sandbox-tenant.entity';

/**
 * One guest area, as an operator needs to see it.
 *
 * The guest's address is not here. The area is identified by its namespace,
 * which is what every other surface — a log line, a quota, a listing — already
 * calls it, and knowing who holds it adds nothing to deciding whether it should
 * still exist.
 */
export class SandboxTenancyDto {
  @ApiProperty() id: string;
  @ApiProperty({ enum: SandboxTenantState }) state: SandboxTenantState;
  @ApiProperty() namespace: string;
  @ApiProperty() clusterId: string;
  @ApiPropertyOptional() claimedAt?: Date | null;
  @ApiPropertyOptional() expiresAt?: Date | null;
  @ApiPropertyOptional() reapedAt?: Date | null;

  @ApiProperty({
    description:
      'Consecutive sweeps that ended in the same error. It resets whenever the error changes, and once it reaches the limit the row stops being swept and waits for a person.',
  })
  reapAttempts: number;

  @ApiPropertyOptional() lastError?: string | null;
  @ApiProperty() createdAt: Date;
}
