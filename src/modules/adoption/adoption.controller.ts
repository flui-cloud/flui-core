import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  ConflictException,
  NotFoundException,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { ClusterEntity } from '../infrastructure/clusters/entities/cluster.entity';
import { ClustersService } from '../infrastructure/clusters/clusters.service';
import { ClusterInventoryDto } from '../infrastructure/clusters/dto/cluster-inventory.dto';
import { CAManagerService } from '../access/services/ca-manager.service';
import { AdminGuard } from '../auth/guards/admin.guard';
import { Admin } from '../auth/decorators/admin.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { AdoptionTokenService } from './services/adoption-token.service';
import {
  NodeEnrolmentService,
  type EnrolmentResult,
} from './services/node-enrolment.service';
import { EncryptionService } from '../shared/encryption/services/encryption.service';
import {
  AdoptionTokenGuard,
  type AdoptionRequest,
} from './guards/adoption-token.guard';
import {
  AdoptionTokenResponseDto,
  RegisterAdoptionCaDto,
  RegisterAdoptionCaResponseDto,
} from './dto/adoption.dto';

/**
 * The three calls that turn a cluster nobody can reach into one its owner
 * controls.
 *
 * Every managed installation arrives in the same state: no certificate
 * authority enrolled, the bootstrap key revoked, nothing able to open a shell —
 * including whoever built it. Adoption is how that changes, and it happens in
 * one direction only. The owner generates a certificate authority on their own
 * machine and registers its **public** half here; no private key is ever
 * transmitted, and this installation never had one to give away.
 *
 * Issuing a token requires an authenticated admin — that is, someone who has
 * already logged into the dashboard with the first-access credentials. Spending
 * one requires nothing else, because a cluster in this state has no other way
 * to recognise its owner.
 */
@ApiTags('Adoption')
@Controller('adoption')
export class AdoptionController {
  constructor(
    private readonly tokens: AdoptionTokenService,
    private readonly clustersService: ClustersService,
    private readonly caManager: CAManagerService,
    private readonly configService: ConfigService,
    private readonly enrolment: NodeEnrolmentService,
    private readonly encryption: EncryptionService,
    @InjectRepository(ClusterEntity)
    private readonly clusters: Repository<ClusterEntity>,
  ) {}

  @Post('token')
  @UseGuards(AdminGuard)
  @Admin()
  @ApiBearerAuth()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Issue a one-time adoption token for this installation',
    description:
      'Requires an authenticated admin. The token is shown once, expires in an hour, and can be spent exactly once.',
  })
  @ApiResponse({ status: 201, type: AdoptionTokenResponseDto })
  async issueToken(): Promise<AdoptionTokenResponseDto> {
    const cluster = await this.controlCluster();
    const { token, expiresAt } = this.tokens.issue({
      clusterId: cluster.id,
      endpoint: this.endpoint(),
    });

    return { token, expiresAt: expiresAt.toISOString(), clusterId: cluster.id };
  }

  // Public only to the platform's session guard, which has no session to check:
  // a cluster in this state has no users yet. AdoptionTokenGuard is what
  // actually decides, and it accepts nothing but a valid, unspent token.
  @Get('inventory')
  @Public()
  @UseGuards(AdoptionTokenGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Describe this installation well enough to adopt it',
    description:
      'The map, never the keys: no kubeconfig, no CA material, no provider credentials.',
  })
  @ApiResponse({ status: 200, type: ClusterInventoryDto })
  async inventory(
    @Req() request: AdoptionRequest,
  ): Promise<ClusterInventoryDto> {
    const clusterId = request.adoption!.clusterId;
    const cluster = await this.clustersService.getClusterEntity(clusterId);
    const nodes = await this.clustersService.getClusterNodes(clusterId);
    const metadata = (cluster.metadata ?? {}) as Record<string, unknown>;

    return {
      clusterId: cluster.id,
      name: cluster.name,
      provider: cluster.provider,
      region: cluster.region,
      status: cluster.status,
      endpoint: this.endpoint(),
      version: (metadata['platformVersion'] as string) ?? 'unknown',
      sshCaEnrolled: await this.hasCa(),
      nodes: nodes.map((node) => ({
        id: node.id,
        name: node.serverName,
        type: node.nodeType,
        publicIp: node.ipAddress || null,
        privateIp: node.privateIp || null,
        status: node.status,
      })),
    };
  }

  @Post('ca/register')
  @Public()
  @UseGuards(AdoptionTokenGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: "Trust a certificate authority generated on the owner's machine",
    description:
      'Accepts the public half only. The token is spent by this call and cannot be replayed.',
  })
  @ApiResponse({ status: 201, type: RegisterAdoptionCaResponseDto })
  async registerCa(
    @Req() request: AdoptionRequest,
    @Body() dto: RegisterAdoptionCaDto,
  ): Promise<RegisterAdoptionCaResponseDto> {
    const payload = request.adoption!;

    const ca = await this.registerOrKeep(dto.publicKey, dto.name);

    // Spent only once the registration has actually succeeded. Marking it
    // earlier would burn the owner's single token on a failed call and leave
    // them with a cluster they still cannot reach.
    await this.spend(payload.clusterId, payload.jti);

    const enrolment = await this.enrolNodes(payload.clusterId, dto.publicKey);

    return {
      fingerprint: ca.fingerprint,
      enrolledOnNodes: enrolment.every((r) => r.succeeded),
      message: enrolment.every((r) => r.succeeded)
        ? `Certificate authority registered and enrolled on ${enrolment.length} node(s).`
        : `Certificate authority registered. Enrolment incomplete: ${enrolment
            .filter((r) => !r.succeeded)
            .map((r) => `${r.nodeName} — ${r.detail}`)
            .join('; ')}`,
    };
  }

  /**
   * Registers the authority, or accepts that it is already the one in place.
   *
   * `registerExternalCA` treats re-registering an identical key as a conflict,
   * which is right for an operator who did not mean to do it twice and wrong
   * here: adoption is two steps, and the second one — enrolling the nodes — is
   * exactly the step likely to need a retry. Refusing because the first step is
   * already done would leave the owner permanently unable to finish.
   */
  private async registerOrKeep(
    publicKey: string,
    name?: string,
  ): Promise<{ fingerprint: string }> {
    try {
      return await this.caManager.registerExternalCA(publicKey, {
        name: name ?? 'adopted',
        replace: true,
      });
    } catch (error) {
      const already =
        error instanceof ConflictException &&
        /already registered/i.test(String((error as Error).message));
      if (!already) throw error;
      return await this.caManager.getCAInfo();
    }
  }

  /**
   * Enrolment runs here, not on the owner's machine, because the owner has no
   * way in yet — that is the entire situation adoption exists to resolve. The
   * cluster reaches its own nodes through its own Kubernetes API.
   *
   * A failure is reported, never thrown: the authority is registered by this
   * point and the token has been spent, so raising here would leave the owner
   * with a used token and no account of what actually happened.
   */
  private async enrolNodes(
    clusterId: string,
    caPublicKey: string,
  ): Promise<EnrolmentResult[]> {
    try {
      const cluster = await this.clustersService.getClusterEntity(clusterId);
      if (!cluster.kubeconfigEncrypted) {
        return [
          {
            nodeName: '(unknown)',
            succeeded: false,
            detail:
              'This installation holds no kubeconfig for itself, so it cannot reach its own nodes.',
          },
        ];
      }

      const kubeconfig = this.encryption.decrypt(cluster.kubeconfigEncrypted);
      const nodes = await this.clustersService.getClusterNodes(clusterId);
      return await this.enrolment.enrolAll(
        kubeconfig,
        caPublicKey,
        nodes.map((node) => ({ nodeName: node.serverName })),
      );
    } catch (error) {
      return [
        {
          nodeName: '(unknown)',
          succeeded: false,
          detail: error instanceof Error ? error.message : String(error),
        },
      ];
    }
  }

  /**
   * Records a spent token, pruning entries that can no longer be replayed.
   *
   * Without the prune this list grows for the life of the installation to hold
   * identifiers of tokens that expired hours ago and would be rejected on their
   * expiry alone.
   */
  private async spend(clusterId: string, jti: string): Promise<void> {
    const cluster = await this.clusters.findOne({ where: { id: clusterId } });
    if (!cluster) return;

    const metadata = (cluster.metadata ?? {}) as Record<string, unknown>;
    const adoption = (metadata['adoption'] ?? {}) as {
      spent?: unknown;
      lastAdoptedAt?: string;
    };
    const spent = Array.isArray(adoption.spent)
      ? adoption.spent.filter((v): v is string => typeof v === 'string')
      : [];

    cluster.metadata = {
      ...metadata,
      adoption: {
        // One hour of tokens is the whole window in which a replay is possible.
        spent: [...spent, jti].slice(-64),
        lastAdoptedAt: new Date().toISOString(),
      },
    };
    await this.clusters.save(cluster);
  }

  private async controlCluster(): Promise<ClusterEntity> {
    const cluster = await this.clusters.findOne({
      where: { clusterType: 'control' as never },
      order: { createdAt: 'ASC' },
    });
    if (!cluster) {
      throw new NotFoundException(
        'This installation has no control cluster to adopt.',
      );
    }
    return cluster;
  }

  private endpoint(): string {
    return (
      this.configService.get<string>('API_BASE_URL') ??
      this.configService.get<string>('FRONTEND_URL') ??
      ''
    ).replace(/\/api\/v1\/?$/, '');
  }

  private async hasCa(): Promise<boolean> {
    try {
      await this.caManager.getCAInfo();
      return true;
    } catch {
      return false;
    }
  }
}
