import { OpenStackClient } from '@flui-cloud/infra';

/**
 * OVH's block storage is Cinder — the same OpenStack Keystone token already
 * used for Nova/Neutron authorizes it too, just against a third catalog
 * entry. Subclasses @flui-cloud/infra's OpenStackClient (rather than
 * reimplementing auth) to add the Cinder + Nova volume-attachment surface it
 * doesn't cover yet.
 */
const CINDER_SERVICE_TYPE = 'volumev3';

export interface CinderVolumeAttachment {
  id: string;
  server_id: string;
  device: string;
  attachment_id: string;
}

export interface CinderVolume {
  id: string;
  name: string;
  size: number;
  status: string;
  availability_zone?: string;
  metadata?: Record<string, string>;
  attachments: CinderVolumeAttachment[];
  created_at?: string;
}

export interface NovaVolumeAttachment {
  id: string;
  volumeId: string;
  serverId: string;
  device: string;
}

export class FluiOpenStackClient extends OpenStackClient {
  /**
   * @flui-cloud/infra's createVNet() resolves its region with no location
   * hint at all (unlike createServer, which takes one) — it always falls
   * back to this client's configured default region. Setting it just before
   * delegating is how callers steer which region a VNet lands in.
   */
  setDefaultRegion(region: string): void {
    this.config.defaultRegion = region;
  }

  // ── Cinder (block storage) ──

  async listVolumes(region: string): Promise<CinderVolume[]> {
    const cinder = await this.endpoint(CINDER_SERVICE_TYPE, region);
    const body = await this.get<{ volumes: CinderVolume[] }>(
      `${cinder}/volumes/detail`,
    );
    return body.volumes ?? [];
  }

  async getVolume(
    region: string,
    volumeId: string,
  ): Promise<CinderVolume | null> {
    const cinder = await this.endpoint(CINDER_SERVICE_TYPE, region);
    try {
      const body = await this.get<{ volume: CinderVolume }>(
        `${cinder}/volumes/${volumeId}`,
      );
      return body.volume ?? null;
    } catch (e) {
      if (e instanceof Error && e.message.includes('404')) return null;
      throw e;
    }
  }

  async createVolume(
    region: string,
    spec: { name: string; sizeGb: number; metadata?: Record<string, string> },
  ): Promise<CinderVolume> {
    const cinder = await this.endpoint(CINDER_SERVICE_TYPE, region);
    const body = await this.post<{ volume: CinderVolume }>(
      `${cinder}/volumes`,
      {
        volume: {
          name: spec.name,
          size: spec.sizeGb,
          ...(spec.metadata ? { metadata: spec.metadata } : {}),
        },
      },
    );
    return body.volume;
  }

  async deleteVolume(region: string, volumeId: string): Promise<void> {
    const cinder = await this.endpoint(CINDER_SERVICE_TYPE, region);
    await this.del(`${cinder}/volumes/${volumeId}`);
  }

  async extendVolume(
    region: string,
    volumeId: string,
    newSizeGb: number,
  ): Promise<void> {
    const cinder = await this.endpoint(CINDER_SERVICE_TYPE, region);
    await this.post(`${cinder}/volumes/${volumeId}/action`, {
      'os-extend': { new_size: newSizeGb },
    });
  }

  /** Cinder creates asynchronously; a volume must reach 'available' before it can be attached. */
  async waitForVolumeAvailable(
    region: string,
    volumeId: string,
    timeoutMs = 60_000,
    pollIntervalMs = 2_000,
  ): Promise<CinderVolume> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const volume = await this.getVolume(region, volumeId);
      if (volume?.status === 'available') return volume;
      if (volume?.status === 'error') {
        throw new Error(`OVH volume ${volumeId} entered status 'error'`);
      }
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
    throw new Error(
      `OVH volume ${volumeId} did not become available within ${timeoutMs}ms`,
    );
  }

  // ── Nova volume attachments (join/leave a volume to a server) ──

  async listServerVolumeAttachments(
    region: string,
    serverId: string,
  ): Promise<NovaVolumeAttachment[]> {
    const nova = await this.endpoint('compute', region);
    const body = await this.get<{
      volumeAttachments: {
        id: string;
        volumeId: string;
        serverId: string;
        device: string;
      }[];
    }>(`${nova}/servers/${serverId}/os-volume_attachments`);
    return (body.volumeAttachments ?? []).map((a) => ({
      id: a.id,
      volumeId: a.volumeId,
      serverId: a.serverId,
      device: a.device,
    }));
  }

  async attachVolumeToServer(
    region: string,
    serverId: string,
    volumeId: string,
  ): Promise<NovaVolumeAttachment> {
    const nova = await this.endpoint('compute', region);
    const body = await this.post<{
      volumeAttachment: {
        id: string;
        volumeId: string;
        serverId: string;
        device: string;
      };
    }>(`${nova}/servers/${serverId}/os-volume_attachments`, {
      volumeAttachment: { volumeId },
    });
    const a = body.volumeAttachment;
    return {
      id: a.id,
      volumeId: a.volumeId,
      serverId: a.serverId,
      device: a.device,
    };
  }

  async detachVolumeFromServer(
    region: string,
    serverId: string,
    attachmentId: string,
  ): Promise<void> {
    const nova = await this.endpoint('compute', region);
    await this.del(
      `${nova}/servers/${serverId}/os-volume_attachments/${attachmentId}`,
    );
  }
}
