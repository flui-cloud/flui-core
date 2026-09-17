import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  OvhProviderService as InfraOvhProviderService,
  packRegionId,
  parseRegionId,
} from '@flui-cloud/infra';
import {
  ICloudProvider,
  CreateServerConfig,
  ServerCreationResult,
  ServerDeletionResult,
  SSHKeyCreationResult,
  AttachedVolumeResult,
  ProviderVolumeSummary,
} from '../../interfaces/cloud-provider.interface';
import {
  CreateVNetConfig,
  VNetCreationResult,
  VNetDetails,
  VNetDeletionResult,
  AddSubnetConfig,
  DeleteSubnetConfig,
  AttachServerToVNetConfig,
  DetachServerFromVNetConfig,
  ServerVNetAttachmentResult,
} from '../../interfaces/network-provider.interface';
import { InstanceEntity } from '../../../instances/entities/instance.entity';
import { InstanceStatus } from '../../../instances/entities/instance-status.enum';
import { DeleteServerDto } from '../../../infrastructure/servers/dto/delete-server.dto';
import { ServerResponseDto } from '../../../infrastructure/servers/dto/server-response.dto';
import { NodeSizeDto } from '../../dto/node-size.dto';
import { CloudProvider } from '../../enums/cloud-provider.enum';
import { ICredentialProvider } from '../../interfaces/credential-provider.interface';
import { buildOvhOpenStackClient } from './ovh-openstack-client.factory';
import { getOvhNodeSizesFromNova, FlavorPricing } from './ovh-nova-flavors';
import { FluiOpenStackClient } from './openstack-volumes-client';

/**
 * GPU flavors are real, orderable OVH products (@flui-cloud/infra's catalog
 * intentionally keeps them — see its ovh-flavor-denylist.ts), but Flui has no
 * GPU-aware workload story yet. Offering one as a K3s cluster node size would
 * let someone provision a many-thousands-EUR/month box for a control-plane
 * node by mistake. @flui-cloud/infra doesn't expose the catalog's
 * `technical.gpu` field, so this list stands in for it — verified against
 * OVH's live public catalog (eu.api.ovh.com/v1/order/catalog/public/cloud)
 * on 2026-09-12: every flavor with a non-null `technical.gpu` falls under one
 * of these plan-code prefixes.
 */
const OVH_GPU_FLAVOR_PREFIXES = [
  'a10-',
  'a100-',
  'g1-',
  'g2-',
  'g3-',
  'h100-',
  'h200-',
  'l4-',
  'l40s-',
  'rtx5000-',
  't1-',
  't2-',
];

function isOvhGpuFlavor(id: string): boolean {
  return OVH_GPU_FLAVOR_PREFIXES.some((prefix) => id.startsWith(prefix));
}

/**
 * Shell run inside the guest before the bootstrap script's own body, to give
 * the hot-attached VNet interface a netplan declaration it would otherwise
 * never get (see withPrivateNicNetplan).
 *
 * The NIC is discovered at runtime rather than named: its predictable name
 * depends on the PCI slot Nova hot-plugs it into, and the only thing Flui
 * knows for certain is that it is the one real ethernet device that is
 * neither loopback, nor the Ext-Net device holding the default route, nor
 * already carrying an IPv4 address.
 *
 * `use-routes: false` is the reason this is a separate file rather than a
 * plain `dhcp4: true`: the VNet's DHCP would otherwise install a second
 * default route and blackhole egress.
 *
 * `netplan apply` reconfigures every link, not just the one whose file
 * changed, so the public interface loses its lease and its default route for
 * a moment — long enough that the bootstrap's very next command (a curl of
 * the next-stage script) died in 53ms with a resolve/route error on live
 * nodes. The private address appearing says nothing about that, hence the
 * separate egress wait before returning.
 */
const OVH_PRIVATE_NIC_NETPLAN_SNIPPET = `
flui_ovh_wait_for_egress() {
  flui_probe_url=https://raw.githubusercontent.com/
  flui_i=0
  while [ "$flui_i" -lt 15 ]; do
    if [ -n "$(ip -4 route show default 2>/dev/null)" ]; then
      if ! command -v curl >/dev/null 2>&1; then
        echo "[Bootstrap] Egress: default route is back (no curl to confirm)"
        return 0
      fi
      if curl -sS -m 2 -o /dev/null "$flui_probe_url" >/dev/null 2>&1; then
        echo "[Bootstrap] Egress restored after netplan apply"
        return 0
      fi
    fi
    flui_i=$((flui_i + 1))
    sleep 2
  done
  echo "[Bootstrap] WARNING: no egress 30s after netplan apply - continuing anyway"
  return 0
}

flui_ovh_configure_private_nic() {
  command -v netplan >/dev/null 2>&1 || return 0

  flui_primary=$(ip -4 route show default 2>/dev/null | awk '{print $5; exit}')
  flui_nic=''
  flui_i=0
  # Ten minutes, against the sixty seconds this used to allow. OVH cannot give
  # an instance its private interface at create time — asking leaves it stuck in
  # BUILD — so Flui hot-attaches it once the server is ACTIVE, and that can land
  # as late as four minutes after creation: 120s waiting for ACTIVE plus 120s
  # watching the console for the guest to boot. The old bound expired first and
  # the node carried on without a private network it was about to be told it
  # had. There is nothing to race here: the node simply has to outwait the
  # control plane, and the creation job allows thirty minutes for all of it.
  while [ "$flui_i" -lt 300 ]; do
    for flui_path in /sys/class/net/*; do
      flui_dev=\${flui_path##*/}
      [ "$flui_dev" = "lo" ] && continue
      [ "$flui_dev" = "$flui_primary" ] && continue
      [ -e "$flui_path/device" ] || continue
      ip -4 -o addr show dev "$flui_dev" 2>/dev/null | grep -q . && continue
      flui_nic=$flui_dev
      break
    done
    [ -n "$flui_nic" ] && break
    flui_i=$((flui_i + 1))
    sleep 2
  done

  if [ -z "$flui_nic" ]; then
    # Loudly, not quietly. A node that proceeds without the interface binds
    # K3s to its public address and looks healthy: the cluster forms, the pods
    # schedule, and the traffic between them crosses the internet in the clear
    # for the life of the node. A creation that fails here is recoverable; that
    # is not.
    echo "[Bootstrap] FATAL: OVH private network interface never appeared after 600s" >&2
    return 1
  fi

  cat > /etc/netplan/60-flui-private.yaml <<FLUI_NETPLAN_EOF
network:
  version: 2
  ethernets:
    $flui_nic:
      dhcp4: true
      dhcp4-overrides:
        use-routes: false
      accept-ra: false
      optional: true
FLUI_NETPLAN_EOF
  chmod 600 /etc/netplan/60-flui-private.yaml
  netplan apply || true

  flui_i=0
  while [ "$flui_i" -lt 60 ]; do
    ip -4 -o addr show dev "$flui_nic" 2>/dev/null | grep -q . && break
    flui_i=$((flui_i + 1))
    sleep 2
  done
  flui_addr=$(ip -4 -o addr show dev "$flui_nic" 2>/dev/null | awk '{print $4}')
  if [ -z "$flui_addr" ]; then
    # The interface is there but Neutron's DHCP never answered. Same reasoning
    # as above: an interface with no address is not a private network.
    echo "[Bootstrap] FATAL: OVH private NIC $flui_nic never received an address" >&2
    return 1
  fi
  echo "[Bootstrap] OVH private NIC $flui_nic: $flui_addr"

  flui_ovh_wait_for_egress
}
if ! flui_ovh_configure_private_nic; then
  echo "[Bootstrap] refusing to install onto a node with no private network" >&2
  exit 1
fi
`;

/**
 * Console signatures that prove the guest is already running (see
 * waitForGuestBoot). The first is cloud-init's network-stage banner — the
 * quotes matter: they keep it from matching the much earlier `running
 * 'init-local'`.
 */
const OVH_GUEST_BOOTED_CONSOLE_MARKERS = [
  /running 'init'/,
  /ci-info:.*Net device info/,
];

/**
 * Flui-native OVH provider — delegates the actual Nova/Neutron work to
 * @flui-cloud/infra's OvhProviderService, but sources credentials from
 * ICredentialProvider (the encrypted DB-backed store) instead of process env
 * vars, and re-resolves them on every call so a rotated credential takes
 * effect immediately, matching Hetzner/Scaleway.
 */
@Injectable()
export class OvhProviderService implements ICloudProvider {
  private readonly logger = new Logger(OvhProviderService.name);

  /** Catalog/pricing (getNodeSizes) needs no credentials — one shared instance is enough. */
  private readonly catalogOnly = new InfraOvhProviderService(
    this.configService,
  );

  constructor(
    private readonly configService: ConfigService,
    @Inject('ICredentialProvider')
    private readonly credentialProvider: ICredentialProvider,
  ) {}

  private async delegate(): Promise<InfraOvhProviderService> {
    const client = await this.client();
    return new InfraOvhProviderService(this.configService, client);
  }

  private async client(): Promise<FluiOpenStackClient> {
    const { accessKey, secretKey } =
      await this.credentialProvider.getActiveAccessKeyPair(CloudProvider.OVH);
    return buildOvhOpenStackClient(this.configService, accessKey, secretKey);
  }

  async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      const svc = await this.delegate();
      return svc.testConnection();
    } catch (e) {
      return {
        success: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  /**
   * Was a hard-coded `[]` — OVH servers never showed up in `/instances` at
   * all, not even the control cluster's own master, because nothing here
   * ever called the provider. listServersAsDto() already does the real work;
   * this only shapes its result into InstanceEntity, matching the schema
   * IamOwnership.classifyOwnership() (in InstancesService) expects — labels
   * specifically have to land at metadata.labels as a plain
   * Record<string,string>, not the {key,value}[] shape ServerResponseDto
   * itself uses, or every OVH server would misclassify as unmanaged.
   */
  async listInstances(filters?: {
    clusterId?: string;
  }): Promise<InstanceEntity[]> {
    const [servers, nodeSizes] = await Promise.all([
      this.listServersAsDto(),
      this.getNodeSizes().catch(() => []),
    ]);

    const scoped = filters?.clusterId
      ? servers.filter(
          (s) =>
            s.labels?.find((l) => l.key === 'flui-cluster-id')?.value ===
            filters.clusterId,
        )
      : servers;

    return scoped.map((s) => this.toInstanceEntity(s, nodeSizes));
  }

  private toInstanceEntity(
    s: ServerResponseDto,
    nodeSizes: NodeSizeDto[],
  ): InstanceEntity {
    const size = nodeSizes.find(
      (n) => n.id === s.server_type || n.name === s.server_type,
    );

    const instance = new InstanceEntity();
    instance.name = s.name;
    instance.displayName = s.name;
    instance.provider = CloudProvider.OVH;
    instance.providerId = s.id;
    instance.status = mapOvhStatusToInstanceStatus(s.status);
    instance.dataCenter = s.location ?? 'unknown';
    instance.region = s.location ?? 'unknown';
    instance.regionName = '';
    instance.cpuCores = size?.cores ?? 0;
    instance.ramMb = (size?.memory ?? 0) * 1024;
    instance.diskMb = (size?.disk ?? 0) * 1024;
    instance.osType = null;
    instance.ipConfig = {
      v4: s.public_ip
        ? { ip: s.public_ip, gateway: '', netmaskCidr: 32 }
        : undefined,
    };
    instance.productType = s.server_type ?? 'unknown';
    instance.productName = size?.description ?? '';
    instance.defaultUser = 'root';
    instance.additionalIps = [];
    instance.metadata = {
      labels: s.labels?.length
        ? Object.fromEntries(s.labels.map((l) => [l.key, l.value]))
        : {},
      privateIp: s.private_ip,
    };
    return instance;
  }

  /**
   * Shapes come from Nova, prices from the public ordering catalog: Nova knows
   * what a region actually offers, the catalog knows what it costs, and neither
   * knows both. Milan, Paris and Roubaix carry live Nova flavors that appear in
   * no catalog entry at all.
   *
   * Falls back to the catalog when Nova cannot be reached, so a missing or
   * broken credential degrades to a smaller list rather than an empty one.
   */
  async getNodeSizes(): Promise<NodeSizeDto[]> {
    const catalogSizes = await this.catalogOnly.getNodeSizes();
    try {
      const client = await this.client();
      const pricing = new Map<string, FlavorPricing>(
        catalogSizes.map((size) => [
          size.id,
          {
            hourly: Number(size.prices[0]?.priceHourly.net) || undefined,
            monthly: Number(size.prices[0]?.priceMonthly.net) || undefined,
            storageType: size.storageType,
            cpuType: size.cpuType,
            deprecated: size.deprecated,
          },
        ]),
      );
      const sizes = await getOvhNodeSizesFromNova(client, pricing);
      if (sizes.length) return sizes.filter((size) => !isOvhGpuFlavor(size.id));
    } catch (error) {
      this.logger.warn(
        `Could not read OVH flavors from Nova, falling back to the order catalog: ${String(error)}`,
      );
    }
    return catalogSizes.filter((size) => !isOvhGpuFlavor(size.id));
  }

  async listServersAsDto(): Promise<ServerResponseDto[]> {
    const svc = await this.delegate();
    const servers = await svc.listServersAsDto();
    return servers.map((s) => toLocalServerDto(s));
  }

  async getServerDetailsAsDto(
    serverId: string,
  ): Promise<ServerResponseDto | null> {
    const svc = await this.delegate();
    const server = await svc.getServerDetailsAsDto(serverId);
    return server ? toLocalServerDto(server) : null;
  }

  async getServerStatus(serverId: string): Promise<string> {
    const svc = await this.delegate();
    try {
      const status = await svc.getServerStatus(serverId);
      return normalizeOvhServerStatus(status);
    } catch (error) {
      // @flui-cloud/infra throws when Nova has no such server; Hetzner/Scaleway
      // return 'not-found' instead, which is what waitForDeletionComplete
      // polls for to detect a completed delete.
      if (error instanceof Error && /not found/i.test(error.message)) {
        return 'not-found';
      }
      throw error;
    }
  }

  /** `getServerDetailsAsDto` already scans every region to find the server; reuse it rather than re-scanning. */
  async getConsoleOutput(serverId: string, length = 200): Promise<string> {
    const svc = await this.delegate();
    const details = await svc.getServerDetailsAsDto(serverId);
    if (!details) {
      throw new NotFoundException(`OVH server ${serverId} not found.`);
    }
    const client = await this.client();
    return client.getConsoleOutput(details.location, serverId, length);
  }

  async createServer(
    config: CreateServerConfig,
  ): Promise<ServerCreationResult> {
    const client = await this.client();
    const svc = new InfraOvhProviderService(this.configService, client);
    const region = await client.resolveComputeRegion(config.location);

    // Attaching a private VNet alongside Ext-Net at create time left the
    // instance stuck in BUILD with no IP ever assigned (OVH's own docs frame
    // Ext-Net-only as the reliable path to an automatic public IP; a private
    // network is meant to be added afterwards, via a Floating IP or a second
    // interface — not requested together at boot). So: boot on Ext-Net only,
    // then attach the private network(s) once the server is up.
    const result = await svc.createServer({
      ...config,
      image: toOvhImageName(config.image),
      networks: undefined,
      user_data: this.withPrivateNicNetplan(config),
    });

    // Nova's create response is 'BUILD' with no IP yet — unlike Hetzner/
    // Scaleway, which allocate a public IP synchronously at create time.
    // Every downstream caller assumes createServer() returns a usable IP, so
    // wait here instead of leaking that difference to the rest of Flui.
    // Nova also refuses os-interface attach while vm_state is still
    // 'building' — even after the IP shows up — so this waits for ACTIVE,
    // not just a truthy public_ip.
    if (!result.ipAddress || result.status !== 'ACTIVE') {
      const active = await this.waitForServerActive(
        svc,
        result.serverId,
        undefined,
        undefined,
        { client, region },
      );
      if (active) {
        result.ipAddress = active.public_ip ?? result.ipAddress;
        result.privateIp = active.private_ip ?? result.privateIp;
        result.status = active.status;
      }
    }

    // From here on, the server already exists at the provider. A failure in
    // either step below must not throw it away silently — the caller only
    // learns the serverId from this method's return value, so an exception
    // here would orphan a real, billed server with nothing left to clean it
    // up (this is exactly how one got stranded during development: the
    // interface-attach step failed and the caller never got serverId to
    // delete it). Best-effort delete before re-throwing.
    try {
      if (config.networks?.length) {
        await this.waitForGuestBoot(client, region, result.serverId);

        for (const netId of config.networks) {
          await client.attachServerInterface(
            region,
            result.serverId,
            parseRegionId(netId).id,
          );
        }

        // Hot-attaching a NIC after boot races cloud-init: the metadata
        // service already reports it, but the guest's early boot stages can
        // query that before the kernel has hot-plugged the device, and
        // cloud-init crashes instead of retrying (seen live: "Unable to find
        // a system nic for {mac}", every cloud-init stage failing as a
        // result — the bootstrap script never runs at all). A SOFT reboot
        // fixes that by giving the guest a normal boot with the NIC already
        // on the bus — but it is not free: if the guest's own bootstrap
        // script (flui-init.sh, launched from cloud-init's runcmd) already
        // started, the reboot's shutdown sweep SIGTERMs it mid-flight, and
        // cloud-init does NOT retry a stage that was killed by signal — only
        // one that recorded itself as failed. Live-confirmed: apt-get killed
        // mid-install, k3s never installed, no error anywhere. So only
        // reboot when the console actually shows the NIC crash — never
        // unconditionally.
        const sawNicCrash = await this.pollForNicRaceOutcome(
          client,
          region,
          result.serverId,
        );
        if (sawNicCrash) {
          await client.rebootServer(region, result.serverId);
          // waitForServerActive's first check runs immediately — without
          // this, it can catch Nova still reporting the pre-reboot ACTIVE
          // status before the reboot transition has even registered, and
          // return straight away without actually waiting for the reboot.
          await new Promise((r) => setTimeout(r, 5_000));
          const activeAfterReboot = await this.waitForServerActive(
            svc,
            result.serverId,
            undefined,
            undefined,
            { client, region },
          );
          if (activeAfterReboot) {
            result.ipAddress = activeAfterReboot.public_ip ?? result.ipAddress;
            result.privateIp = activeAfterReboot.private_ip ?? result.privateIp;
            result.status = activeAfterReboot.status;
          }
        }
      }

      if (config.attachedVolumes?.length) {
        const attached: AttachedVolumeResult[] = [];
        for (const vol of config.attachedVolumes) {
          const metadata = vol.labels?.length
            ? Object.fromEntries(vol.labels.map((l) => [l.key, l.value]))
            : undefined;
          const created = await client.createVolume(region, {
            name: vol.name,
            sizeGb: vol.sizeGb,
            metadata,
          });
          await client.waitForVolumeAvailable(region, created.id);
          const attachment = await client.attachVolumeToServer(
            region,
            result.serverId,
            created.id,
          );
          attached.push({
            volumeId: packRegionId(region, created.id),
            devicePath: attachment.device,
            sizeGb: vol.sizeGb,
          });
        }
        result.attachedVolumes = attached;
      }
    } catch (error) {
      await svc
        .deleteServer({
          server_id: result.serverId,
          provider: CloudProvider.OVH,
          force: true,
        })
        .catch(() => undefined);
      throw error;
    }

    return result;
  }

  /**
   * Compensates, inside the guest, for this service's own "boot on Ext-Net
   * only" workaround. cloud-init writes /etc/netplan/50-cloud-init.yaml at
   * first boot, when the VNet interface does not exist yet; the interface
   * hot-attached seconds later therefore appears in no netplan config at all
   * and stays DOWN with no IP permanently — live-confirmed on two clusters,
   * with k3s falling back to registering the public IP as its INTERNAL-IP.
   * Every other provider attaches the VNet at create time and never sees
   * this, so the fix belongs here rather than in the shared bootstrap
   * scripts or in provider-agnostic code.
   *
   * user_data is a plain `#!/bin/bash` script (K3sScriptService.
   * generateBootstrapScript), which @flui-cloud/infra base64-encodes for
   * Nova — it is not cloud-config, so a `write_files` fragment cannot be
   * merged into it. Splicing shell in after the shebang keeps the payload
   * format byte-for-byte what cloud-init already handles, and lands ahead of
   * the script's own `set -euo pipefail` so nothing here can abort the
   * bootstrap. Anything that is neither absent nor a shell script is left
   * untouched: a broken bootstrap is far worse than no private network.
   */
  private withPrivateNicNetplan(
    config: CreateServerConfig,
  ): string | undefined {
    if (!config.networks?.length) return config.user_data;

    const userData = config.user_data;
    if (!userData?.trim()) {
      return `#!/bin/bash\n${OVH_PRIVATE_NIC_NETPLAN_SNIPPET}`;
    }
    if (!userData.startsWith('#!')) {
      this.logger.warn(
        'OVH user_data is not a shell script — skipping the private-NIC netplan injection; the VNet interface will have no IP.',
      );
      return userData;
    }

    const shebangEnd = userData.indexOf('\n');
    if (shebangEnd === -1) return userData + OVH_PRIVATE_NIC_NETPLAN_SNIPPET;
    return (
      userData.slice(0, shebangEnd) +
      OVH_PRIVATE_NIC_NETPLAN_SNIPPET +
      userData.slice(shebangEnd + 1)
    );
  }

  private async waitForServerActive(
    svc: InfraOvhProviderService,
    serverId: string,
    timeoutMs = 120_000,
    pollIntervalMs = 3_000,
    faultContext?: { client: FluiOpenStackClient; region: string },
  ): Promise<{
    public_ip?: string;
    private_ip?: string;
    status: string;
  } | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const server = await svc.getServerDetailsAsDto(serverId);
      if (server?.public_ip && server.status === 'ACTIVE') return server;
      // An instance Nova has given up on will never become ACTIVE, and waiting
      // out the deadline hides the reason behind whatever fails next. The
      // attach below then reports "cannot attach_interface while it is in
      // vm_state error", which names the wrong subject entirely: the interface
      // is fine, the machine was never built.
      if (server?.status?.toUpperCase() === 'ERROR') {
        throw new Error(await this.explainBuildFailure(serverId, faultContext));
      }
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
    return null;
  }

  /**
   * What OVH says about an instance it could not build.
   *
   * Nova puts the reason in the server's `fault` field, which the client's type
   * does not declare — the field is in the response, not in the interface, so
   * it is read explicitly rather than assumed absent. Worth the reach: the
   * common case is `No valid host was found`, meaning the region has no room
   * for that flavor at that moment. It is temporary and not a misconfiguration,
   * and the message should say so rather than leave the reader hunting.
   *
   * OVH does publish per-flavor stock, but on its own API and under application
   * credentials, not the OpenStack ones this provider holds — so with what is
   * configured here the condition is only knowable once it has happened.
   */
  private async explainBuildFailure(
    serverId: string,
    ctx?: { client: FluiOpenStackClient; region: string },
  ): Promise<string> {
    let reason = '';
    if (ctx) {
      try {
        const raw = (await ctx.client.getServer(serverId, ctx.region)) as
          | { fault?: { message?: string } }
          | null
          | undefined;
        reason = raw?.fault?.message?.trim() ?? '';
      } catch {
        // The reason is a courtesy; not having it must not replace the failure
        // with a different one.
      }
    }
    const where = ctx?.region ? ` in ${ctx.region}` : '';
    const capacity = /no valid host/i.test(reason);
    return (
      `OVH could not build the instance${where}` +
      (reason ? `: ${reason}` : '.') +
      (capacity
        ? ' That region has no room for this node size at the moment — ' +
          'it is temporary and not a misconfiguration. Try another region, ' +
          'or a different node size in the same one.'
        : '')
    );
  }

  /**
   * Waits until the guest is demonstrably running before the VNet interface is
   * attached, so the attach is a real hot-plug.
   *
   * Nova reporting ACTIVE says the hypervisor accepted the instance, not that
   * the guest has powered on: OVH leaves instances in BUILD for a minute or
   * more and the private Neutron port was seen being created 79-111s after the
   * server record. When the attach lands in that window the VM powers on with
   * BOTH NICs already on the bus — exactly the create-time-attach condition
   * the Ext-Net-only workaround above exists to avoid — and hits OVH's bug:
   * neither interface ever gets an address, systemd-networkd-wait-online times
   * out, the bootstrap script can download nothing and the node is dead.
   * Live-confirmed on two nodes, whose consoles showed both `ens3` and `ens7`
   * renamed at ~2.2s of guest uptime (2026-09-13); it accounted for roughly
   * 40% of OVH nodes.
   *
   * The marker has to sit between two failure modes: anything earlier than
   * userspace (a non-empty console, a kernel line) can still be a guest that
   * is only just powering on, while waiting for cloud-init to *finish* would
   * push the private IP past the bootstrap script's own PRIVATE_IP
   * autodetection, which falls back to the public address when there is none.
   * cloud-init's network stage banner is the narrow point in between: it is
   * printed once the kernel has enumerated the Ext-Net NIC and cloud-init has
   * reached its net stage, still several stages ahead of the runcmd that
   * launches the bootstrap script — and the netplan snippet spliced into that
   * script waits a further 60s for the NIC, so the attach has ample room. The
   * `ci-info:` device table is accepted as a second signature purely for
   * redundancy across image versions; it is printed by the same cloud-init
   * entry point and is likewise proof of a running guest.
   */
  private async waitForGuestBoot(
    client: FluiOpenStackClient,
    region: string,
    serverId: string,
    timeoutMs = 120_000,
    pollIntervalMs = 5_000,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const output = await client
        .getConsoleOutput(region, serverId, 200)
        .catch(() => '');
      if (OVH_GUEST_BOOTED_CONSOLE_MARKERS.some((m) => m.test(output))) {
        return true;
      }
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }

    // Attach anyway: the console API returns empty for a while on some
    // instances and can fail outright, and a node with no private network is
    // still better than a cluster creation that fails outright.
    this.logger.warn(
      `OVH server ${serverId}: serial console never showed the guest booting within ${timeoutMs / 1000}s — attaching the private interface anyway.`,
    );
    return false;
  }

  /**
   * Whether the guest actually hit the hot-attach NIC race, read from its
   * serial console — no SSH or network reachability to the guest required,
   * so this works even when the crash itself broke networking. Polls
   * because the answer only exists once the guest's early boot stages have
   * run at all: too early and neither signature is there yet.
   *
   * Both signatures are drawn from a real crash and a real clean boot
   * observed live on this account (see createServer's caller comment).
   * Defaults to "no crash" on timeout or a console-fetch failure: an
   * unconfirmed reboot risks killing an in-progress bootstrap for real,
   * observed harm, against a NIC race this is a best-effort guard for in
   * the first place.
   */
  private async pollForNicRaceOutcome(
    client: FluiOpenStackClient,
    region: string,
    serverId: string,
    timeoutMs = 30_000,
    pollIntervalMs = 5_000,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, pollIntervalMs));
      const output = await client
        .getConsoleOutput(region, serverId, 500)
        .catch(() => '');
      if (/Unable to find a system nic/.test(output)) return true;
      if (/finished at .+Datasource DataSourceOpenStackLocal/.test(output)) {
        return false;
      }
    }
    return false;
  }

  async deleteServer(config: DeleteServerDto): Promise<ServerDeletionResult> {
    const svc = await this.delegate();
    return svc.deleteServer(config);
  }

  // ── Block storage (Cinder) volumes ──

  async expandVolume(
    volumeId: string,
    newSizeGb: number,
  ): Promise<{ actionId?: number }> {
    const client = await this.client();
    const { region, id } = parseRegionId(volumeId);
    if (!region) throw new Error(`OVH volume ${volumeId} not found.`);
    await client.extendVolume(region, id, newSizeGb);
    return {};
  }

  async detachVolume(volumeId: string): Promise<{ actionId?: number }> {
    const client = await this.client();
    const { region, id } = parseRegionId(volumeId);
    if (!region) throw new Error(`OVH volume ${volumeId} not found.`);
    const volume = await client.getVolume(region, id);
    if (!volume) return {};
    for (const attachment of volume.attachments) {
      await client.detachVolumeFromServer(
        region,
        attachment.server_id,
        attachment.attachment_id,
      );
    }
    return {};
  }

  async deleteVolume(volumeId: string): Promise<void> {
    const client = await this.client();
    const { region, id } = parseRegionId(volumeId);
    if (!region) throw new Error(`OVH volume ${volumeId} not found.`);
    await client.deleteVolume(region, id);
  }

  async listFluiManagedVolumes(): Promise<ProviderVolumeSummary[]> {
    const client = await this.client();
    const regions = await client.regions('volumev3');
    const perRegion = await Promise.all(
      regions.map(async (region) => {
        const volumes = await client.listVolumes(region);
        return volumes
          .filter((v) => v.metadata?.['managed-by'] === 'flui-cloud')
          .map(
            (v): ProviderVolumeSummary => ({
              volumeId: packRegionId(region, v.id),
              name: v.name,
              sizeGb: v.size,
              region,
              attachedServerId: v.attachments[0]?.server_id ?? null,
              labels: v.metadata ?? {},
              createdAt: v.created_at,
            }),
          );
      }),
    );
    return perRegion.flat();
  }

  async createSSHKey(
    name: string,
    publicKey: string,
  ): Promise<SSHKeyCreationResult> {
    const svc = await this.delegate();
    return svc.createSSHKey(name, publicKey);
  }

  // ── Private networks (VNets) via Neutron ──

  async createVNet(config: CreateVNetConfig): Promise<VNetCreationResult> {
    const client = await this.client();
    // createVNet() takes no region hint of its own — it always uses the
    // client's default region, so steer that from the subnet's zone.
    const region = config.subnets?.[0]?.networkZone;
    if (region) client.setDefaultRegion(region);
    const svc = new InfraOvhProviderService(this.configService, client);
    const result = await svc.createVNet(config);
    // `region` here is a macro like 'GRA', not a specific datacenter — the
    // caller (vnet-provisioning.service.ts) only ever knows the macro. Left
    // unresolved, this used to hand that literal macro straight to
    // clearSubnetGateway() as if it were the resolved region: on this
    // account's network-service catalog that fuzzy-matched to a different
    // datacenter (WAW1) than the one createVNet() actually created the
    // subnet in (GRA11) — a live-confirmed 404. Route it through the same
    // resolver createVNet() itself uses, on the same client (already primed
    // above via setDefaultRegion), so both land on the same datacenter.
    const resolvedRegion = await client.resolveNetworkRegion(region);
    await Promise.all(
      result.subnets.map((subnet) =>
        client
          .clearSubnetGateway(resolvedRegion, subnet.id)
          .catch((e) =>
            this.logger.warn(
              `Failed to clear gateway on subnet ${subnet.id}: ${String(e)} — the node may pick up a second default route via this VNet.`,
            ),
          ),
      ),
    );
    return result;
  }

  async listVNets(): Promise<VNetDetails[]> {
    const svc = await this.delegate();
    return svc.listVNets();
  }

  async getVNet(vnetId: string): Promise<VNetDetails | null> {
    const svc = await this.delegate();
    return svc.getVNet(vnetId);
  }

  async deleteVNet(vnetId: string): Promise<VNetDeletionResult> {
    const svc = await this.delegate();
    return svc.deleteVNet(vnetId);
  }

  async addSubnet(config: AddSubnetConfig): Promise<{ actionId?: number }> {
    const svc = await this.delegate();
    return svc.addSubnet(config);
  }

  async deleteSubnet(
    config: DeleteSubnetConfig,
  ): Promise<{ actionId?: number }> {
    const svc = await this.delegate();
    return svc.deleteSubnet(config);
  }

  async attachServerToVNet(
    config: AttachServerToVNetConfig,
  ): Promise<ServerVNetAttachmentResult> {
    const svc = await this.delegate();
    return svc.attachServerToVNet(config);
  }

  async detachServerFromVNet(
    config: DetachServerFromVNetConfig,
  ): Promise<{ actionId?: number }> {
    const svc = await this.delegate();
    return svc.detachServerFromVNet(config);
  }
}

/**
 * OVH reports raw Nova statuses ('ACTIVE', 'ERROR', uppercase); the
 * provider-agnostic wait loops in ServersService expect Hetzner/Scaleway's
 * vocabulary ('running', 'error'). Translate here so they work unmodified.
 */
export function normalizeOvhServerStatus(novaStatus: string): string {
  switch (novaStatus) {
    case 'ACTIVE':
      return 'running';
    case 'ERROR':
      return 'error';
    default:
      return novaStatus.toLowerCase();
  }
}

/** Same raw Nova vocabulary as normalizeOvhServerStatus, mapped to the enum listInstances()'s InstanceEntity needs instead. */
function mapOvhStatusToInstanceStatus(novaStatus: string): InstanceStatus {
  switch (novaStatus) {
    case 'ACTIVE':
      return InstanceStatus.RUNNING;
    case 'SHUTOFF':
    case 'PAUSED':
    case 'SUSPENDED':
      return InstanceStatus.STOPPED;
    case 'BUILD':
      return InstanceStatus.PROVISIONING;
    case 'REBOOT':
    case 'HARD_REBOOT':
      return InstanceStatus.STARTING;
    case 'RESIZE':
    case 'VERIFY_RESIZE':
    case 'REVERT_RESIZE':
    case 'REBUILD':
      return InstanceStatus.REBUILDING;
    case 'MIGRATING':
      return InstanceStatus.MIGRATING;
    case 'DELETED':
    case 'SOFT_DELETED':
      return InstanceStatus.DELETING;
    case 'ERROR':
      return InstanceStatus.ERROR;
    default:
      return InstanceStatus.UNKNOWN;
  }
}

/**
 * @flui-cloud/infra declares its own CloudProvider enum (nominally distinct
 * from Flui's, even though the values overlap) — its ServerResponseDto.provider
 * is typed against that enum, not ours. Re-stamp it with the local enum value
 * so the DTO satisfies flui-core's own ServerResponseDto type.
 */
function toLocalServerDto<T extends { provider: unknown }>(
  s: T,
): Omit<T, 'provider'> & { provider: CloudProvider } {
  return { ...s, provider: CloudProvider.OVH };
}

/**
 * The rest of Flui passes a Hetzner-style hyphenated slug (e.g.
 * 'ubuntu-24.04') as the default OS image for every provider. OVH's Glance
 * images are matched by @flui-cloud/infra as whitespace-separated words
 * against the real display name ('Ubuntu 24.04') — a slug with no spaces
 * never matches. Convert 'distro-version' to 'Distro version'; anything that
 * doesn't look like that slug shape (already has a space, say) passes through.
 */
function toOvhImageName(image?: string): string | undefined {
  if (!image || !/^[a-z]+-\S/.test(image)) return image;
  const [distro, ...rest] = image.split('-');
  return `${distro[0].toUpperCase()}${distro.slice(1)} ${rest.join('-')}`;
}
