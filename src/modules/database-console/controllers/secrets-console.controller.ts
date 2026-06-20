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
import { SecretsQueryService } from '../services/secrets-query.service';
import {
  SecretListEntry,
  SecretRead,
  SecretsServerInfo,
} from '../engine/secrets-engine';
import { SecretsConnectionInfo } from '../interfaces/secrets-connection';
import {
  SecretsDeleteDto,
  SecretsListDto,
  SecretsReadDto,
  SecretsUndeleteDto,
  SecretsWriteDto,
} from '../dto/secrets-console.dto';

/**
 * Secrets console (OpenBao KV v2): browse the path tree, read versioned secrets,
 * write, and soft-delete/destroy. Writes honour the request's read-only flag.
 * Paths may contain slashes, so they travel in the body, not the URL.
 */
@UseGuards(AppOwnershipGuard)
@Controller('applications/:id/secrets')
export class SecretsConsoleController {
  constructor(private readonly secrets: SecretsQueryService) {}

  @Get('connection-info')
  connectionInfo(
    @Param('id') id: string,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<SecretsConnectionInfo> {
    return this.secrets.connectionInfo({
      appId: id,
      fluiUserId: req.user.userId,
    });
  }

  @Get('server-info')
  serverInfo(
    @Param('id') id: string,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<SecretsServerInfo> {
    return this.secrets.serverInfo({ appId: id, fluiUserId: req.user.userId });
  }

  @Post('list')
  list(
    @Param('id') id: string,
    @Body() dto: SecretsListDto,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<SecretListEntry[]> {
    return this.secrets.list(
      { appId: id, fluiUserId: req.user.userId },
      dto.prefix ?? '',
    );
  }

  @Post('read')
  read(
    @Param('id') id: string,
    @Body() dto: SecretsReadDto,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<{ found: boolean; secret: SecretRead | null }> {
    return this.secrets
      .read({ appId: id, fluiUserId: req.user.userId }, dto.path, dto.version)
      .then((secret) => ({ found: secret !== null, secret }));
  }

  @Post('write')
  write(
    @Param('id') id: string,
    @Body() dto: SecretsWriteDto,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<{ version: number }> {
    return this.secrets.write(
      { appId: id, fluiUserId: req.user.userId },
      dto.path,
      dto.data,
      { readOnly: dto.readOnly !== false },
    );
  }

  @Post('undelete')
  undelete(
    @Param('id') id: string,
    @Body() dto: SecretsUndeleteDto,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<{ ok: true }> {
    return this.secrets
      .undelete(
        { appId: id, fluiUserId: req.user.userId },
        dto.path,
        dto.version,
        {
          readOnly: dto.readOnly !== false,
        },
      )
      .then(() => ({ ok: true as const }));
  }

  @Post('delete')
  delete(
    @Param('id') id: string,
    @Body() dto: SecretsDeleteDto,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<{ ok: true }> {
    return this.secrets
      .remove({ appId: id, fluiUserId: req.user.userId }, dto.path, {
        readOnly: dto.readOnly !== false,
        destroy: dto.destroy === true,
      })
      .then(() => ({ ok: true as const }));
  }
}
