import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { AppOwnershipGuard } from '../guards/app-ownership.guard';
import { RequirePermission } from '../../iam/decorators/require-permission.decorator';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import { CacheQueryService } from '../services/cache-query.service';
import { CacheEntry, CacheServerInfo } from '../engine/cache-engine';
import { CacheConnectionInfo } from '../interfaces/cache-connection';
import {
  CacheDeleteDto,
  CacheFlushDto,
  CacheKeyDto,
  CacheSetDto,
} from '../dto/cache-console.dto';

/**
 * Cache console (Memcached): server stats + exact-key get/set/delete and flush.
 * Memcached cannot enumerate keys, so there is no listing — you fetch by exact
 * key. Writes honour the request's read-only flag. Keys may contain characters
 * unsafe in a path, so reads/deletes take the key in the body.
 */
@UseGuards(AppOwnershipGuard)
@Controller('applications/:id/cache')
export class CacheConsoleController {
  constructor(private readonly cache: CacheQueryService) {}

  @Get('connection-info')
  connectionInfo(
    @Param('id') id: string,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<CacheConnectionInfo> {
    return this.cache.connectionInfo({
      appId: id,
      fluiUserId: req.user.userId,
    });
  }

  @Get('server-info')
  serverInfo(
    @Param('id') id: string,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<CacheServerInfo> {
    return this.cache.serverInfo({ appId: id, fluiUserId: req.user.userId });
  }

  @Post('get')
  get(
    @Param('id') id: string,
    @Body() dto: CacheKeyDto,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<{ found: boolean; entry: CacheEntry | null }> {
    return this.cache
      .get({ appId: id, fluiUserId: req.user.userId }, dto.key)
      .then((entry) => ({ found: entry !== null, entry }));
  }

  @Post('set')
  set(
    @Param('id') id: string,
    @Body() dto: CacheSetDto,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<{ ok: true }> {
    return this.cache
      .set(
        { appId: id, fluiUserId: req.user.userId },
        {
          key: dto.key,
          value: dto.value,
          ttlSeconds: dto.ttlSeconds,
          flags: dto.flags,
        },
        { readOnly: dto.readOnly !== false },
      )
      .then(() => ({ ok: true as const }));
  }

  @Post('delete')
  @RequirePermission(IAM_PERMISSION.APP_WRITE)
  delete(
    @Param('id') id: string,
    @Body() dto: CacheDeleteDto,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<{ deleted: boolean }> {
    return this.cache
      .delete({ appId: id, fluiUserId: req.user.userId }, dto.key, {
        readOnly: dto.readOnly !== false,
      })
      .then((deleted) => ({ deleted }));
  }

  @Post('flush')
  @RequirePermission(IAM_PERMISSION.APP_WRITE)
  flush(
    @Param('id') id: string,
    @Body() dto: CacheFlushDto,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<{ ok: true }> {
    return this.cache
      .flush(
        { appId: id, fluiUserId: req.user.userId },
        { readOnly: dto.readOnly !== false },
      )
      .then(() => ({ ok: true as const }));
  }
}
