import { BadRequestException } from '@nestjs/common';
import type { ApplicationEntity } from '../entities/application.entity';

type Owned = Pick<
  ApplicationEntity,
  'slug' | 'userId' | 'projectId' | 'k8sNamespace'
>;

/** Slugs a person may not choose, because platform objects in an application's namespace are named after them. */
export const RESERVED_SLUG_PREFIXES = ['kopia-'] as const;

export function reservedSlugRefusal(slug: string | undefined): string | null {
  const reserved = RESERVED_SLUG_PREFIXES.find((p) => slug?.startsWith(p));
  return reserved
    ? `a slug cannot start with "${reserved}": the platform names its own objects that way`
    : null;
}

const sameOwner = (a: Owned, b: Owned) =>
  (!!a.userId && a.userId === b.userId) ||
  (!!a.projectId && a.projectId === b.projectId);

/**
 * Which Secrets an application may read. Its namespace also holds what the
 * platform puts there — the reflected wildcard certificate, backup job
 * credentials, pull secrets — so a reference is honoured only when it names the
 * Secret of an application in the same namespace with the same owner or
 * project (`<slug>-secret`, how every application's own Secret is named), and
 * a companion may name only Secrets of its own application.
 */
export function secretReferenceProblems(
  app: Owned & Pick<ApplicationEntity, 'env' | 'companions'>,
  neighbours: Owned[],
): string[] {
  const readable = new Set(
    [
      app,
      ...neighbours.filter(
        (n) => n.k8sNamespace === app.k8sNamespace && sameOwner(n, app),
      ),
    ].map((n) => `${n.slug}-secret`),
  );
  const problems: string[] = [];
  for (const e of app.env ?? []) {
    const name = e.externalSecretRef?.secretName;
    if (name && !readable.has(name)) {
      problems.push(
        `variable ${e.name} reads the Secret "${name}", which is not one of your applications'`,
      );
    }
  }
  const own = (name: string) =>
    name.replaceAll('{{SLUG}}', app.slug).startsWith(`${app.slug}-`);
  const companions = app.companions;
  for (const s of [
    ...(companions?.initContainers ?? []),
    ...(companions?.sidecars ?? []),
  ]) {
    for (const e of s.env ?? []) {
      if (e.secretRef?.name && !own(e.secretRef.name)) {
        problems.push(
          `companion ${s.name} reads the Secret "${e.secretRef.name}", which is not this application's`,
        );
      }
    }
  }
  for (const v of companions?.volumes ?? []) {
    if (v.secret?.secretName && !own(v.secret.secretName)) {
      problems.push(
        `companion volume ${v.name} mounts the Secret "${v.secret.secretName}", which is not this application's`,
      );
    }
  }
  return problems;
}

export function assertSecretReferences(
  app: Parameters<typeof secretReferenceProblems>[0],
  neighbours: Owned[],
): void {
  const problems = secretReferenceProblems(app, neighbours);
  if (problems.length) {
    throw new BadRequestException(
      `This application cannot be deployed as it is: ${problems.join('; ')}`,
    );
  }
}
