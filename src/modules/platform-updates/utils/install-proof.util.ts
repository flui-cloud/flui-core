import { HeldFile } from '../services/manifest-master.service';
import { ReleaseFile } from '../services/bootstrap-files.service';
import {
  ImageTagSlot,
  InstallRecord,
  ProofFile,
  ProofResult,
  imageTagSlots,
  tagForSlot,
} from './install-values.util';
import {
  InstallTransforms,
  renderManifestFile,
  valuesDigest,
} from './manifest-render.util';
import { sha256 } from './manifest-eligibility.util';
import { byBytes } from './manifest-documents.util';

export type TemplatesByRef = Array<[string, ReleaseFile[]]>;

/** The files whose body a proof may restore: none that carries a Secret. */
export function provableNames(onMaster: Map<string, HeldFile>): string[] {
  return [...onMaster]
    .filter(([, h]) => !h.carriesSecret)
    .map(([n]) => n)
    .sort(byBytes);
}

export function proofFilesFor(
  onMaster: Map<string, HeldFile>,
  perRef: TemplatesByRef,
  record: InstallRecord | null,
): ProofFile[] {
  const raw = new Set(record?.transforms.raw ?? []);
  for (const [, files] of perRef) {
    for (const f of files) {
      if (f.set === 'common') raw.add(f.name);
    }
  }
  return provableNames(onMaster).map((name) => {
    const templates: ProofFile['templates'] = [];
    const seen = new Set<string>();
    for (const [ref, files] of perRef) {
      const file = files.find((f) => f.name === name);
      if (file && !seen.has(file.template)) {
        seen.add(file.template);
        templates.push({ ref, template: file.template });
      }
    }
    return {
      name,
      templates,
      masterSha: onMaster.get(name)?.sha ?? '',
      raw: raw.has(name),
    };
  });
}

/** The release that proved the most files. */
export function mostProvenRef(proof: ProofResult): string | null {
  const counts = new Map<string, number>();
  for (const f of proof.files) {
    if (f.proven && f.ref) counts.set(f.ref, (counts.get(f.ref) ?? 0) + 1);
  }
  let best: string | null = null;
  for (const [ref, n] of counts) {
    if (best === null || n > (counts.get(best) ?? 0)) best = ref;
  }
  return best;
}

export function templateSlots(perRef: TemplatesByRef): ImageTagSlot[] {
  return perRef.flatMap(([, files]) =>
    files.flatMap((f) => imageTagSlots(f.template)),
  );
}

/** Every candidate template of each file, across the refs tried. */
export function templatesByName(perRef: TemplatesByRef): Map<string, string[]> {
  const templates = new Map<string, string[]>();
  for (const [, files] of perRef) {
    for (const f of files) {
      templates.set(f.name, [...(templates.get(f.name) ?? []), f.template]);
    }
  }
  return templates;
}

/**
 * The values tried first: the record, the running tags, and every published
 * tag of the images behind the slots. No secret variable is a candidate.
 */
export function narrowCandidates(input: {
  recorded: Record<string, string>;
  running: Record<string, string>;
  slots: ImageTagSlot[];
  images: string[];
  secretVariables: ReadonlySet<string>;
}): Record<string, string[]> {
  const narrow: Record<string, string[]> = {};
  const add = (k: string, v: string | null | undefined) => {
    if (typeof v !== 'string' || input.secretVariables.has(k)) return;
    narrow[k] = [...(narrow[k] ?? []), v];
  };
  for (const [k, v] of Object.entries(input.recorded)) add(k, v);
  for (const [k, v] of Object.entries(input.running)) add(k, v);
  for (const slot of input.slots) {
    for (const image of input.images)
      add(slot.variable, tagForSlot(slot, image));
    add(slot.variable, 'latest');
  }
  return narrow;
}

/**
 * Image tags always come from what runs: the image phase moves the tag, and a
 * refresh must not move it back. A tag that could not be read is unproven.
 */
export function pinRunningTags(
  proof: Pick<ProofResult, 'values' | 'unproven'>,
  slots: ImageTagSlot[],
  running: Record<string, string>,
): { values: Record<string, string>; unproven: Record<string, string> } {
  const values = { ...proof.values };
  const unproven = { ...proof.unproven };
  for (const variable of new Set(slots.map((s) => s.variable))) {
    if (running[variable] !== undefined) {
      values[variable] = running[variable];
      delete unproven[variable];
    } else {
      delete values[variable];
      unproven[variable] = 'the image this installation runs could not be read';
    }
  }
  return { values, unproven };
}

/**
 * The recorded transforms, with the IngressRoute binding narrowed to the files
 * proven with it plus the recorded files the master does not hold.
 */
export function provenTransforms(
  recorded: InstallTransforms,
  provenIngressTlsFiles: string[],
  onMaster: Map<string, HeldFile>,
): InstallTransforms {
  const tls = recorded.ingressTls;
  return {
    raw: recorded.raw ?? [],
    ...(tls
      ? {
          ingressTls: {
            secretName: tls.secretName,
            files: [
              ...new Set([
                ...provenIngressTlsFiles,
                ...tls.files.filter((f) => !onMaster.has(f)),
              ]),
            ].sort(byBytes),
          },
        }
      : {}),
  };
}

export function contextDigest(
  values: Record<string, string>,
  transforms: InstallTransforms,
  flags: ReadonlySet<string>,
): string {
  return valuesDigest({
    ...values,
    '#tls': (transforms.ingressTls?.files ?? []).join(','),
    '#raw': (transforms.raw ?? []).join(','),
    '#flags': [...flags].sort(byBytes).join(','),
  });
}

/**
 * Adds to `contents` the body of every proven file whose rendering reproduces
 * the master's digest, and returns the files still pending.
 */
export function restoreProven(
  proof: ProofResult,
  pending: ProofFile[],
  ingressTls: { secretName: string },
  contents: Map<string, string>,
): ProofFile[] {
  for (const p of proof.files) {
    const file = pending.find((f) => f.name === p.name);
    const template = file?.templates.find((t) => t.ref === p.ref)?.template;
    if (!p.proven || !file || template === undefined) continue;
    const transforms = p.ingressTls
      ? { ingressTls: { ...ingressTls, files: [p.name] } }
      : {};
    const content = file.raw
      ? template
      : renderManifestFile(p.name, template, p.values ?? {}, transforms);
    if (sha256(content) === file.masterSha) contents.set(p.name, content);
  }
  return pending.filter((f) => !contents.has(f.name));
}

/** The master's files with a body only where one was restored. */
export function vouchedFiles(
  held: Map<string, HeldFile>,
  contents: Map<string, string>,
): Map<string, HeldFile> {
  const out = new Map<string, HeldFile>();
  for (const [name, h] of held) {
    if (h.carriesSecret) {
      out.set(name, { sha: h.sha, carriesSecret: true });
    } else if (contents.has(name)) {
      out.set(name, {
        sha: h.sha,
        carriesSecret: false,
        content: contents.get(name),
      });
    } else {
      out.set(name, {
        sha: h.sha,
        carriesSecret: false,
        withheld: true,
        declaresProvenance: h.declaresProvenance ?? false,
      });
    }
  }
  return out;
}

export function reconstructionReason(
  record: InstallRecord | null,
  provenCount: number,
): string | undefined {
  if (record) {
    return `This installation already has a record, written by the ${record.source === 'installer' ? 'installer' : 'reconstruction'}; nothing is written over it.`;
  }
  if (provenCount === 0) {
    return 'No file on the master could be reproduced from any published release, so nothing is proven and nothing would be written.';
  }
  return undefined;
}
