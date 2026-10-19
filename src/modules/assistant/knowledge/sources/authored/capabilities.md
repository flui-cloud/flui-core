---
title: What Flui does and does not do
description: 'Short, verified answers to the questions people ask before and after installing: providers, machines, operating systems, ARM, failover, apps across clusters, high availability, deploy sources, and how long things take.'
---

<!--
Hand-curated page for the assistant knowledge base (kb v2, see
internal-docs/ai/kb-v2-design.md). Every claim carries its evidence in an
HTML comment: docs paths are relative to flui-docs/src/content/docs, code paths
to the repo named. Verified on 2026-10-19 against flui-core 0dc5c07,
flui-docs 2910f64 (with local edits), bootstrap-scripts 8231774.
kb-build strips HTML comments before chunking, so the evidence never reaches
the model. Re-verify every line at each release; delete a line rather than
guess.
-->

Flui is in alpha. This page answers the questions where a wrong "yes"
does the most damage. When something here is "not yet", say so plainly
and point to the page that explains it.

<!-- docs: concepts/00-what-is-flui.mdx:259 ("Flui is in **alpha**") -->

## Where Flui can run

- **Cloud providers Flui buys machines on:** Hetzner, Scaleway and
  OVHcloud, all billed by the hour.
  <!-- docs: concepts/01-flui-vs-provider-layer.md:189-194 (provider table) -->
  <!-- code: flui-core cli/src/commands/env/create.ts:80 (`--provider` options: hetzner, scaleway, ovh) -->
- **Your own server:** any Linux machine you reach over SSH, installed
  with `flui env create --host <address>`. A VPS rented from a provider
  Flui does not integrate counts as your own server.
  <!-- docs: concepts/00-what-is-flui.mdx:140-146, tasks/get-flui-running.mdx:66-71 -->
- **No other cloud is integrated today.** AWS, Google Cloud, Azure and
  DigitalOcean are not providers Flui can buy machines on; a VM rented
  there can still be used as your own server.
  <!-- docs: concepts/01-flui-vs-provider-layer.md:189-194 lists only Hetzner, Scaleway, OVHcloud and own servers; concepts/00-what-is-flui.mdx:144-146 (any rented VPS counts as own server) -->
- **Differences between providers matter.** OVHcloud has no DNS zone
  Flui can manage and no edge firewall Flui controls, so names go in a
  zone on Hetzner or Scaleway (or records you write) and the firewall
  runs on the machines. On your own servers Flui buys nothing, has no
  DNS zone and applies the firewall on the host.
  <!-- docs: concepts/00-what-is-flui.mdx:133-141, concepts/01-flui-vs-provider-layer.md:193-194 -->
- **Resizing or stopping a node in place** works on Hetzner and
  Scaleway, not on OVHcloud, where growing a node means replacing it.
  <!-- docs: concepts/01-flui-vs-provider-layer.md:201-204 -->
- **Server snapshots and provider load balancers** are not driven by
  Flui on any provider. Incoming traffic goes through Flui's own proxy
  on your nodes.
  <!-- docs: concepts/01-flui-vs-provider-layer.md:223-227 -->

## Operating system and CPU architecture

- **Operating system:** Ubuntu 22.04 or 24.04. The installer stops on
  any other distribution or Ubuntu version. Machines Flui creates on a
  provider run Ubuntu 24.04 LTS.
  <!-- code: bootstrap-scripts scripts/flui-init.sh:61-72 (ID must be ubuntu, VERSION_ID 22.04|24.04) -->
  <!-- docs: concepts/02-why-k3s.md:61,89-92; tasks/get-flui-running.mdx:71 -->
- **ARM:** a 64-bit ARM machine you bring is accepted (x86_64, aarch64
  and arm64 pass the installer check). Machines Flui buys on a provider
  are x86_64; ARM sizes are filtered out of the list.
  <!-- code: bootstrap-scripts scripts/flui-init.sh:74-77 -->
  <!-- docs: concepts/02-why-k3s.md:69-79 -->
- **On an ARM server, catalog apps run normally, but apps deployed from
  a repository are built for x86 and will not run on it.** Flui warns
  about this when an ARM server is chosen.
  <!-- code: flui-core src/modules/providers/core/catalogue/server-architecture.ts:17-18 (ARM_SERVER_WARNING) -->
- **Memory:** the install precheck on your own server warns below about
  2 GB of RAM and stops unless you pass `--best-effort`.
  <!-- code: flui-core cli/src/commands/env/create.ts:262-274 (memMb < 1800 → problem; error unless bestEffort) -->

## How long things take

- **Installing the platform:** about five minutes, depending on the
  machine and its network.
  <!-- docs: concepts/00-what-is-flui.mdx:111; flui-core README.md:68 -->
- No other timing is promised on this page. For a specific operation,
  say it runs in the background and can be followed (operation status,
  dashboard progress), rather than quoting a duration.

## Clusters

- **One installation, one control cluster, any number of workload
  clusters.** Workload clusters can be on the same provider as the
  control cluster or on another one, joined over the encrypted Flui
  network (on by default).
  <!-- docs: concepts/05-multi-cluster-topology.mdx:107-113,223-229; concepts/00-what-is-flui.mdx:113-121 -->
- **One master per cluster.** Flui does not add more masters
  (multi-master) yet. While a cluster's master is down, its apps keep
  answering but nothing new can be deployed on that cluster.
  <!-- docs: concepts/02-why-k3s.md:96-99; concepts/31-high-availability.mdx:15-20,60-80 -->
- **A cluster adds machines by itself only where Flui can buy them.**
  On your own servers it raises an alarm naming the machine to add; you
  add capacity by hand (`flui node connect --host <ip>`).
  <!-- docs: concepts/00-what-is-flui.mdx:148-153,177-183; tasks/let-a-cluster-buy-its-own-machines.mdx:516 -->

## Applications across clusters

- **An application lives on one cluster at a time.** It is not spread
  over several clusters.
  <!-- docs: concepts/16-the-app-concept.mdx:29-33 -->
  <!-- code: flui-core src/modules/applications/entities/application.entity.ts:83 (single clusterId) -->
- **Flui does not connect applications across clusters.** Workload
  clusters share no state and Flui offers no app-to-app path between
  them. A catalog app that reuses an existing database requires it on
  the same cluster.
  <!-- docs: concepts/05-multi-cluster-topology.mdx:214-221 -->
  <!-- code: flui-core src/modules/catalog/services/catalog-dependency-resolver.service.ts:84-86 (REUSE_EXISTING must be RUNNING on the same cluster) -->
- **Databases, caches and queues from the catalog are reachable only
  inside their own cluster.** To reach one from your machine, Flui opens
  a tunnel for you.
  <!-- docs: concepts/16-the-app-concept.mdx:158-164 -->

## Failover and moving between providers

- **Flui does not fail over automatically between clusters or
  providers.** What it offers is a move you start and finish yourself:
  an application with its volumes, a Flui-managed PostgreSQL, or both
  together can be moved to another cluster, including one on another
  provider, with `flui migrate app`, `flui migrate db` or
  `flui migrate full`. The copy is built on the destination and the
  switch happens when you say so; you can abort before it.
  <!-- docs: concepts/05-multi-cluster-topology.mdx:122-130; concepts/31-high-availability.mdx (covers failures inside one installation only, no cross-cluster failover) -->
  <!-- code: flui-core cli/src/commands/migrate/{app,db,full}/{create,cutover,abort}.ts -->
- **A move needs** a real domain name (an address derived from the
  source cluster's IP cannot follow), an application that is
  self-contained, and both clusters in the same installation.
  <!-- docs: concepts/05-multi-cluster-topology.mdx:132-140 -->

## High availability inside a cluster

- **Apps with two or more copies on a cluster with two or more nodes
  keep answering when a worker is lost** (after about a minute).
  `flui app status` says whether an app survives losing a worker; it
  also needs a real domain and no volume tied to one node.
  <!-- docs: concepts/31-high-availability.mdx:24-55 -->
- **Catalog databases run as a single instance on one node.** If that
  node is lost the database is down until restored. PostgreSQL and
  MariaDB ship changes off the cluster continuously, so a restore loses
  at most the last few minutes.
  <!-- docs: concepts/31-high-availability.mdx:85-93 -->
- **Databases that survive the loss of their node are in progress, not
  available yet** (PostgreSQL first).
  <!-- docs: concepts/31-high-availability.mdx:97-99,163-166 -->

## Deploying applications

- **Three sources:** a container image, a source repository that Flui
  builds against a `flui.yaml` manifest, or an entry from the Flui
  catalog.
  <!-- docs: concepts/16-the-app-concept.mdx:34-40 -->
- **Repositories come from GitHub.** It is the only integration the CLI
  connects today.
  <!-- code: flui-core cli/src/commands/integration/connect.ts:55-59,84-85 (provider options: github only) -->

## Around the platform

- **Backups** are Flui's own and go to any S3-compatible bucket,
  including one at another provider.
  <!-- docs: concepts/01-flui-vs-provider-layer.md:213-216 -->
- **Email** goes through Scaleway Transactional Email, Brevo, ZeptoMail
  or an SMTP relay you configure.
  <!-- docs: tasks/send-mail.mdx:60-65 -->
- **The assistant's model** comes from Scaleway's inference service
  (reusing the Scaleway credential) or from any OpenAI-compatible
  endpoint you connect, such as OpenAI or Mistral.
  <!-- docs: concepts/23-inference-and-byo-llm.md:22-31,47-50 -->

## The public demo

- **A visitor can look at everything the demo shows, ask the assistant
  and connect an agent that only reads.** Deploying, installing from the
  catalog, connecting GitHub or keeping a space needs signing in.
  <!-- docs: tasks/look-around-the-demo.mdx:53-68 -->

## License

- Flui is open source under **AGPL-3.0**. Commercial use is allowed; if
  you offer Flui as a network service to others, you must share your
  changes to the source.
  <!-- docs: concepts/00-what-is-flui.mdx:263-266 -->

<!--
Left out on purpose (not verified well enough, or contradictory sources):
- Contabo: a provider module is registered in code
  (flui-core src/modules/providers/providers.module.ts:89) but `flui env create`
  does not offer it (create.ts:80) and the docs provider table omits it. Not
  stated either way until the author decides.
- Exact durations for cluster creation, deploys, migrations: no verified source.
- Docs say the precheck "stops on an architecture it does not support"
  (tasks/get-flui-running.mdx:240-241). The CLI precheck checks only memory and
  an existing install (create.ts:261-263); the architecture is refused by the
  installer (flui-init.sh:74-77). The page states the installer behaviour.
-->
