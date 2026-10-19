# Flui Assistant — Knowledge Base

The assistant's knowledge is **baked**, not introspected. At T0 (no platform installed,
no MCP server) this is the _only_ source the assistant has, so it must be precise, versioned,
and human-auditable. Everything here is committed so behavior is predictable and reviewable.

## Layout

```
sources/      hand-authored + vendored snapshots (the inputs)
  guardrails.md                 — authored: identity, scope fence, version-awareness, no-invention, safety
  authored/capabilities.md      — authored: what Flui does and does not do (evidence in HTML comments, stripped at build)
  authored/dashboard-map.yaml   — authored: one entry per dashboard page (rendered by kb:dashboard-map)
  concepts/                     — vendored from flui-docs, .md and .mdx (kb:sync)
  tasks/                        — vendored from flui-docs task guides, .mdx (kb:sync)
  cli-prose/                    — vendored from flui-docs (kb:sync)
  flui-manifest.schema.json     — vendored from flui-spec (kb:sync)
  SOURCES.lock.json             — git refs of the vendored sources
generated/    derived, do not edit by hand
  cli-reference.generated.md    — from `oclif manifest` (kb:cli-ref) — ground truth for commands/flags
  dashboard-map.generated.md    — from authored/dashboard-map.yaml, checked against ../flui-dashboard (kb:dashboard-map)
  version-manifest.generated.json — version binding (kb:version)
dist/         compiled artifact consumed by the assistant
  kb.json                       — machine artifact (system context)
  kb.md                         — same content, one human-inspectable document
```

## Versioning

`kbVersion` is anchored to the **CLI version** (the CLI ships the KB). The compiled artifact
records a compatibility matrix — `{ cli, platform (image tags + bootstrap ref), spec apiVersion,
source git refs }` — so the assistant knows exactly which Flui it is talking to and can flag a
runtime mismatch (live platform vs. the matrix it was built against) instead of answering blind.

## Regenerate

```bash
pnpm kb            # sync → dashboard-map → cli-ref → version → build   (full pipeline)
# or individually:
pnpm kb:sync       # fetch concepts/cli prose + schema from flui-docs / flui-spec
pnpm kb:cli-ref    # render the CLI reference from `oclif manifest`
pnpm kb:version    # stamp the version manifest from release.config + cli/package.json + schema
pnpm kb:dashboard-map  # check the dashboard map against the dashboard checkout and render it
pnpm kb:build      # compile sources + generated → dist/kb.json + dist/kb.md
```

`kb:build` cleans MDX with `scripts/kb-mdx.ts` (imports dropped, tabs become `**Label:**`
lines, screenshot and diagram captions kept as text, HTML comments stripped outside code)
and fails on any component it does not know. Pages with `draft: true` are left out.
`kb-version.spec.ts` fails when `kb.json` disagrees with the CLI version, `RELEASE` or the
pinned `docsRef`, or lacks the task guides and authored pages.

Only `dist/kb.json` is committed; the fetched sources are gitignored working files.

**Source precedence (`kb:sync`):**

1. explicit `FLUI_DOCS_DIR` / `FLUI_SPEC_DIR` (a path you point at),
2. a sibling checkout `../flui-docs` / `../flui-spec` (auto-detected — local takes precedence),
3. the pinned ref in `KNOWLEDGE_SOURCES` (`release.config.ts`), fetched from the public repos.

Use `FLUI_KB_SOURCE=remote pnpm kb` to skip local and build the **canonical, reproducible**
`kb.json` from the pinned ref (do this for a committed/release artifact).

## What is NOT here (yet)

- Runtime injection of `dist/kb.json` as the assistant's system context (wires into
  `AssistantService`).
- `flui assist` — the CLI-native, T0 entry point that bundles this KB.
- Semantic retrieval / embeddings — deferred; injection is deterministic for predictability.
