import {
  Injectable,
  InternalServerErrorException,
  Logger,
  NotImplementedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { IIdentityBranding } from '../../auth/interfaces/identity-branding.interface';
import {
  ClusterEntity,
  ClusterType,
} from '../../infrastructure/clusters/entities/cluster.entity';
import {
  BrandingAssetKind,
  OidcProviderAdminClient,
} from './oidc-provider-admin.service';
import { buildSystemNipHostname } from '../../dns/utils/nip-hostname.util';

const VERSION_KEY = 'flui-branding-version';
const ASSET_FILES: Array<{ kind: BrandingAssetKind; fileName: string }> = [
  { kind: 'logo-light', fileName: 'logo-light.png' },
  { kind: 'logo-dark', fileName: 'logo-dark.png' },
  { kind: 'icon-light', fileName: 'icon-light.png' },
  { kind: 'icon-dark', fileName: 'icon-dark.png' },
];

interface BrandingAsset {
  kind: BrandingAssetKind;
  fileName: string;
  bytes: Buffer;
  contentType: string;
}

@Injectable()
export class OidcIdentityBranding implements IIdentityBranding {
  private readonly logger = new Logger(OidcIdentityBranding.name);

  constructor(
    private readonly oidcProvider: OidcProviderAdminClient,
    private readonly config: ConfigService,
    @InjectRepository(ClusterEntity)
    private readonly clusterRepo: Repository<ClusterEntity>,
  ) {}

  async ensureBranding(
    force = false,
    overrides?: { pat?: string; hostHeader?: string },
  ): Promise<boolean> {
    const { pat, hostHeader } =
      overrides?.pat && overrides?.hostHeader
        ? { pat: overrides.pat, hostHeader: overrides.hostHeader }
        : await this.connection();
    const colors = this.colors();
    const present = this.readAssets();

    const version = this.computeVersion(present, colors);

    if (!force) {
      const stored = await this.oidcProvider.getOrgMetadata(
        pat,
        hostHeader,
        VERSION_KEY,
      );
      if (stored && stored === version) {
        this.logger.log(
          `Branding version unchanged (${version}) — skipping upload`,
        );
        return false;
      }
    }

    // The provider refuses an asset (404 Org.LabelPolicy.NotFound) until the organisation has a custom label policy.
    const steps: Array<[string, () => Promise<void>]> = [
      [
        'label policy',
        () =>
          this.oidcProvider.upsertCustomLabelPolicy(pat, hostHeader, colors),
      ],
      ...present.map((asset): [string, () => Promise<void>] => [
        asset.kind,
        () =>
          this.oidcProvider.uploadBrandingAsset(
            pat,
            hostHeader,
            asset.kind,
            asset.bytes,
            asset.fileName,
            asset.contentType,
          ),
      ]),
      [
        'policy activation',
        () => this.oidcProvider.activateLabelPolicy(pat, hostHeader),
      ],
    ];
    const failed = await this.runSteps(steps);

    if (failed.length) {
      this.logger.warn(
        `Branding incomplete (${failed.join(', ')}); version not recorded, the next pass retries`,
      );
      return false;
    }

    try {
      await this.oidcProvider.setOrgMetadata(
        pat,
        hostHeader,
        VERSION_KEY,
        version,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to persist branding version: ${message}`);
    }

    this.logger.log(
      `Branding applied: version=${version}, assets=${present.length}/${ASSET_FILES.length}`,
    );
    return true;
  }

  private readAssets(): BrandingAsset[] {
    const dir = this.assetDir();
    const present: BrandingAsset[] = [];
    for (const a of ASSET_FILES) {
      const full = path.join(dir, a.fileName);
      if (!fs.existsSync(full)) {
        this.logger.warn(`Branding asset missing: ${full} — skipping`);
        continue;
      }
      present.push({
        kind: a.kind,
        fileName: a.fileName,
        bytes: fs.readFileSync(full),
        contentType: 'image/png',
      });
    }
    return present;
  }

  private async runSteps(
    steps: Array<[string, () => Promise<void>]>,
  ): Promise<string[]> {
    const failed: string[] = [];
    for (const [name, run] of steps) {
      try {
        await run();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`Branding step "${name}" failed: ${message}`);
        failed.push(name);
        if (name === 'label policy') break;
      }
    }
    return failed;
  }

  private assetDir(): string {
    return (
      this.config.get<string>('FLUI_BRANDING_ASSET_DIR') ||
      path.resolve(process.cwd(), 'src/assets/branding')
    );
  }

  private colors() {
    const color = (key: string, fallback: string) =>
      this.config.get<string>(key) || fallback;
    return {
      primaryColor: color('FLUI_BRANDING_PRIMARY_COLOR', '#225AF1'),
      primaryColorDark: color('FLUI_BRANDING_PRIMARY_COLOR_DARK', '#3369FF'),
      backgroundColor: color('FLUI_BRANDING_BG_COLOR', '#F6F7F9'),
      backgroundColorDark: color('FLUI_BRANDING_BG_COLOR_DARK', '#080B11'),
      warnColor: color('FLUI_BRANDING_WARN_COLOR', '#DC2828'),
      warnColorDark: color('FLUI_BRANDING_WARN_COLOR_DARK', '#F04242'),
      fontColor: color('FLUI_BRANDING_FONT_COLOR', '#191B1F'),
      fontColorDark: color('FLUI_BRANDING_FONT_COLOR_DARK', '#E5E9F0'),
      hideLoginNameSuffix: true,
      disableWatermark: true,
    };
  }

  private computeVersion(
    assets: Array<{ kind: BrandingAssetKind; bytes: Buffer }>,
    colors: Record<string, unknown>,
  ): string {
    const hash = crypto.createHash('sha256');
    for (const a of assets) {
      hash.update(a.kind);
      hash.update(a.bytes);
    }
    hash.update(JSON.stringify(colors));
    return hash.digest('hex').slice(0, 16);
  }

  private async connection(): Promise<{ pat: string; hostHeader: string }> {
    const pat = process.env.ZITADEL_SERVICE_ACCOUNT_PAT;
    if (!pat) {
      throw new NotImplementedException(
        'OIDC provider PAT not available — bootstrap may not have completed',
      );
    }
    const issuerHost = (
      process.env.OIDC_ISSUER ||
      process.env.ZITADEL_ISSUER ||
      ''
    )
      .replace(/^https?:\/\//, '')
      .split('/')[0];
    if (issuerHost) return { pat, hostHeader: issuerHost };
    const cluster = await this.clusterRepo.findOne({
      where: {
        clusterType: In([ClusterType.CONTROL, ClusterType.OBSERVABILITY]),
      },
    });
    if (!cluster?.masterIpAddress) {
      throw new InternalServerErrorException(
        'Control cluster master IP unknown — cannot reach OIDC provider',
      );
    }
    return {
      pat,
      hostHeader: buildSystemNipHostname(
        'auth',
        cluster.masterIpAddress,
        cluster.nipHostnameToken,
      ),
    };
  }
}
