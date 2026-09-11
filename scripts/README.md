# Scripts

Operational scripts for Flui contributors and users.

## Catalog

- `catalog-validate.ts` — validate a catalog entry or `flui.yaml` against the spec
- `catalog-diagnose.ts` — diagnose catalog ingestion issues
- `catalog-smoke-test.ts` — smoke test the catalog endpoints
- `smoke-catalog-spec-integration.ts` — integration smoke test against `@flui-cloud/spec`

## Release

- `release-index.ts` — generates `releases.json`, the list an installation reads
  to learn what exists after the release it was built as, from `RELEASE` in
  `src/config/release.config.ts`. Runs automatically in CI on every `v*` tag
  push; run it by hand only to add release notes to an already-published entry.
  See [internal-docs/RELEASE_MANIFEST.md](../internal-docs/RELEASE_MANIFEST.md).

  ```bash
  pnpm release:index --notes "What changed"
  ```

## Cluster

- `verify-cluster.sh` / `verify-cluster.ps1` — verify a provisioned cluster (API + node reachability)
- `fetch-kubeconfig.sh` / `fetch-kubeconfig.ps1` — fetch the kubeconfig of a cluster
- `update-kubeconfig.ts` — refresh a stored kubeconfig from the cluster master

Run TypeScript scripts with:

```bash
pnpm exec ts-node -r tsconfig-paths/register scripts/<name>.ts
```
