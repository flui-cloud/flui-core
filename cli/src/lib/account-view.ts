import type { AccountOverview } from './account-client';

const yesNo = (on: boolean): string => (on ? 'on' : 'off');

export function overviewLines(view: AccountOverview): string[] {
  const p = view.profile;
  const s = view.security;
  const name =
    p.displayName ??
    ([p.firstName, p.lastName].filter(Boolean).join(' ') || '-');
  const lines = [
    `Name          ${name}`,
    `First / last  ${p.firstName ?? '-'} / ${p.lastName ?? '-'}`,
    `Email         ${p.email ?? '-'}${p.email && !p.emailVerified ? ' (not verified)' : ''}`,
    `Username      ${p.userName}`,
    '',
    `Password      ${s.password ? 'set' : 'none (you sign in with a linked account)'}`,
    `Authenticator ${yesNo(s.totp)}`,
  ];
  lines.push(`Passkeys      ${s.passkeys.length ? '' : 'none'}`.trimEnd());
  for (const k of s.passkeys) lines.push(`  ${k.id}  ${k.name || '(unnamed)'}`);
  if (s.securityKeys.length) {
    lines.push('Security keys');
    for (const k of s.securityKeys) {
      lines.push(`  ${k.id}  ${k.name || '(unnamed)'}`);
    }
  }
  lines.push(`Linked        ${s.links.length ? '' : 'none'}`.trimEnd());
  for (const l of s.links) {
    lines.push(
      `  ${l.provider} (${l.externalUserName || l.externalUserId})  ${l.idpId} ${l.externalUserId}`,
    );
  }
  if (view.limits.guest) {
    lines.push(
      '',
      'During the trial the sign-in you entered with stays linked.',
    );
  }
  return lines;
}

/** Why a security change is refused here, and where it is made instead. */
export function securityInDashboard(what: string): string {
  return (
    `Changes to ${what} are made on the Account page of the dashboard, signed in as yourself. ` +
    'The CLI signs in with an API key, which can read your account and change your name, but not how it signs in.'
  );
}
