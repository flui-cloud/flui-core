# Scripts

Operational scripts for Flui contributors and users.

## Catalog

- `catalog-validate.ts` — validate a catalog entry or `flui.yaml` against the spec
- `catalog-diagnose.ts` — diagnose catalog ingestion issues
- `catalog-smoke-test.ts` — smoke test the catalog endpoints
- `smoke-catalog-spec-integration.ts` — integration smoke test against `@flui-cloud/spec`

## Release

- `release-index.ts` — publish `RELEASE` as an entry in `releases.json`, the list
  an installation reads to learn what exists after the release it was built as.
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
