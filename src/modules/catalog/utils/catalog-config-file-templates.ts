const ADDRESS_FIELDS = new Set(['host', 'fqdn']);
const APP_FIELDS = new Set(['id', 'slug', 'domain', 'namespace']);

function isAddress(path: string[]): boolean {
  const [root, ...rest] = path;
  if (root === 'components') {
    return rest.length === 2 && ADDRESS_FIELDS.has(rest[1]);
  }
  if (root === 'self') return rest.length === 1 && ADDRESS_FIELDS.has(rest[0]);
  if (root === 'app') return rest.length === 1 && APP_FIELDS.has(rest[0]);
  return false;
}

function placeholdersIn(content: string): string[] {
  const found: string[] = [];
  let from = content.indexOf('{{');
  while (from !== -1) {
    const end = content.indexOf('}}', from + 2);
    if (end === -1) break;
    found.push(content.slice(from + 2, end));
    from = content.indexOf('{{', end + 2);
  }
  return found;
}

/** Config files of composed components may name addresses, never variables. */
export function configFileTemplateProblems(
  components: Array<{ configFiles?: Array<{ path: string; content: string }> }>,
): string[] {
  const problems: string[] = [];
  components.forEach((c, i) => {
    (c.configFiles ?? []).forEach((f, j) => {
      for (const placeholder of placeholdersIn(f.content)) {
        const path = placeholder.trim();
        if (!isAddress(path.split('.'))) {
          problems.push(
            `spec.components[${i}].configFiles[${j}] (${f.path}) reads "${path}": config files may only name components.<name>.host|fqdn, self.host|fqdn or app.id|slug|domain|namespace`,
          );
        }
      }
    });
  });
  return problems;
}
