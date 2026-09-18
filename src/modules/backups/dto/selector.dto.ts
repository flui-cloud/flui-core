import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Validate,
  ValidateNested,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * What a Kubernetes namespace may be called.
 *
 * Stated here because these values are written into Velero Backup and Restore
 * resources. The YAML is emitted by a writer now, so a hostile value is quoted
 * rather than obeyed — this is the second lock, and it is the one that gives the
 * caller a sentence instead of a resource that quietly does nothing.
 */
const DNS_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

const NAMESPACE_MESSAGE =
  'namespaces must be valid Kubernetes names: lowercase letters, digits and hyphens';

/**
 * Both halves of the mapping, because `each` only reaches the values.
 *
 * The key is the namespace being renamed and it is written into the resource
 * just as the value is, so checking one and not the other would leave the
 * shorter half of the pair unexamined.
 */
@ValidatorConstraint({ name: 'namespaceMapping', async: false })
class IsNamespaceMapping implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (value === undefined || value === null) return true;
    if (typeof value !== 'object' || Array.isArray(value)) return false;
    return Object.entries(value as Record<string, unknown>).every(
      ([k, v]) =>
        DNS_LABEL.test(k) && typeof v === 'string' && DNS_LABEL.test(v),
    );
  }

  defaultMessage(): string {
    return `namespaceMapping keys and values ${NAMESPACE_MESSAGE.replace('namespaces must be ', 'must both be ')}`;
  }
}

export class BackupScopeSelectorDto {
  @ApiPropertyOptional({ type: [String], example: ['team-blue'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Matches(DNS_LABEL, { each: true, message: NAMESPACE_MESSAGE })
  namespaces?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  applicationIds?: string[];

  @ApiPropertyOptional({ example: 'app=web' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  @Matches(/^[A-Za-z0-9._/=,!()\- ]*$/, {
    message: 'labelSelector contains characters a label selector cannot have',
  })
  labelSelector?: string;
}

/** A database PITR restores into a fresh catalog install rather than in place. */
export class RestoreNewInstallDto {
  @ApiPropertyOptional()
  @IsString()
  @MaxLength(120)
  name: string;

  @ApiPropertyOptional()
  @IsUUID()
  clusterId: string;
}

export class RestoreTargetSelectorDto extends BackupScopeSelectorDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID('4')
  applicationId?: string;

  /**
   * Restore namespace A as namespace B.
   *
   * Both halves are namespace names, and both used to be written into the
   * Restore resource with no quoting at all — `    ${k}: ${v}` — so either could
   * add structure to a resource whose `spec.hooks` runs commands in the pods it
   * restores.
   */
  @ApiPropertyOptional({ example: { 'team-blue': 'team-blue-restored' } })
  @IsOptional()
  @Validate(IsNamespaceMapping)
  namespaceMapping?: Record<string, string>;

  @ApiPropertyOptional({ type: RestoreNewInstallDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => RestoreNewInstallDto)
  newInstall?: RestoreNewInstallDto;
}
