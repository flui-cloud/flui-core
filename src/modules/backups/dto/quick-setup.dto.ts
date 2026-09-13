import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { StorageBackendProvider } from '../../storage/enums/storage-backend-provider.enum';

// MVP: only the 'single' profile is supported. 'mirrored' will be reintroduced
// once writing to two destinations at once is GA.
export type QuickSetupProfile = 'single';

export class QuickSetupDto {
  @ApiProperty({ enum: ['single'] })
  @IsString()
  @IsIn(['single'])
  profile: QuickSetupProfile;

  @ApiPropertyOptional({ default: '0 2 * * *' })
  @IsOptional()
  @IsString()
  cronSchedule?: string | null;

  @ApiPropertyOptional({ default: 30 })
  @IsOptional()
  @IsInt()
  @Min(1)
  retentionDays?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  runFirstBackup?: boolean;

  /**
   * Where backups go. Omit to take the first connected candidate that is not
   * on the cluster's own cloud. A destination on that cloud is refused however
   * it is asked for.
   */
  @ApiPropertyOptional({ enum: StorageBackendProvider })
  @IsOptional()
  @IsEnum(StorageBackendProvider)
  primaryProvider?: StorageBackendProvider;
}

export class SetupOptionsResponse {
  @ApiProperty()
  currentProvider: string;

  @ApiProperty()
  primary: {
    provider: StorageBackendProvider;
    ready: boolean;
    needsConnection: boolean;
    reason?: string;
    message?: string;
  };

  /** Every destination this cluster may use, so a client can offer a choice. */
  @ApiProperty()
  eligible: Array<{
    provider: StorageBackendProvider;
    ready: boolean;
    needsConnection: boolean;
    reason?: string;
    message?: string;
  }>;

  @ApiProperty()
  recommendedReplicas: Array<{
    provider: StorageBackendProvider;
    ready: boolean;
    needsConnection: boolean;
    reason?: string;
    message?: string;
  }>;

  @ApiProperty()
  estimate: {
    currency: 'EUR';
    clusterMonthlyCents: number | null;
    clusterUnavailableReason?: string;
    backupMonthlyCentsBy: {
      single: number | null;
      mirrored: number | null;
    };
    backupUnavailableReason?: string;
    estimatedDataGb: number | null;
    estimatedDataSource?: 'last-backup' | 'pvc-requests';
    backupScope: {
      k8sResources: boolean;
      /**
       * Never a plain `true`: Velero's file-system backup cannot read hostPath
       * volumes, so volumes on the dedicated storage class (what databases use)
       * are not captured while shared-storage ones are.
       */
      persistentVolumes: 'shared-storage-only' | false;
      method: string;
      notes: string;
    };
    disclaimer: string;
  };
}
