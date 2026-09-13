# Cloud Provider Capability Matrix

This document defines what Flui expects from a cloud provider and how it behaves when
a capability is absent. Use it to assess a new provider before starting integration.

All levels are considered **required** for full integration — none are optional.
A provider missing a level will have reduced functionality as described in the behavior table below.

See also [`PROVIDER_STANDARD.md`](PROVIDER_STANDARD.md) for a provider-agnostic capability manifesto.

---

## Capability Levels

### Level 1 — Base

Server lifecycle management. Without this a provider cannot be used at all.

| Capability           | Interface method                         |
| -------------------- | ---------------------------------------- |
| Create server        | `ICloudProvider.createServer()`          |
| Delete server        | `ICloudProvider.deleteServer()`          |
| Get server status    | `ICloudProvider.getServerStatus()`       |
| List servers         | `ICloudProvider.listServersAsDto()`      |
| Get server details   | `ICloudProvider.getServerDetailsAsDto()` |
| Health check         | `ICloudProvider.testConnection()`        |
| Resource labels/tags | `createServer(config.labels)`            |

---

### Level 2 — Hourly billing / Pay-as-you-go

The provider must support server creation **billed per hour** with no minimum commitment.
This is the economic prerequisite for autoscale: nodes are created on-demand and destroyed
when no longer needed — monthly-only billing makes autoscale cost-neutral at best.

| Requirement             | How to verify                                                |
| ----------------------- | ------------------------------------------------------------ |
| Hourly rate available   | `ICloudProvider.getNodeSizes()` returns `pricing.hourly > 0` |
| No minimum commitment   | Provider API allows delete at any time                       |
| Billing stops on delete | Confirmed by provider documentation                          |

> **Without this level**: autoscale is technically possible but economically inefficient.
> Flui will not restrict creation/deletion, but cost savings are not guaranteed.

---

### Level 3 — SSH Key Registry

SSH keys registered globally on the provider account, passed to servers at creation via `ssh_keys[]`.

| Capability     | Interface method                |
| -------------- | ------------------------------- |
| Create SSH key | `ICloudProvider.createSSHKey()` |
| Delete SSH key | `ICloudProvider.deleteSSHKey()` |
| Get SSH key    | `ICloudProvider.getSSHKey()`    |
| List SSH keys  | `ICloudProvider.listSSHKeys()`  |

> **Without this level**: the bootstrap public key is injected into `user_data` (cloud-init fallback).
> Cluster creation still works, but key rotation requires reprovisioning nodes.

---

### Level 4 — Firewall

Network-level firewalls applied to servers at creation or afterwards.

| Capability       | Interface method                          |
| ---------------- | ----------------------------------------- |
| Create firewall  | `IFirewallProvider.createFirewall()`      |
| Delete firewall  | `IFirewallProvider.deleteFirewall()`      |
| Apply to servers | `IFirewallProvider.applyToServers()`      |
| Update rules     | `IFirewallProvider.updateFirewallRules()` |

> **Without this level**: clusters are created without firewall rules.
> Port 6443 (K3s API) will be exposed to the internet — not recommended for production.

---

### Level 5 — DNS

Manage DNS zones and records for cluster domains.

| Capability    | Interface method              |
| ------------- | ----------------------------- |
| List zones    | `IDnsProvider.listZones()`    |
| Create record | `IDnsProvider.createRecord()` |
| Update record | `IDnsProvider.updateRecord()` |
| Delete record | `IDnsProvider.deleteRecord()` |

> **Without this level**: DNS is not managed by Flui. Users configure DNS manually.

---

### Level 6 — VNet / Private Network

Connect cluster nodes via private networking (no internet traffic between nodes).

| Capability    | Interface method                          |
| ------------- | ----------------------------------------- |
| Create VNet   | `INetworkProvider.createVNet()`           |
| Delete VNet   | `INetworkProvider.deleteVNet()`           |
| Attach server | `INetworkProvider.attachServerToVNet()`   |
| Detach server | `INetworkProvider.detachServerFromVNet()` |

> **Without this level**: nodes communicate over public IPs. K3s traffic is encrypted
> (WireGuard), but latency and egress costs may be higher.

---

### Level 7 — Power management

Start/stop individual servers without deleting them.

| Capability | Interface method                  |
| ---------- | --------------------------------- |
| Power on   | `ICloudProvider.powerOnServer()`  |
| Power off  | `ICloudProvider.powerOffServer()` |

> **Without this level**: power operations are not available via Flui API.

---

## Current capability matrix

| Provider | L1 Base | L2 Hourly | L3 SSH | L4 Firewall | L5 DNS | L6 VNet | L7 Power |
| -------- | :-----: | :-------: | :----: | :---------: | :----: | :-----: | :------: |
| Hetzner  |    ✓    |     ✓     |   ✓    |      ✓      |   ✓    |    ✓    |    ✓     |
| Scaleway |    ✓    |     ✓     |   ✓    |      ✓      |   ✓    |    ✓    |    ✓     |
| OVH      |    ✓    |     ✓     |   ✓    |     — ¹     |   —    |   ✓ ²   |    —     |
| BYOS     |   — ³   |    n/a    |  n/a   |      —      |   —    |   — ⁴   |    —     |

¹ OVH exposes Neutron security groups, but the quota is 0 on a Public Cloud
project in practice, so the API is present and unusable. `firewall.backend`
is therefore `host-nftables`, the same backend BYOS uses. This is a provider
constraint, not a missing integration.

² Neutron private network + subnet, created per environment and hot-attached to
each node (`attachServerToVNet`), with the guest-side interface configured by
the bootstrap script. Note that `getStaticCapabilities()` still returns
`vnetTopology: null` and `vnetRequired: false` for OVH even though the VNet
path is implemented and live — the declaration has not been filled in yet.

³ BYOS has no provisioning API by definition; the operator supplies the host and
Flui installs over SSH.

⁴ BYOS declares `vnetTopology.scope: 'manual'` — the operator wires whatever
private network exists; Flui creates none.

### OVH regions and flavors are discovered, not listed

Region availability on OVH is per-project, so no static list can be right for
every account. `getAvailableRegions()` reads the Keystone service catalog and
`getNodeSizes()` reads Nova's flavor list per region, with the public ordering
catalog kept only as the price source; both fall back to the static path when
there is no credential to authenticate with.

This replaced a hard-coded list that was wrong in both directions on a real
account — missing GRA-adjacent `RBX-A` plus `EU-WEST-PAR` and `EU-SOUTH-MIL`,
and offering `SGP`/`SYD`, which the credential could not reach. The same fix
applies to shapes: OVH's newer regions carry only the current-generation
`c3`/`b3`/`r3` families, so a size list built from the ordering catalog offered
`d2-*` in Milan and Paris, where it does not exist, and cluster creation was
refused at validation. City/country/coordinate decoration for a region code
lives in `ovh-region-metadata.ts`; an unknown code still resolves rather than
disappearing.

---

## OS image requirements for K3s nodes

| Requirement               | Value                                       |
| ------------------------- | ------------------------------------------- |
| OS                        | Ubuntu **24.04 LTS**                        |
| Architecture              | **x86_64 (amd64) only** — ARM not supported |
| cloud-init / user_data    | Required                                    |
| SSH port                  | 22                                          |
| Minimum for master/worker | 2 vCPU, 4 GB RAM, 40 GB disk                |

**Image identifiers by provider:**

| Provider | Image slug / ID                                                                                                                |
| -------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Hetzner  | `ubuntu-24.04`                                                                                                                 |
| Scaleway | Ubuntu 24.04 Noble Numbat (`ubuntu_noble` or latest equivalent)                                                                |
| OVH      | Glance image matched by display name — the core-wide `ubuntu-24.04` slug is translated to `Ubuntu 24.04` by `toOvhImageName()` |
| BYOS     | n/a — the operator installs the OS                                                                                             |

---

## Behavior when a capability is missing

| Missing capability    | Flui behavior                                                             |
| --------------------- | ------------------------------------------------------------------------- |
| Hourly billing (L2)   | Autoscale not economically viable; no API restriction but no cost savings |
| SSH Key Registry (L3) | Bootstrap key injected via cloud-init `user_data` (automatic fallback)    |
| Firewall (L4)         | Cluster created without firewall — warning in log, not blocking           |
| DNS (L5)              | DNS not configured by Flui — user manages manually                        |
| VNet (L6)             | Nodes not on private network — traffic over public IPs                    |
| Power management (L7) | Power endpoints unavailable                                               |

---

## Authentication model

Flui uses static, long-lived credentials only — an API token
(`X-Auth-Token` or `Bearer`), or a username/password pair where the provider's
API is built that way. OVH is the second kind: the credential is an OpenStack
user (Keystone v3 password auth), and the project is resolved from the
credential itself at connection time — Flui expects exactly one enabled project
per credential. OAuth / OIDC on the provider side is not supported.

Credentials are stored encrypted at rest in `ProviderCredentialsEntity`
via `KeyStorageService`. Retrieved at runtime via `ICredentialProvider.getActiveApiToken()`.

---

## Autoscale prerequisites (future)

When autoscale is implemented, the provider must satisfy:

1. `getNodeSizes()` returns types with `pricing.hourly > 0` AND `architecture === 'x86'`
2. `createServer()` completes in under 3 minutes (typical cloud VM boot)
3. `deleteServer()` terminates billing immediately

No interface changes are needed today — `NodeSizeDto.architecture` and `pricing.hourly`
already exist. The autoscale controller will filter candidates using these fields.
