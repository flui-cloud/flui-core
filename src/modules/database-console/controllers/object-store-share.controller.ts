import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import { Response as ExpressResponse } from 'express';
import { Public } from '../../auth/decorators/public.decorator';
import { ObjectStoreQueryService } from '../services/object-store-query.service';
import { ObjectStoreShareService } from '../services/object-store-share.service';
import { ObjectStoreShareRegistryService } from '../services/object-store-share-registry.service';

/** Filename for the download dialog — the last path segment of the key. */
function fileNameOf(key: string): string {
  const seg = key.split('/').filter(Boolean).at(-1) ?? 'download';
  return seg.replaceAll('"', '');
}

/**
 * Public proxy for share links. The token is self-contained and HMAC-signed
 * (see ObjectStoreShareService): no Flui session is needed to open it. The
 * object is streamed from the cluster-internal store through the backend — the
 * store is never exposed, the secret key never leaves the cluster.
 */
@Controller('object-store')
export class ObjectStoreShareController {
  constructor(
    private readonly store: ObjectStoreQueryService,
    private readonly share: ObjectStoreShareService,
    private readonly shareRegistry: ObjectStoreShareRegistryService,
  ) {}

  @Public()
  @Get('share/:token')
  async open(
    @Param('token') token: string,
    @Query('download') download: string | undefined,
    @Res() res: ExpressResponse,
  ): Promise<void> {
    const claims = this.share.verify(token, Math.floor(Date.now() / 1000));
    // Enforce revocation + stamp last-accessed (no-op for untracked links).
    await this.shareRegistry.checkAndTouch(token);
    const { body, dispose } = await this.store.openObjectStream(
      { appId: claims.appId, fluiUserId: 'share-link' },
      claims.bucket,
      claims.key,
    );
    res.setHeader(
      'Content-Type',
      body.contentType ?? 'application/octet-stream',
    );
    if (body.contentLength !== undefined) {
      res.setHeader('Content-Length', String(body.contentLength));
    }
    // Inline by default (preview images/PDFs in the browser); ?download=1 forces save.
    const disposition = download ? 'attachment' : 'inline';
    res.setHeader(
      'Content-Disposition',
      `${disposition}; filename="${fileNameOf(claims.key)}"`,
    );
    res.on('close', () => {
      void dispose();
    });
    body.stream.on('error', () => res.destroy());
    body.stream.pipe(res);
  }
}
