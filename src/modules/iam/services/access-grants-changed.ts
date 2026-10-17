const listeners = new Set<() => void>();

/** Run `listener` whenever a role binding or a group is written in this process. */
export function onAccessGrantsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Say that bindings or groups were just written, so remembered access is dropped. */
export function accessGrantsChanged(): void {
  for (const listener of listeners) listener();
}
