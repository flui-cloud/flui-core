import * as crypto from 'node:crypto';

/**
 * The identity provider's sign-in pages and emails name the product behind
 * them. Flui sets the organisation's own texts so that every page and email a
 * person sees says Flui, and fixes the few translations that read wrong.
 */

export type ProviderTexts = Record<string, unknown>;

export interface TextPlan {
  body: Record<string, unknown>;
  changed: string[];
}

interface Override {
  from: string;
  to: string;
}

/** `language → screen → field`, applied only while the text is still the provider's wording. */
export const LOGIN_TEXT_OVERRIDES: Record<
  string,
  Record<string, Record<string, Override>>
> = {
  it: {
    loginText: {
      registerButtonText: { from: 'registrare', to: 'Registrati' },
    },
    initPasswordText: {
      resendButtonText: { from: 'codice di reinvio', to: 'Reinvia codice' },
    },
    initPasswordDoneText: {
      title: { from: 'Set di password', to: 'Password impostata' },
    },
    emailVerificationText: {
      resendButtonText: { from: 'codice di reinvio', to: 'Reinvia codice' },
    },
    emailVerificationDoneText: {
      title: { from: 'Verificazione email effettuata', to: 'Email verificata' },
    },
    initMfaOtpText: {
      title: {
        from: 'Verificazione a due fattori',
        to: 'Verifica a due fattori',
      },
    },
    verifyMfaOtpText: {
      title: { from: 'Verificazione fattore', to: 'Verifica del fattore' },
    },
    verifyMfaU2fText: {
      title: { from: 'Verificazione fattore', to: 'Verifica del fattore' },
    },
    registrationOptionText: {
      externalLoginDescription: {
        from: 'o registrarsi con un utente esterno',
        to: 'o registrati con un utente esterno',
      },
    },
  },
};

/** Path segments of `/management/v1/text/message/{type}/{language}`. */
export const MESSAGE_TEXT_TYPES = [
  'init',
  'passwordreset',
  'verifyemail',
  'verifyphone',
  'verifysmsotp',
  'verifyemailotp',
  'domainclaimed',
  'passwordless_registration',
  'password_change',
  'invite_user',
] as const;

export type MessageTextType = (typeof MESSAGE_TEXT_TYPES)[number];

const MESSAGE_FIELDS = [
  'title',
  'preHeader',
  'subject',
  'greeting',
  'text',
  'buttonText',
  'footerText',
] as const;

const NOT_A_SCREEN = new Set(['details', 'linkingUserPromptText']);

// A web address or a DNS label such as `zitadel.com` keeps its name.
const PRODUCT_NAME = /(?<![\w./@-])zitadel(?![\w-]*\.[a-z])/gi;

export const LOGIN_TEXTS_REVISION = crypto
  .createHash('sha256')
  .update(
    JSON.stringify({
      name: PRODUCT_NAME.source,
      overrides: LOGIN_TEXT_OVERRIDES,
      messages: MESSAGE_TEXT_TYPES,
    }),
  )
  .digest('hex')
  .slice(0, 12);

export function brandText(value: string): string {
  return value.replace(PRODUCT_NAME, 'Flui');
}

function rewrite(
  language: string,
  screen: string,
  field: string,
  value: string,
): string {
  const override = LOGIN_TEXT_OVERRIDES[language]?.[screen]?.[field];
  const fixed = value.trim() === override?.from ? override.to : value;
  return brandText(fixed);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** An organisation without texts of its own is answered with the defaults, marked as such. */
function ownTexts(custom: ProviderTexts | null | undefined): ProviderTexts {
  const own = record(custom);
  return own.isDefault === true ? {} : own;
}

/**
 * What one group of texts should become. A field already set on the
 * organisation stays set, rewritten; a provider default is set only when the
 * rewrite changes it, so every other default keeps following the provider.
 * The provider treats a field left empty as "use the default", so a body that
 * leaves a field out never removes something the organisation had.
 */
function planFields(
  fields: string[],
  defaults: Record<string, unknown>,
  own: Record<string, unknown>,
  rewriteField: (field: string, value: string) => string,
  prefix: string,
  changed: string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of fields) {
    const current = text(own[field]);
    const standard = text(defaults[field]);
    const wanted = rewriteField(field, current || standard);
    const send = current || wanted !== standard ? wanted : '';
    if (send) out[field] = send;
    if (send !== current) changed.push(`${prefix}${field}`);
  }
  return out;
}

function stringFields(...sources: Record<string, unknown>[]): string[] {
  const keys = new Set<string>();
  for (const source of sources) {
    for (const [key, value] of Object.entries(source)) {
      if (typeof value === 'string') keys.add(key);
    }
  }
  return [...keys];
}

/** The body for `PUT /management/v1/text/login/{language}`, or `null` when nothing would change. */
export function planLoginTexts(
  language: string,
  defaults: ProviderTexts,
  custom: ProviderTexts | null | undefined,
): TextPlan | null {
  const standard = record(defaults);
  const own = ownTexts(custom);
  const screens = new Set(
    [...Object.keys(standard), ...Object.keys(own)].filter(
      (key) =>
        !NOT_A_SCREEN.has(key) &&
        (Object.keys(record(standard[key])).length > 0 ||
          Object.keys(record(own[key])).length > 0),
    ),
  );
  const body: Record<string, unknown> = {};
  const changed: string[] = [];
  for (const screen of screens) {
    const d = record(standard[screen]);
    const o = record(own[screen]);
    const fields = planFields(
      stringFields(d, o),
      d,
      o,
      (field, value) => rewrite(language, screen, field, value),
      `${screen}.`,
      changed,
    );
    if (Object.keys(fields).length) body[screen] = fields;
  }
  return changed.length ? { body, changed } : null;
}

/** The body for `PUT /management/v1/text/message/{type}/{language}`, or `null` when nothing would change. */
export function planMessageText(
  defaults: ProviderTexts,
  custom: ProviderTexts | null | undefined,
): TextPlan | null {
  const standard = record(defaults);
  const own = ownTexts(custom);
  const fields = MESSAGE_FIELDS.filter(
    (field) => field in standard || field in own,
  );
  const changed: string[] = [];
  const body = planFields(
    fields,
    standard,
    own,
    (_field, value) => brandText(value),
    '',
    changed,
  );
  return changed.length ? { body, changed } : null;
}
