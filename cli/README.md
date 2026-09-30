# @flui-cloud/cli

Command-line interface for [Flui](https://flui.cloud) — the open
platform layer on top of your cloud provider. Create clusters, deploy
applications from a `flui.yaml` manifest, switch between installations,
and operate the lifecycle end to end from one binary.

Full reference: **[docs.flui.cloud/cli](https://docs.flui.cloud/cli/)**.

## Install

```bash
npm install -g @flui-cloud/cli       # or: pnpm add -g, yarn global add
flui --version
```

To upgrade later, run `flui update` — it self-replaces the global
install with the latest published version.

## Quickstart

Flui is a modern, multi-cloud platform layer that turns plain cloud
servers into a full application platform — you keep ownership of the
infrastructure, no vendor lock-in. Create your installation in one
interactive command — it asks for an admin email and a credential for
one of the supported cloud providers (Hetzner and Scaleway today;
more providers and bring-your-own-server installs on the roadmap),
then in a few minutes returns an environment ready to host
applications: cluster, ingress, TLS, identity, observability,
dashboard — already wired in.

```bash
flui env create
```

The command streams the install logs until the platform is reachable,
then prints the dashboard, API and OIDC URLs. The full walkthrough
lives at [Getting started](https://docs.flui.cloud/cli/getting-started/).

## What you can do next

Once the cluster is up, plenty works without any extra integration —
day-to-day operating the installation, inspecting resources, and
deploying pre-built apps:

```bash
flui auth login                              # OIDC against the freshly created installation

flui env status                              # control-cluster health, nodes, capacity
flui env credentials --test                  # print + probe the dashboard / API / OIDC / Grafana URLs

flui app list                                # all apps on the installation
flui app status <name>                       # rollout state, replicas, image
flui app logs <name> --tail 200              # recent logs
flui app metrics <name>                      # CPU / memory / network

flui deploy                                  # deploy a flui.yaml from the current directory
```

For source-built apps (`kind: Application`, built from a GitHub repo)
you also need to connect GitHub first — `flui integration connect github`
with a personal access token, the recommended setup — see
[Integrations](https://docs.flui.cloud/cli/integrations/).
Pre-built CatalogApps (`kind: CatalogApp`) skip all of that and deploy
straight from `flui deploy` against any public image registry. The
manifest reference is on [Deploy](https://docs.flui.cloud/cli/deploy/).

## Topics

Commands are grouped into topics; each verb has its own `--help`.

| Topic                          | What it does                                                                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `env`                          | Lifecycle of the **control cluster** — create, inspect, scale, destroy.                                                                     |
| `cluster` / `node`             | Workload-cluster destroy and worker-node add/remove/list.                                                                                   |
| `app`                          | Inspect, scale, restart, snapshot, redeploy, and delete applications; read logs, metrics, and crash reports.                                |
| `deploy` / `catalog`           | Deploy from a `flui.yaml` manifest; validate the manifest offline.                                                                          |
| `integration` / `repo`         | Connect GitHub (a personal access token, or the Flui GitHub App) and import repositories — prerequisites for the first source-built deploy. |
| `template`                     | Create a new repository from a Flui framework template.                                                                                     |
| `backup`                       | Manage backup destinations, policies, jobs, and restores.                                                                                   |
| `auth`                         | OIDC login and long-lived M2M API keys.                                                                                                     |
| `context` / `config`           | Profiles (isolated installations) and layered configuration.                                                                                |
| `server-types` / `ssh`         | List provider server sizes; SSH into a node.                                                                                                |
| `dev`                          | Helpers for Flui contributors (export secrets, SSH tunnel).                                                                                 |
| `dns` / `reconcile` / `update` | Maintenance utilities.                                                                                                                      |

Per-topic reference pages: see [docs.flui.cloud/cli](https://docs.flui.cloud/cli/).

## Common conventions

A handful of flags recur across the CLI:

- `-c, --cluster <name|id>` — target cluster explicitly. Auto-detected
  when only one is present.
- `-o, --output <format>` — `json` is always available for scripting;
  the human format is `text` or `table` depending on the command.
- `--no-wait` / `--detach` — return as soon as the job is queued.
- `-f, --force` / `-y, --yes` — skip confirmation on destructive
  operations.
- `--dry-run` — print what _would_ happen on a subset of mutating
  commands.

Commands that talk to the API print a short context banner before
running (active profile + API URL).

## Profiles on disk

The CLI keeps each installation's state under
`~/.flui/profiles/<name>/`. A profile holds the API token, the
encrypted credentials needed to talk to the provider, the SSH CA used
for cluster nodes, and the local inventory the profile knows about.
The path can be moved with the `FLUI_DIR` environment variable.

Switching between installations: `flui context use <name>`.

## Links

- **Documentation:** [docs.flui.cloud](https://docs.flui.cloud)
- **Project site:** [flui.cloud](https://flui.cloud)
- **Source / issues:** [github.com/flui-cloud/core](https://github.com/flui-cloud/core)
- **Manifest spec:** [`@flui-cloud/spec`](https://www.npmjs.com/package/@flui-cloud/spec) ([repo](https://github.com/flui-cloud/flui-spec))

## License

AGPL-3.0-or-later. See [`LICENSE`](./LICENSE).
