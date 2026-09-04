import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { StorageBackendProvider } from '../../storage/enums/storage-backend-provider.enum';

// MVP: only 'single' profile to Scaleway is supported. 'mirrored' will be
// reintroduced once a second backup destination is GA.
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
