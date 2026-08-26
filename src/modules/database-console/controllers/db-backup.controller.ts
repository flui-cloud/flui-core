import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  Request,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  Request as ExpressRequest,
  Response as ExpressResponse,
} from 'express';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { AppOwnershipGuard } from '../guards/app-ownership.guard';
import { PlatformFoundationGuard } from '../guards/platform-foundation.guard';
import { DbBackupInfo, DbBackupService } from '../services/db-backup.service';

/**
 * Logical DB backup/restore (pg_dump/mariadb-dump). `info` reports whether the engine is
 * supported + a filename; `dump` streams a plain-SQL dump; `restore` streams an uploaded dump
 * into the database (destructive — requires ?confirm=true, plus the client's own confirmation).
 */
@UseGuards(PlatformFoundationGuard, AppOwnershipGuard)
@Controller('applications/:id/db-backup')
export class DbBackupController {
  constructor(private readonly backup: DbBackupService) {}

  @Get('info')
  info(
    @Param('id') id: string,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<DbBackupInfo> {
    return this.backup.info({ dbInstallId: id, fluiUserId: req.user.userId });
  }

  @Get('dump')
  async dump(
    @Param('id') id: string,
    @Query('destinationId') destinationId: string | undefined,
    @Request() req: { user: AuthenticatedUser },
    @Res() res: ExpressResponse,
  ): Promise<void> {
    const input = { dbInstallId: id, fluiUserId: req.user.userId };
    const info = await this.backup.info(input);
    if (!info.supported) {
      res
        .status(400)
        .json({ message: info.reason ?? 'Logical backup not supported.' });
      return;
    }
    // Destination → store the dump in S3 (engine-agnostic) and return the object ref as JSON.
    if (destinationId) {
      const result = await this.backup.dumpToDestination(input, destinationId);
      res.status(201).json(result);
      return;
    }
    // No destination → stream the dump to the caller for download.
    res.setHeader(
      'Content-Type',
      info.format === 'rdb'
        ? 'application/octet-stream'
        : 'application/sql; charset=utf-8',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${info.suggestedFilename}"`,
    );
    try {
      await this.backup.dump(input, res);
      res.end();
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Dump failed.';
      if (res.headersSent) {
        res.destroy();
      } else {
        res.status(500).json({ message });
      }
    }
  }

  @Post('restore')
  async restore(
    @Param('id') id: string,
    @Query('confirm') confirm: string | undefined,
    @Req() req: ExpressRequest & { user: AuthenticatedUser },
  ): Promise<{ ok: true }> {
    if (confirm !== 'true') {
      throw new BadRequestException(
        'Restore overwrites the database — pass ?confirm=true to proceed.',
      );
    }
    await this.backup.restore(
      { dbInstallId: id, fluiUserId: req.user.userId },
      req,
    );
    return { ok: true };
  }
}
