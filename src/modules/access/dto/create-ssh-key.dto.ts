import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsOptional,
  IsObject,
  IsNotEmpty,
  IsArray,
  IsEnum,
  Matches,
  MaxLength,
} from 'class-validator';
import { CloudProvider } from '../../providers/enums/cloud-provider.enum';

export class CreateSSHKeyDto {
  @ApiProperty({
    description: 'Name of the SSH key',
    example: 'my-deployment-key',
  })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({
    description: 'User name for the SSH key',
    example: 'john.doe',
  })
  @IsString()
  @IsNotEmpty()
  // Becomes a directory name under the keys root, so it is spelled out here as
  // well as asserted at the storage layer: a name is not a path.
  // The negative lookahead is not decoration: `.` and `..` are made only of
  // characters this class allows, and both are directory names with a meaning.
  @Matches(/^(?!\.+$)[a-zA-Z0-9._-]+$/, {
    message:
      'userName may contain only letters, digits, dots, underscores and hyphens, and cannot be "." or ".."',
  })
  @MaxLength(64)
  userName: string;

  @ApiPropertyOptional({
    description: 'Key-value pairs for tagging. Values can be strings or arrays',
    example: {
      'cluster-id': ['k3s-prod-eu-001', 'k3s-prod-eu-002'],
      'cluster-node-id': 'node-master-01',
      environment: 'production',
    },
  })
  @IsOptional()
  @IsObject()
  tags?: Record<string, string | string[]>;

  @ApiPropertyOptional({
    description:
      'Cloud providers to sync the SSH key to. Defaults to all configured providers.',
    enum: CloudProvider,
    isArray: true,
    example: [CloudProvider.SCALEWAY],
  })
  @IsOptional()
  @IsArray()
  @IsEnum(CloudProvider, { each: true })
  providers?: CloudProvider[];
}
