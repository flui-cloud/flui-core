import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  API_CONFIG,
  API_CONFIG_READER,
  ApiConfigReader,
} from './api-config-reader';
import {
  GUEST_INFERENCE_KEYS,
  GuestInferenceKey,
  GuestInferenceLimits,
  guestInferenceLimits,
} from './guest-inference-limits';

export const LIVE_CONFIG_TTL_MS = 30_000;

/**
 * The guest inference limits are the API's own environment variables, read
 * again from its configuration on the control cluster every 30 seconds, so an
 * operator can close or tighten guest inference during an attack without a
 * restart. A key missing there falls back to the process environment.
 */
@Injectable()
export class GuestInferenceSettingsService {
  private readonly logger = new Logger(GuestInferenceSettingsService.name);
  private cache: { data: Record<string, string>; at: number } | null = null;
  private loading: Promise<Record<string, string>> | null = null;

  constructor(
    private readonly config: ConfigService,
    @Inject(API_CONFIG_READER) private readonly readApiConfig: ApiConfigReader,
  ) {}

  async limits(now = Date.now()): Promise<GuestInferenceLimits> {
    const live = await this.liveValues(now);
    return guestInferenceLimits(
      (key: GuestInferenceKey) => live[key] ?? this.config.get<string>(key),
    );
  }

  private async liveValues(now: number): Promise<Record<string, string>> {
    if (this.cache && now - this.cache.at < LIVE_CONFIG_TTL_MS) {
      return this.cache.data;
    }
    this.loading ??= this.fetch(now).finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private async fetch(now: number): Promise<Record<string, string>> {
    let data: Record<string, string>;
    try {
      const all = await this.readApiConfig();
      data = Object.fromEntries(
        GUEST_INFERENCE_KEYS.filter((key) => key in all).map((key) => [
          key,
          all[key],
        ]),
      );
    } catch (error) {
      this.logger.warn(
        `Could not read the guest inference limits from ${API_CONFIG.name}, keeping the last known values: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      data = this.cache?.data ?? {};
    }
    this.cache = { data, at: now };
    return data;
  }
}
