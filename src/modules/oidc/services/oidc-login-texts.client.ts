import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { resolveProviderBaseUrl } from './oidc-provider-admin.service';
import {
  MESSAGE_TEXT_TYPES,
  ProviderTexts,
  TextPlan,
  planLoginTexts,
  planMessageText,
} from './oidc-login-texts';

export interface LoginTextsResult {
  languages: number;
  updated: string[];
  failed: string[];
}

/** Sets the organisation's sign-in page and email texts in every language the provider supports. */
@Injectable()
export class OidcLoginTextsClient {
  private readonly logger = new Logger(OidcLoginTextsClient.name);

  constructor(private readonly http: HttpService) {}

  /** Throws when a language could not be written, so the caller records nothing and retries. */
  async apply(pat: string, hostHeader: string): Promise<LoginTextsResult> {
    const languages = await this.languages(pat, hostHeader);
    const result: LoginTextsResult = {
      languages: languages.length,
      updated: [],
      failed: [],
    };
    for (const language of languages) {
      const groups: Array<[string, () => Promise<boolean>]> = [
        [`login/${language}`, () => this.applyLogin(pat, hostHeader, language)],
        ...MESSAGE_TEXT_TYPES.map((type): [string, () => Promise<boolean>] => [
          `${type}/${language}`,
          () => this.applyMessage(pat, hostHeader, type, language),
        ]),
      ];
      // One at a time: parallel writes to the same organisation make the
      // provider answer 500 now and then.
      for (const [name, run] of groups) {
        try {
          if (await withRetry(run)) result.updated.push(name);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.warn(`Texts ${name} not set: ${message}`);
          result.failed.push(name);
        }
      }
    }
    if (result.failed.length) {
      throw new Error(
        `${result.failed.length} text group(s) not set: ${result.failed.slice(0, 5).join(', ')}`,
      );
    }
    return result;
  }

  private async applyLogin(
    pat: string,
    hostHeader: string,
    language: string,
  ): Promise<boolean> {
    const lang = encodeURIComponent(language);
    const [defaults, custom] = await Promise.all([
      this.get(pat, hostHeader, `/text/default/login/${lang}`),
      this.get(pat, hostHeader, `/text/login/${lang}`),
    ]);
    return this.put(
      pat,
      hostHeader,
      `/text/login/${lang}`,
      planLoginTexts(language, defaults, custom),
    );
  }

  private async applyMessage(
    pat: string,
    hostHeader: string,
    type: string,
    language: string,
  ): Promise<boolean> {
    const lang = encodeURIComponent(language);
    const [defaults, custom] = await Promise.all([
      this.get(pat, hostHeader, `/text/default/message/${type}/${lang}`),
      this.get(pat, hostHeader, `/text/message/${type}/${lang}`),
    ]);
    return this.put(
      pat,
      hostHeader,
      `/text/message/${type}/${lang}`,
      planMessageText(defaults, custom),
    );
  }

  private async languages(pat: string, hostHeader: string): Promise<string[]> {
    const read = async (url: string) => {
      const resp = await firstValueFrom(
        this.http.get(url, { headers: this.headers(pat, hostHeader) }),
      );
      return ((resp.data?.languages ?? []) as unknown[]).filter(
        (l): l is string => typeof l === 'string' && l.length > 0,
      );
    };
    const base = resolveProviderBaseUrl();
    try {
      return await read(`${base}/admin/v1/languages`);
    } catch {
      return read(`${base}/management/v1/languages`);
    }
  }

  private async get(
    pat: string,
    hostHeader: string,
    path: string,
  ): Promise<ProviderTexts> {
    const resp = await firstValueFrom(
      this.http.get(`${resolveProviderBaseUrl()}/management/v1${path}`, {
        headers: this.headers(pat, hostHeader),
      }),
    );
    return (resp.data?.customText ?? {}) as ProviderTexts;
  }

  private async put(
    pat: string,
    hostHeader: string,
    path: string,
    plan: TextPlan | null,
  ): Promise<boolean> {
    if (!plan) return false;
    await firstValueFrom(
      this.http.put(
        `${resolveProviderBaseUrl()}/management/v1${path}`,
        plan.body,
        { headers: this.headers(pat, hostHeader) },
      ),
    );
    return true;
  }

  private headers(pat: string, hostHeader: string): Record<string, string> {
    return {
      Authorization: `Bearer ${pat}`,
      'Content-Type': 'application/json',
      Host: hostHeader,
    };
  }
}

const RETRY_DELAYS_MS = [500, 2000];

async function withRetry<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      const status = (error as { response?: { status?: number } })?.response
        ?.status;
      if (!status || status < 500 || attempt >= RETRY_DELAYS_MS.length) {
        throw error;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, RETRY_DELAYS_MS[attempt]),
      );
    }
  }
}
