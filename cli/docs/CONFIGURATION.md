# Flui CLI — Configuration Architecture

This document describes how the Flui CLI resolves configuration values, where they
are stored, and how to control which value wins when multiple sources are available.

> **Audience:** maintainers and power users. Day-to-day usage is covered by
> `flui config --help`, `flui config show`, and `flui config get <key>`.

## Overview

The CLI splits configuration into two storage areas with different rules:

| Area            | Stores                                              | Encryption  | Project override? |
| --------------- | --------------------------------------------------- | ----------- | ----------------- |
| **Token vault** | Cloud provider API tokens, the Flui API key         | AES-256-GCM | No                |
| **Preferences** | Non-secret user/project values (email, defaults, …) | Plain text  | Yes (read-only)   |

A single registry — the **preferences schema** — declares every non-secret key the
CLI knows about: its env var, its project-overridability, its default, and its
validator. New preferences are added in one file and any command can consume them
through the resolver without bespoke flag wiring.

## Resolution cascade (preferences only)

For every preference key, the resolver walks layers in this exact order and stops
at the first hit:

```
explicit (flag passed in code) > env var > project-local file > user-global file > default > missing
```

| Layer      | What it is                                                                           |
| ---------- | ------------------------------------------------------------------------------------ |
| `explicit` | A value passed directly to `resolver.resolve(key, explicit)` — usually a CLI flag.   |
| `env`      | The env var declared in the schema (e.g. `FLUI_EMAIL`, `FLUI_CERTIFICATE_MODE`).     |
| `project`  | `./flui.config.json` in the current working directory, if `projectOverridable`.      |
| `user`     | Active profile file at `~/.flui/profiles/<active>/config.json`, `preferences` block. |
| `default`  | The `defaultValue` in the schema, if any.                                            |
| `missing`  | None of the above produced a value.                                                  |

Token resolution does **not** use this cascade. Tokens are read only from the
active profile's encrypted vault. Env-var fallback exists only for the Flui API
key (`FLUI_API_KEY`), kept for CI ergonomics.

## File layout

```
~/.flui/
├── context                           # Active profile (plain text, one line)
├── vault.json                        # Vault header (salt, verifier; no key)
└── profiles/
    ├── default/
    │   ├── config.json               # tokens + apiKey + apiUrl + preferences (per profile)
    │   ├── encryption.key.sealed     # Key of the encrypted values in clusters.json, sealed by the vault
    │   ├── ca/                       # SSH CA: ca_key.sealed + ca_key.pub
    │   ├── ssh/                      # Flui's SSH key: id_rsa.sealed + id_rsa.pub
    │   └── ...
    └── <other-profile>/

./flui.config.json                    # Optional, project-local, committable
```

The active profile is determined by, in order: `FLUI_PROFILE` env var,
`~/.flui/context`, then `default`. Each profile is fully isolated — switching
profile swaps the entire vault, including preferences.

### `~/.flui/profiles/<active>/config.json`

Single file written and read by `ConfigStorage`. Top-level keys:

- `tokens.<provider>` — encrypted provider token + timestamps.
- `credentials.<provider>` — encrypted credential blobs (currently unused).
- `apiUrl` — Flui API URL the CLI talks to.
- `apiKey` — encrypted API key for M2M access (read fallback: `FLUI_API_KEY`).
- `preferences.<key>` — plain-text user preferences (no secrets here, ever).
- `metadata` — bookkeeping (`version`, `createdAt`, `updatedAt`).

The `preferences` block is the only area readable through the layered resolver.
Everything else is accessed directly by the storage layer.

### `./flui.config.json` (project-local override)

Optional. When present in the current working directory:

- It is **read-only** — the CLI never writes here automatically. You commit it
  to your repo to share defaults with your team.
- Only keys with `projectOverridable: true` in the schema are honored. Anything
  else is silently ignored.
- **Never put secrets here.** Provider tokens and the API key are explicitly
  rejected by the resolver.
- Malformed JSON throws loudly — config errors should not fail silently.

Example:

```json
{
  "email": "team@example.com",
  "certificateMode": "preflight",
  "apiPath": "../flui.api",
  "dashboardPath": "../flui.dashboard"
}
```

`apiPath` and `dashboardPath` let you run `flui env export-config` from any
directory (e.g. a parent monorepo root) — the CLI will write `.env` inside
`<apiPath>` and patch `<dashboardPath>/src/assets/config.json`. Defaults are
`.` for `apiPath` (cwd, preserves legacy behavior) and `../flui.dashboard`.

## The preferences schema

Source of truth: [`src/config/preferences-schema.ts`](../src/config/preferences-schema.ts).

Each entry declares:

| Field                | Purpose                                                             |
| -------------------- | ------------------------------------------------------------------- |
| `key`                | Stable identifier — also the JSON key in storage.                   |
| `description`        | One-line explanation shown in `flui config show` / prompts / help.  |
| `envVar`             | Env var name that overrides storage layers.                         |
| `projectOverridable` | When `true`, `./flui.config.json` may shadow the user-global value. |
| `defaultValue`       | Last-resort value before "missing".                                 |
| `required`           | When `true`, commands consuming this key must prompt or fail.       |
| `allowedValues`      | Optional enum used by validation and CLI option lists.              |
| `validate(value)`    | Custom validator returning an error message or `null`.              |

To add a new preference:

1. Add the entry to `PREFERENCES` in `preferences-schema.ts` (and to `PreferenceKey`).
2. Consume it in any command via `new PreferencesResolver().resolve('myKey')`.
3. Done. `flui config get/set/show` automatically know about it.

## Persistence

Prompts never persist by default. When a command resolves a preference and falls
through to the interactive prompt, the value is used **for that run only**. To
make it stick, pass `--save` (or set the value upfront with `flui config set`).
This avoids the surprise of "I answered once, now where does that value live?"

Explicit persistence happens through:

- `flui config set <key> <value>` — schema-dispatched: preferences go to the
  `preferences` block, providers go to the encrypted token vault.
- `flui config remove <key>` — schema-dispatched, mirror of `set`.
- Direct edit of `~/.flui/profiles/<active>/config.json` — supported, just don't
  touch encrypted fields.

Project-local persistence is intentionally manual: edit `./flui.config.json`
yourself. The CLI does not auto-write to it.

## Non-TTY behavior

In non-TTY contexts (CI, scripts), prompts fail with a clear message instead of
hanging on stdin. To run a command non-interactively, every required preference
must come from a flag, env var, project file, user-global file, or schema default.

## Commands reference

| Command                         | What it does                                                    |
| ------------------------------- | --------------------------------------------------------------- |
| `flui config show`              | Print every preference resolved through the cascade.            |
| `flui config get <key>`         | Print one preference + its source.                              |
| `flui config set <key> <value>` | Schema-dispatched: preference or provider token.                |
| `flui config remove <key>`      | Schema-dispatched: clear preference or remove token.            |
| `flui config list`              | Tokens + preferences. Filter with `--tokens` / `--preferences`. |

## Why this design

- **One schema, many commands.** Adding `--my-flag` to every command was the
  failure mode we're avoiding. New keys = one file edit.
- **Profiles are first-class.** Each profile is a complete sandbox; preferences
  live inside profiles, not above them.
- **Project file is override-only.** Reading sibling repos and shared team
  defaults belongs there. Writing belongs in the user vault.
- **Explicit persistence.** The CLI never silently saves answers from a prompt —
  `--save` documents intent at the call site.
- **Secrets stay encrypted.** Project files are committable; tokens are not.
  The router enforces the split mechanically.

## Cookbook

Concrete scenarios showing the layered config in action.

### 1. First-time setup

```text
$ flui config show
Configuration in use:
  email            <unset>            (missing)
  apiPath          .                  (default)
  dashboardPath    ../flui.dashboard  (default)
  certificateMode  staging            (default)
```

Nothing is set; defaults apply. `email` is `missing` — the next command that
needs it will prompt.

```text
$ flui config set email dawit@flui.cloud
Preference saved: email = dawit@flui.cloud

$ flui config set hetzner hzn_xxx_yyy_zzz
Provider configured: hetzner
Encryption: AES-256-GCM
```

The same `set` dispatches by key: `email` lands in the `preferences` block
(plain text), `hetzner` lands in `tokens` (AES-256-GCM). The schema decides,
not the user.

### 2. Inspecting which layer wins

```text
$ flui config get email
email = dawit@flui.cloud  (source: user)

$ FLUI_EMAIL=other@x.com flui config get email
email = other@x.com  (source: env)

$ flui config get hetzner
'hetzner' is a provider token; tokens are encrypted and not printable.
Use `flui config list --tokens` instead.
```

`get` always reports the source layer — the fastest way to debug "why is the
CLI using _that_ value?".

### 3. Project file as override

A monorepo root with sibling `flui.api` and `flui.dashboard`:

```text
$ cat ~/Project/flui/flui.config.json
{
  "apiPath": "/Users/dawit/Project/flui/flui.api",
  "dashboardPath": "/Users/dawit/Project/flui/flui.dashboard",
  "certificateMode": "preflight"
}

$ cd ~/Project/flui
$ flui config show
Configuration in use:
  email            dawit@flui.cloud                          (user)
  apiPath          /Users/dawit/Project/flui/flui.api        (project)
  dashboardPath    /Users/dawit/Project/flui/flui.dashboard  (project)
  certificateMode  preflight                                 (project)
  ↳ project file: /Users/dawit/Project/flui/flui.config.json
```

Project values shadow user-global where allowed. From any other directory
without a `flui.config.json` the values fall back to user-global / defaults.

### 4. `env export-config` at steady state

```text
$ cd ~/Project/flui
$ flui env export-config

📋 Exporting Cluster Configuration
   Cluster:    observability-prod
   Master IP:  162.55.56.10
…

Configuration in use:
  email            dawit@flui.cloud                          (user)
  apiPath          /Users/dawit/Project/flui/flui.api        (project)
  dashboardPath    /Users/dawit/Project/flui/flui.dashboard  (project)
  certificateMode  preflight                                 (project)

✓ .env file updated successfully
✓ Dashboard config updated (authMode=oidc, certificateMode=preflight)
```

Everything resolves from project file + user. Zero prompts, zero flags.
`.env` is written under `<apiPath>`, the dashboard `config.json` under
`<dashboardPath>/src/assets/`.

### 5. One-shot override via flag

```text
$ flui env export-config --certificate-mode production
Configuration in use:
  certificateMode  production  (flag)
  …
```

The flag wins over every layer. Not persisted — used only for this run.

### 6. CI / scripted override via env var

```text
$ FLUI_CERTIFICATE_MODE=production flui env export-config
Configuration in use:
  certificateMode  production  (env)
```

Same effect as the flag. Convenient in pipelines where injecting env vars is
easier than threading flags through wrappers.

### 7. Prompt + `--save`

Without `email` set anywhere, the first run prompts:

```text
$ flui env export-config
? Contact email used for ACME/Let's Encrypt …: dawit@flui.cloud

Configuration in use:
  email            dawit@flui.cloud   (explicit)
  …
  ↳ Pass --save to persist prompted/default values to ~/.flui/profiles/<active>/config.json
```

Used for this run only. To make it stick:

```text
$ flui env export-config --save
? Contact email …: dawit@flui.cloud

Configuration in use:
  email            dawit@flui.cloud   (user)
```

Now lives in the active profile's `config.json` and won't prompt again.

### 8. Switching profiles

```text
$ flui context list
* default
  prod

$ flui context use prod
Switched to profile 'prod'

$ flui config show
Configuration in use:
  email            ops@flui.cloud   (user)        ← different profile, different value
  certificateMode  production       (default)
```

Profiles are isolated sandboxes — each has its own preferences AND its own
encrypted vault. `flui context use default` switches back.

### 9. Non-TTY (CI) safety

```text
$ flui env export-config
Error: Missing required value for "Contact email …". Set it via flag,
env var, or `flui config set` — interactive prompts are disabled in
non-TTY mode.
```

In CI, prompts fail loudly instead of hanging. Provide every required value
upfront via env var, flag, or a committed `flui.config.json`.

### 10. Removing values

```text
$ flui config remove email
Removed preference: email

$ flui config remove hetzner
Warning: This will remove the API token for 'hetzner'
Type 'hetzner' to confirm: hetzner
Removed configuration for: hetzner
```

Same dispatch as `set`. Tokens require typing the provider name as a
deletion safeguard; preferences do not (they're plain text and easy to recreate).

### 11. Reaching the control when the Flui API does not answer

`flui ssh master` (and `flui ssh <control>/master`) needs neither the API nor the dashboard: the
control cluster is on this profile's record (`~/.flui/profiles/<profile>/clusters.json`), and the
five-minute SSH certificate is signed on this machine by the profile's SSH CA. What it does need:

- the vault unlocked (`flui vault unlock`), because the CA is sealed in it;
- the address you connect from allowed on port 22 of the control's firewall — if it changed, run
  `flui env update-firewall --add` first: it writes to the provider directly when the API does not
  answer, and brings Flui's saved rules in line on the next run;
- no older `flui` process still running from before a CLI update (`flui vault unlock` lists them):
  an old process can mint a CA the control does not trust.

Once in, start the Flui API again from the master's shell. Workload clusters are still looked up
through the API, since only the control is on this machine's record.

## Future work

- Per-key `flui config edit` opening `$EDITOR` on the right file.
- Read-only resolution shown by `flui config get <key> --explain` (full layer
  walk, not just the winning source).
- Project-local validator for unknown keys (warn instead of silently ignoring).
