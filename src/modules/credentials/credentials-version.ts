let version = 0;

/**
 * Called wherever a credential is saved, rotated or removed. The credentials
 * status keeps a short cache per person, and a save elsewhere — in a module
 * that cannot depend on the status one — has to make it stale at once.
 */
export function markCredentialsChanged(): void {
  version += 1;
}

export function credentialsVersion(): number {
  return version;
}
