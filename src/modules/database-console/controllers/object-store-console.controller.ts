import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Req,
  Res,
  Request,
  UseGuards,
} from '@nestjs/common';
import {
  Request as ExpressRequest,
  Response as ExpressResponse,
} from 'express';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { ObjectStoreQueryService } from '../services/object-store-query.service';
import { ObjectStoreShareService } from '../services/object-store-share.service';
import {
  ObjectStoreShareRegistryService,
  ShareRecord,
} from '../services/object-store-share-registry.service';
import {
  OsCreateBucketDto,
  OsDeleteDto,
  OsListObjectsDto,
  OsObjectRefDto,
  OsSetBucketPolicyDto,
  OsShareDto,
} from '../dto/object-store-console.dto';
import {
  BucketPolicy,
  S3Bucket,
  S3Listing,
  S3ObjectMeta,
} from '../engine/object-store-engine';
import { ObjectStoreConnectionInfo } from '../interfaces/object-store-connection';
import { AppOwnershipGuard } from '../guards/app-ownership.guard';
import { RequirePermission } from '../../iam/decorators/require-permission.decorator';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';

/** Filename for the download dialog — the last path segment of the key. */
function fileNameOf(key: string): string {
  const seg = key.split('/').filter(Boolean).at(-1) ?? 'download';
  return seg.replaceAll('"', '');
}

/**
 * Object-storage console (Garage / S3-wire). Browse buckets + objects, upload,
 * download, delete, and mint share links. All object I/O is proxied through the
 * backend over an ephemeral tunnel — the store stays cluster-internal.
 */
@UseGuards(AppOwnershipGuard)
@Controller('applications/:id/object-store')
export class ObjectStoreConsoleController {
  constructor(
    private readonly store: ObjectStoreQueryService,
    private readonly share: ObjectStoreShareService,
    private readonly shareRegistry: ObjectStoreShareRegistryService,
  ) {}

  @Get('connection-info')
  connectionInfo(
    @Param('id') id: string,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<ObjectStoreConnectionInfo> {
    return this.store.connectionInfo({
      appId: id,
      fluiUserId: req.user.userId,
    });
  }

  @Get('buckets')
  buckets(
    @Param('id') id: string,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<S3Bucket[]> {
    return this.store.listBuckets({ appId: id, fluiUserId: req.user.userId });
  }

  @Post('buckets')
  async createBucket(
    @Param('id') id: string,
    @Body() dto: OsCreateBucketDto,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<{ ok: true }> {
    await this.store.createBucket(
      { appId: id, fluiUserId: req.user.userId },
      dto.bucket,
      { readOnly: dto.readOnly !== false },
    );
    return { ok: true };
  }

  @Delete('buckets/:bucket')
  @RequirePermission(IAM_PERMISSION.APP_WRITE)
  async deleteBucket(
    @Param('id') id: string,
    @Param('bucket') bucket: string,
    @Query('readOnly') readOnly: string | undefined,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<{ ok: true }> {
    await this.store.deleteBucket(
      { appId: id, fluiUserId: req.user.userId },
      bucket,
      { readOnly: readOnly !== 'false' },
    );
    return { ok: true };
  }

  @Get('buckets/:bucket/policy')
  bucketPolicy(
    @Param('id') id: string,
    @Param('bucket') bucket: string,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<BucketPolicy> {
    return this.store.getBucketPolicy(
      { appId: id, fluiUserId: req.user.userId },
      bucket,
    );
  }

  @Post('buckets/policy')
  setBucketPolicy(
    @Param('id') id: string,
    @Body() dto: OsSetBucketPolicyDto,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<BucketPolicy> {
    return this.store.setBucketPolicy(
      { appId: id, fluiUserId: req.user.userId },
      dto.bucket,
      dto.public,
      { readOnly: dto.readOnly !== false },
    );
  }

  @Post('objects')
  listObjects(
    @Param('id') id: string,
    @Body() dto: OsListObjectsDto,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<S3Listing> {
    return this.store.listObjects(
      { appId: id, fluiUserId: req.user.userId },
      dto.bucket,
      {
        prefix: dto.prefix,
        delimiter: dto.delimiter,
        continuationToken: dto.continuationToken,
        maxKeys: dto.maxKeys,
      },
    );
  }

  @Post('object/head')
  head(
    @Param('id') id: string,
    @Body() dto: OsObjectRefDto,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<S3ObjectMeta> {
    return this.store.headObject(
      { appId: id, fluiUserId: req.user.userId },
      dto.bucket,
      dto.key,
    );
  }

  @Post('delete')
  @RequirePermission(IAM_PERMISSION.APP_WRITE)
  async delete(
    @Param('id') id: string,
    @Body() dto: OsDeleteDto,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<{ ok: true; deleted: number }> {
    const input = { appId: id, fluiUserId: req.user.userId };
    const opts = { readOnly: dto.readOnly !== false };
    if (dto.key) {
      await this.store.deleteObject(input, dto.bucket, dto.key, opts);
      return { ok: true, deleted: 1 };
    }
    if (dto.prefix) {
      const deleted = await this.store.deletePrefix(
        input,
        dto.bucket,
        dto.prefix,
        opts,
      );
      return { ok: true, deleted };
    }
    throw new BadRequestException('Provide either `key` or `prefix` to delete');
  }

  /** Upload one object. Raw binary body streamed straight to the store. */
  @Post('upload')
  async upload(
    @Param('id') id: string,
    @Query('bucket') bucket: string,
    @Query('key') key: string,
    @Query('readOnly') readOnly: string | undefined,
    @Req() req: ExpressRequest & { user: AuthenticatedUser },
  ): Promise<{ ok: true; key: string }> {
    if (!bucket || !key) {
      throw new BadRequestException('bucket and key query params are required');
    }
    const lenHeader = req.headers['content-length'];
    const contentLength = lenHeader ? Number(lenHeader) : undefined;
    await this.store.putObject(
      { appId: id, fluiUserId: req.user.userId },
      bucket,
      key,
      req,
      {
        readOnly: readOnly !== 'false',
        contentType:
          (req.headers['content-type'] as string | undefined) ??
          'application/octet-stream',
        contentLength,
      },
    );
    return { ok: true, key };
  }

  /** Stream an object back to the browser as an attachment. */
  @Post('download')
  async download(
    @Param('id') id: string,
    @Body() dto: OsObjectRefDto,
    @Req() req: { user: AuthenticatedUser },
    @Res() res: ExpressResponse,
  ): Promise<void> {
    const { body, dispose } = await this.store.openObjectStream(
      { appId: id, fluiUserId: req.user.userId },
      dto.bucket,
      dto.key,
    );
    // Guard the synchronous setup: if a header value throws before the close
    // handler is wired, dispose() must still run or the tunnel lease leaks.
    try {
      res.setHeader(
        'Content-Type',
        body.contentType ?? 'application/octet-stream',
      );
      if (body.contentLength !== undefined) {
        res.setHeader('Content-Length', String(body.contentLength));
      }
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${fileNameOf(dto.key)}"`,
      );
      const cleanup = (): void => {
        void dispose();
      };
      res.on('close', cleanup);
      body.stream.on('error', () => res.destroy());
      body.stream.pipe(res);
    } catch (err) {
      await dispose();
      throw err;
    }
  }

  /** Mint a time-limited share link that needs no Flui session to open. */
  @Post('share')
  async share_(
    @Param('id') id: string,
    @Body() dto: OsShareDto,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<{ token: string; path: string; expiresAt: string }> {
    const nowSec = Math.floor(Date.now() / 1000);
    const { token, expiresAt } = this.share.sign(
      { appId: id, bucket: dto.bucket, key: dto.key },
      dto.ttlSeconds ?? 3600,
      nowSec,
    );
    // Register the link so it can be listed + revoked (best-effort: a registry
    // failure must not deny the user a working link).
    await this.shareRegistry
      .record(
        token,
        {
          appId: id,
          bucket: dto.bucket,
          key: dto.key,
          exp: Math.floor(new Date(expiresAt).getTime() / 1000),
        },
        req.user.userId,
      )
      .catch(() => undefined);
    return { token, path: `/object-store/share/${token}`, expiresAt };
  }

  /** List share links minted for this app (active, expired and revoked). */
  @Get('shares')
  listShares(
    @Param('id') id: string,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<ShareRecord[]> {
    return this.shareRegistry.list(id, req.user.userId);
  }

  /** Revoke a share link immediately (kills it before its expiry). */
  @Post('shares/:shareId/revoke')
  @RequirePermission(IAM_PERMISSION.APP_WRITE)
  revokeShare(
    @Param('id') id: string,
    @Param('shareId') shareId: string,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<ShareRecord> {
    return this.shareRegistry.revoke(shareId, id, req.user.userId);
  }
}
