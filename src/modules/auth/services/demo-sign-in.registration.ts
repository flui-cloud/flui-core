import {
  LoginPolicy,
  OidcProviderAdminClient,
} from '../../oidc/services/oidc-provider-admin.service';
import { ProviderConnection } from './demo-sign-in.core';

export const REGISTRATION_RECORD_KEY = 'flui.sandbox.self-registration';

/**
 * Written before Flui opens self-registration for a demo, with the settings it
 * found, so that switching the demo off undoes only what Flui changed.
 */
export interface SelfRegistrationRecord {
  openedAt: string;
  allowRegisterBefore: boolean;
  allowExternalIdpBefore: boolean;
  closedAt: string | null;
}

type RegistrationChanges = Partial<
  Record<'allowRegister' | 'allowExternalIdp', boolean>
>;

export function needsOpening(policy: LoginPolicy): boolean {
  return policy.isDefault || !policy.allowRegister || !policy.allowExternalIdp;
}

export function parseRegistrationRecord(
  raw: string | null,
): SelfRegistrationRecord | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SelfRegistrationRecord>;
    if (typeof parsed.openedAt !== 'string') return null;
    return {
      openedAt: parsed.openedAt,
      allowRegisterBefore: parsed.allowRegisterBefore === true,
      allowExternalIdpBefore: parsed.allowExternalIdpBefore === true,
      closedAt: parsed.closedAt ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * What to turn back off once the demo is over: only a setting that was off
 * before Flui opened it and is still on. An operator who closed it already, or
 * whose instance allowed it before the demo, is left alone.
 */
export function closingChanges(
  record: SelfRegistrationRecord | null,
  policy: LoginPolicy,
): RegistrationChanges | null {
  if (!record || record.closedAt) return null;
  const changes: RegistrationChanges = {};
  if (policy.isDefault) return changes;
  if (!record.allowRegisterBefore && policy.allowRegister) {
    changes.allowRegister = false;
  }
  if (!record.allowExternalIdpBefore && policy.allowExternalIdp) {
    changes.allowExternalIdp = false;
  }
  return changes;
}

export class DemoSelfRegistration {
  constructor(private readonly oidc: OidcProviderAdminClient) {}

  /** Opens self-registration when it is not open, remembering who opened it. */
  async open(conn: ProviderConnection, policy: LoginPolicy): Promise<void> {
    if (!needsOpening(policy)) return;
    const current = await this.read(conn);
    if (!current || current.closedAt) {
      await this.write(conn, {
        openedAt: new Date().toISOString(),
        allowRegisterBefore: policy.allowRegister,
        allowExternalIdpBefore: policy.allowExternalIdp,
        closedAt: null,
      });
    }
    await this.oidc.openSelfRegistration(conn.pat, conn.host, policy);
  }

  /**
   * Closes self-registration when Flui opened it. Connected sign-in providers
   * are kept; they only disappear from the sign-in page with external sign-in.
   * Returns the settings it turned off.
   */
  async close(conn: ProviderConnection): Promise<string[]> {
    const record = await this.read(conn);
    if (!record || record.closedAt) return [];
    const policy = await this.oidc.getLoginPolicy(conn.pat, conn.host);
    const changes = closingChanges(record, policy) ?? {};
    if (Object.keys(changes).length) {
      await this.oidc.writeLoginPolicy(conn.pat, conn.host, policy, changes);
    }
    await this.write(conn, { ...record, closedAt: new Date().toISOString() });
    return Object.keys(changes);
  }

  private async read(
    conn: ProviderConnection,
  ): Promise<SelfRegistrationRecord | null> {
    return parseRegistrationRecord(
      await this.oidc.findOrgMetadata(
        conn.pat,
        conn.host,
        REGISTRATION_RECORD_KEY,
      ),
    );
  }

  private async write(
    conn: ProviderConnection,
    record: SelfRegistrationRecord,
  ): Promise<void> {
    await this.oidc.setOrgMetadata(
      conn.pat,
      conn.host,
      REGISTRATION_RECORD_KEY,
      JSON.stringify(record),
    );
  }
}
