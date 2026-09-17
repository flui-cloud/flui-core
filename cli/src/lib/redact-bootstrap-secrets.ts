/**
 * Everything a bootstrap script carries has to reach the host. None of it has
 * to survive on the operator's disk afterwards — and what accumulated there was
 * not one cluster's secrets but every cluster's, going back as far as the
 * machine did: provider API keys that spend money and delete infrastructure,
 * the installation's encryption key, its JWT secret, its database passwords.
 *
 * So the values are replaced and the names are kept. "Was this variable set,
 * and was it empty" is the question a debug copy exists to answer; the value
 * never is.
 */
const SECRET_NAME = /(SECRET|PASSWORD|KEY|TOKEN|MASTERKEY|CREDENTIAL)/;

export function redactBootstrapSecrets(script: string): string {
  return script.replace(
    /export ([A-Z0-9_]+)='([\s\S]*?)'\n/g,
    (whole, name: string, value: string) => {
      if (!SECRET_NAME.test(name)) return whole;
      // A public key is published by design, and redacting it would cost the
      // one reader of this file the ability to check which CA a host was given.
      if (name.endsWith('_PUBLIC_KEY')) return whole;
      return `export ${name}='${value.length ? '<redacted>' : ''}'\n`;
    },
  );
}

/**
 * Set to any non-empty value to keep a redacted copy of each generated
 * bootstrap script under `~/.flui/debug/<clusterId>/`.
 */
export const DEBUG_SCRIPTS_ENV = 'FLUI_DEBUG_SCRIPTS';
