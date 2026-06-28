import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { getRepositoryToken } from '../lib/typeorm-shim';
import { spawn } from 'node:child_process';
import * as path from 'node:path';

// CLI repositories
import {
  CliClusterRepository,
  CliNodeRepository,
  CliOperationRepository,
  CliFirewallRepository,
} from '../lib/repositories';
// Entities
import { ClusterEntity } from 'src/modules/infrastructure/clusters/entities/cluster.entity';
import { ClusterNodeEntity } from 'src/modules/infrastructure/clusters/entities/cluster-node.entity';
import { InfrastructureOperationEntity } from 'src/modules/infrastructure/servers/entities/infrastructure-operations.entity';

// Services
import { EncryptionModule } from 'src/modules/shared/encryption/encryption.module';
import { KubernetesService } from 'src/modules/infrastructure/shared/services/kubernetes.service';
import { LabelService } from 'src/modules/infrastructure/shared/services/label.service';
import { CliK3sScriptService } from '../services/cli-k3s-script.service';
import { CliClusterCreatorService } from '../services/cli-cluster-creator.service';
import { CliClustersService } from '../services/cli-clusters.service';
import { CliControlClusterService } from '../services/cli-control-cluster.service';
import { CliSshService } from '../services/cli-ssh.service';
import { CliByosPurgeService } from '../services/cli-byos-purge.service';
import { CliCaService } from '../services/cli-ca.service';
import { CliLoggerService } from '../services/cli-logger.service';
import { CliEndpointResolverService } from '../services/cli-endpoint-resolver.service';
import { ClusterStorageService } from 'src/modules/infrastructure/clusters/services/cluster-storage.service';
import { ClusterCapacityService } from 'src/modules/infrastructure/clusters/services/cluster-capacity.service';
import { ClusterNodeScalingService } from 'src/modules/infrastructure/clusters/services/cluster-node-scaling.service';
import { BillingIntervalsService } from 'src/modules/infrastructure/clusters/services/billing-intervals.service';
import { NodeBillableIntervalEntity } from 'src/modules/infrastructure/clusters/entities/node-billable-interval.entity';
import { VolumeBillableIntervalEntity } from 'src/modules/infrastructure/clusters/entities/volume-billable-interval.entity';
import { ApplicationEntity } from 'src/modules/applications/entities/application.entity';
import { NativeSSHConnectionService } from 'src/modules/terminal/services/native-ssh-connection.service';
import { AccessService } from 'src/modules/access/services/access.service';
// Modules
import { CliProvidersModule } from '../cli-providers.module';
import { CommonModule } from 'src/modules/common/common.module';

/**
 * CLI Infrastructure Module
 *
 * Provides infrastructure services for CLI commands without requiring database or Redis.
 * Uses file-based repositories that persist data to ~/.flui/*.json files.
 *
 * Key differences from InfrastructureModule:
 * - NO TypeORM database connection required
 * - NO Bull/Redis queue required
 * - File-based persistence in ~/.flui/
 * - Synchronous cluster operations (no background jobs)
 */
@Module({
  imports: [ConfigModule, CliProvidersModule, CommonModule, EncryptionModule],
  providers: [
    // File-based repositories
    CliClusterRepository,
    CliNodeRepository,
    CliOperationRepository,
    CliFirewallRepository,

    // Provide CLI repositories as TypeORM repository tokens
    // This allows ClustersService to inject them without knowing they're file-based
    {
      provide: getRepositoryToken(ClusterEntity),
      useExisting: CliClusterRepository,
    },
    {
      provide: getRepositoryToken(ClusterNodeEntity),
      useExisting: CliNodeRepository,
    },
    {
      provide: getRepositoryToken(InfrastructureOperationEntity),
      useExisting: CliOperationRepository,
    },

    // CLI mode: BillingIntervalsService is unused at runtime (CLI doesn't track
    // node intervals — that's done by the in-cluster API at the master). Stub
    // the two interval repos so the service can be constructed and methods are
    // safe no-ops if accidentally called.
    {
      provide: getRepositoryToken(NodeBillableIntervalEntity),
      useValue: {
        find: async () => [],
        findOne: async () => null,
        save: async (e: any) => e,
        update: async () => undefined,
        create: (data: any) => data,
      },
    },
    {
      provide: getRepositoryToken(VolumeBillableIntervalEntity),
      useValue: {
        find: async () => [],
        findOne: async () => null,
        save: async (e: any) => e,
        update: async () => undefined,
        create: (data: any) => data,
      },
    },
    BillingIntervalsService,

    // CLI-specific services
    CliK3sScriptService,
    CliClusterCreatorService,

    // Provide a Bull Queue that executes operations asynchronously via background worker
    // Instead of queuing to Bull/Redis, we spawn a detached background process
    {
      provide: 'BullQueue_infrastructure',
      useFactory: () => ({
        add: async (jobName: string, jobData: any) => {
          console.log(`[CLI Mode] Spawning background job: ${jobName}`);

          // Determine the path to the compiled worker script
          // In development: cli/lib/cli/src/background/cluster-worker.js
          // The worker will be compiled by TypeScript to the lib directory
          const workerScript = path.join(
            __dirname,
            '../background/cluster-worker.js',
          );

          // Spawn background worker as detached process
          const child = spawn(
            process.execPath, // Use same Node.js executable
            [workerScript, jobName, JSON.stringify(jobData)],
            {
              detached: true, // Run independently of parent
              cwd: process.cwd(), // Use current working directory
              windowsHide: true, // Prevent console window flash on Windows
              stdio: 'ignore', // Fully detach stdio to prevent Windows console popup
            },
          );

          // Detach from parent so CLI can exit immediately
          child.unref();

          console.log(`[CLI Mode] Background job spawned (PID: ${child.pid})`);
          console.log(`[CLI Mode] Job will continue running in background`);

          // Return immediately with a job ID
          return { id: `cli-bg-${Date.now()}-${child.pid}` };
        },
      }),
      inject: [],
    },

    // Infrastructure services
    LabelService,
    KubernetesService,
    CliClustersService,
    CliControlClusterService,
    CliSshService,
    CliByosPurgeService,
    CliCaService,
    CliLoggerService,
    CliEndpointResolverService,
    ClusterStorageService,
    ClusterCapacityService,
    // Stubs for CLI mode (no apps DB, no SSH-cert key registry).
    // ClusterNodeScalingService.scaleNode does not touch ApplicationEntity/SSH at all,
    // so these stubs only matter for expandSharedVolume which is not validatable in CLI mode.
    {
      provide: getRepositoryToken(ApplicationEntity),
      useValue: (() => {
        const emptyQueryBuilder = {
          where: () => emptyQueryBuilder,
          andWhere: () => emptyQueryBuilder,
          getMany: async () => [],
        };
        return {
          find: async () => [],
          findOne: async () => null,
          createQueryBuilder: () => emptyQueryBuilder,
        };
      })(),
    },
    NativeSSHConnectionService,
    {
      // CLI-mode AccessService stub: pulls the bootstrap private key from
      // ~/.flui/bootstrap-keys/<keyId> (where the CLI stored it at cluster
      // creation time). Avoids depending on the full AccessService which
      // expects a DB-backed key registry.
      provide: AccessService,
      useFactory: () => {
        const fs = require('node:fs/promises');
        const path = require('node:path');
        const os = require('node:os');
        return {
          getPrivateKey: async (_user: string, keyId: string) => {
            const candidates = [
              path.join(os.homedir(), '.flui', 'bootstrap-keys', keyId),
              path.join(
                os.homedir(),
                '.flui',
                'bootstrap-keys',
                `${keyId}.pem`,
              ),
              path.join(
                os.homedir(),
                '.flui',
                'bootstrap-keys',
                `${keyId}.key`,
              ),
            ];
            for (const p of candidates) {
              try {
                return await fs.readFile(p, 'utf8');
              } catch {
                /* try next */
              }
            }
            throw new Error(
              `Bootstrap key ${keyId} not found under ~/.flui/bootstrap-keys/`,
            );
          },
        };
      },
    },
    ClusterNodeScalingService,
  ],
  exports: [
    CliControlClusterService,
    CliClustersService,
    KubernetesService,
    LabelService,
    CliSshService,
    CliByosPurgeService,
    CliCaService,
    CliLoggerService,
    CliEndpointResolverService,
    ClusterStorageService,
    ClusterCapacityService,
    ClusterNodeScalingService,
  ],
})
export class CliInfrastructureModule {}
