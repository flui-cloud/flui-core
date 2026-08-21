import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import { AdminGuard } from '../auth/guards/admin.guard';
import { Admin } from '../auth/decorators/admin.decorator';
import { SANDBOX_ALLOWLIST, SANDBOX_AREAS } from './constants/sandbox-fence';
import { SandboxCapacityDto } from './dto/sandbox-capacity.dto';
import { SandboxLimitsDto } from './dto/sandbox-limits.dto';
import { DEFAULT_SANDBOX_QUOTA } from './constants/sandbox-quota.manifest';
import { SandboxTenancyDto } from './dto/sandbox-tenancy.dto';
import { SandboxCapacityService } from './services/sandbox-capacity.service';
import { SandboxReserveService } from './services/sandbox-reserve.service';
import { SandboxTenantService } from './services/sandbox-tenant.service';
import { SandboxTenantEntity } from './entities/sandbox-tenant.entity';

@ApiTags('Sandbox')
@Controller('sandbox')
export class SandboxController {
  constructor(
    private readonly capacity: SandboxCapacityService,
    private readonly reserve: SandboxReserveService,
    private readonly tenants: SandboxTenantService,
  ) {}

  /**
   * Public on purpose. "What is disabled here, and why" is a promise made before
   * anyone signs in — a visitor deciding whether to click should be able to read
   * it, and a guest hitting a refusal should be able to check it without asking.
   */
  @Get('limits')
  @Public()
  @ApiOperation({
    summary: 'What a sandbox guest may do, what it may not, and the quota',
    description:
      'The same allowlist the fence enforces, served as documentation. Nothing here is advisory: a route absent from `allowed` is refused by the API, not merely hidden. `areas` is the level of each part of the product — the interface turns it into a standing label on the section, which is how a limit is told here: never with an error.',
  })
  @ApiResponse({ status: 200, type: SandboxLimitsDto })
  limits(): SandboxLimitsDto {
    return {
      allowed: SANDBOX_ALLOWLIST.map((r) => ({
        routes: r.verbs.map((v) => `${v} ${r.pattern}`),
        why: r.why,
        level: r.level ?? 'full',
      })),
      areas: SANDBOX_AREAS,
      quota: {
        cpu: `${DEFAULT_SANDBOX_QUOTA.cpuLimit} cores`,
        memory: DEFAULT_SANDBOX_QUOTA.memoryLimit,
        storage: DEFAULT_SANDBOX_QUOTA.storage,
        pods: DEFAULT_SANDBOX_QUOTA.pods,
      },
    };
  }

  /**
   * Why the sandbox is holding as many warm tenancies as it is.
   *
   * Not public, unlike the limits above: this is the shape of the instance —
   * how much room is left and how busy the door is — and it is the operator's
   * business rather than the visitor's. Guests cannot reach it in any case,
   * since it is not on the fence's allowlist.
   */
  @Get('capacity')
  @UseGuards(AdminGuard)
  @Admin()
  @ApiOperation({
    summary: 'How many tenancies are warm, why that number, and the ceiling',
    description:
      'The buffer is not configured; it is computed from how many areas are being taken per hour and how long one takes to become safe to hand over. This is that arithmetic with its inputs, so a number that looks wrong can be traced to the measurement that made it wrong rather than argued about.',
  })
  @ApiResponse({ status: 200, type: SandboxCapacityDto })
  capacitySnapshot(): Promise<SandboxCapacityDto> {
    return this.capacity.snapshot();
  }

  /**
   * The areas themselves. Operator-only for the same reason as the capacity
   * above: this is the shape of the instance, not a guest's business.
   */
  @Get('tenancies')
  @UseGuards(AdminGuard)
  @Admin()
  @ApiOperation({
    summary: 'Every guest area this instance is holding, and its state',
    description:
      'Includes the areas that stopped being retried: `reapAttempts` is how many consecutive sweeps ended in the same error, and `state: needs_attention` means the sweep gave up and left the row for a person.',
  })
  @ApiResponse({ status: 200, type: SandboxTenancyDto, isArray: true })
  async listTenancies(): Promise<SandboxTenancyDto[]> {
    const all = await this.reserve.listAll();
    return all.map((t) => this.toTenancyDto(t));
  }

  /**
   * Expiring an area is a product operation, not a cluster one.
   *
   * Without it the only way to remove a leftover area was to open the machine
   * and delete the namespace — which skips the reaper, and the reaper is the
   * only thing that also removes the identity-provider account. That has gone
   * wrong here before, so this route deliberately runs the same sweep rather
   * than a shortcut of its own.
   */
  @Post('tenancies/:ref/expire')
  @UseGuards(AdminGuard)
  @Admin()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Expire one guest area now, through the reaper',
    description:
      'Runs the same teardown the deadline would have run: namespace, endpoints, applications, grant and identity-provider account, in that order. Returns the area as it stands afterwards — `expired` when the teardown completed, `failed` or `needs_attention` with `lastError` when part of it did not.',
  })
  @ApiParam({
    name: 'ref',
    description: 'Namespace or id of the area',
  })
  @ApiResponse({ status: 200, type: SandboxTenancyDto })
  @ApiResponse({ status: 404, description: 'No such area' })
  async expireTenancy(@Param('ref') ref: string): Promise<SandboxTenancyDto> {
    const tenant = await this.reserve.findOneByRef(ref);
    if (!tenant) {
      throw new NotFoundException(`No sandbox area "${ref}"`);
    }
    return this.toTenancyDto(await this.tenants.expireNow(tenant));
  }

  private toTenancyDto(t: SandboxTenantEntity): SandboxTenancyDto {
    return {
      id: t.id,
      state: t.state,
      namespace: t.namespace,
      clusterId: t.clusterId,
      claimedAt: t.claimedAt,
      expiresAt: t.expiresAt,
      reapedAt: t.reapedAt,
      reapAttempts: t.reapAttempts,
      lastError: t.lastError,
      createdAt: t.createdAt,
    };
  }
}
