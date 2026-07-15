#!/usr/bin/env node
/**
 * Background Worker for Cluster Operations
 *
 * This script runs as a detached background process to execute
 * long-running cluster operations asynchronously.
 *
 * Usage:
 *   node cluster-worker.js create-cluster '{"clusterId":"...","operationId":"..."}'
 */

import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { CliModule } from '../cli.module';
import { CliClusterCreatorService } from '../services/cli-cluster-creator.service';
import { CliClusterRepository } from '../lib/repositories/cli-cluster.repository';
import { CliOperationRepository } from '../lib/repositories/cli-operation.repository';
import { CliLoggerService } from '../services/cli-logger.service';

const logger = new Logger('ClusterWorker');

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.error('Usage: cluster-worker <jobType> <jobDataJson>');
    process.exit(1);
  }

  const jobType = args[0];
  const jobDataJson = args[1];

  logger.log(`Starting background worker: ${jobType}`);

  // Bootstrap NestJS application context
  const app = await NestFactory.createApplicationContext(CliModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const jobData = JSON.parse(jobDataJson);

    if (jobType === 'create-cluster') {
      await handleCreateCluster(app, jobData);
    } else if (jobType === 'delete-cluster') {
      await handleDeleteCluster(app, jobData);
    } else if (jobType === 'reinstall-cluster') {
      await handleReinstallCluster(app, jobData);
    } else {
      throw new Error(`Unknown job type: ${jobType}`);
    }

    logger.log(`Background worker completed successfully: ${jobType}`);
    process.exit(0);
  } catch (error) {
    logger.error(`Background worker failed: ${error.message}`, error.stack);
    process.exit(1);
  } finally {
    await app.close();
  }
}

async function handleCreateCluster(app: any, jobData: any) {
  const { clusterId, operationId } = jobData;

  logger.log(`Creating cluster ${clusterId} (operation ${operationId})`);

  const clusterRepo = app.get(CliClusterRepository);
  const operationRepo = app.get(CliOperationRepository);
  const creatorService = app.get(CliClusterCreatorService);
  const loggerService = app.get(CliLoggerService);

  // Load cluster and operation from file storage
  const cluster = await clusterRepo.findOne({ where: { id: clusterId } });
  const operation = await operationRepo.findOne({ where: { id: operationId } });

  if (!cluster) {
    throw new Error(`Cluster ${clusterId} not found`);
  }

  if (!operation) {
    throw new Error(`Operation ${operationId} not found`);
  }

  loggerService.writeLog(
    operationId,
    `Background worker started for cluster ${cluster.name}`,
    'INFO',
  );

  try {
    // Execute cluster creation synchronously (within this background process)
    await creatorService.createClusterSync(cluster, operation);

    loggerService.writeLog(
      operationId,
      `Cluster ${cluster.name} created successfully`,
      'INFO',
    );
  } catch (error) {
    loggerService.writeLog(
      operationId,
      `Cluster creation failed: ${error.message}`,
      'ERROR',
    );
    throw error;
  }
}

async function handleReinstallCluster(app: any, jobData: any) {
  const { clusterId, operationId } = jobData;

  logger.log(`Reinstalling cluster ${clusterId} (operation ${operationId})`);

  const clusterRepo = app.get(CliClusterRepository);
  const operationRepo = app.get(CliOperationRepository);
  const creatorService = app.get(CliClusterCreatorService);
  const loggerService = app.get(CliLoggerService);

  const cluster = await clusterRepo.findOne({ where: { id: clusterId } });
  const operation = await operationRepo.findOne({ where: { id: operationId } });

  if (!cluster) {
    throw new Error(`Cluster ${clusterId} not found`);
  }

  if (!operation) {
    throw new Error(`Operation ${operationId} not found`);
  }

  loggerService.writeLog(
    operationId,
    `Background worker started for reinstall of cluster ${cluster.name}`,
    'INFO',
  );

  try {
    await creatorService.reinstallControlCluster(cluster, operation);

    loggerService.writeLog(
      operationId,
      `Cluster ${cluster.name} reinstalled successfully`,
      'INFO',
    );
  } catch (error) {
    loggerService.writeLog(
      operationId,
      `Cluster reinstall failed: ${error.message}`,
      'ERROR',
    );
    throw error;
  }
}

async function handleDeleteCluster(app: any, jobData: any) {
  const { clusterId } = jobData;

  logger.log(`Deleting cluster ${clusterId}`);

  // TODO: Implement background cluster deletion if needed
  throw new Error('Background cluster deletion not yet implemented');
}

// Run main function
main();
