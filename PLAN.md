we are working on a comprehensive GitOps setup.

the current version uses ArgoCD with each ArgoCD Application stored in a top-level directory in the repo,
as either classic K8s .yaml files or a kustomization.yaml.

we added support for cdk8s-based apps, with automatic update PRs using Renovate,
and a local cluster that can be brought up/down with bun scripts.

## todo

- [x] keep the same top-level setup and add support for cdk8s apps using a `app.ts` file as the entry-point
      (done via an ArgoCD Config Management Plugin sidecar, see `argocd/kustomization.yaml`; sample in `demo/`)
- [x] local cluster lifecycle as bun scripts (`.dev/local-cluster.ts`, replacing the manual README steps)
- [x] Renovate helper: an app's CI opens an update PR for `<app>/versions.ts` against kir-dev/k8s

## rules
- top-level directories other than the ones starting with a `.` are ArgoCD Applications.
  keep non-Application files in a dir starting with a `.` (like `.dev`) or at the top-level.
- use bun. don't add dependencies unless necessary.
- pin everything (nix-style): package.json deps, Renovate, cdk8s.yaml imports, GitHub Actions.

## layout

```
<repo root>/
  cdk8s.yaml          # shared imports for all cdk8s apps
  package.json        # shared deps + bun scripts
  imports/            # generated cdk8s .ts (gitignored, cached)
  .dev/               # all tooling (not an ArgoCD Application)
    cdk8s-import.ts     # parallel, cached `cdk8s import`
    cdk8s-synth.ts      # render one APP_NAME/app.ts
    is-local.ts         # isLocal() / sourceRepoUrl() / sourceRevision()
    local-cluster.ts    # local-cluster:up / sync / down
    renovate.ts         # `bun run renovate APP_NAME` wrapper
    renovate-config.ts  # appConfig() helper imported by each app's renovate.ts
  application-set/
    app.ts            # the app-of-apps ApplicationSet (renders prod or local)
  argocd/
    kustomization.yaml  # ArgoCD itself + the cdk8s CMP sidecar
  demo/               # sample cdk8s app
    app.ts
    versions.ts
    renovate.ts
```

## plan

```sh
bun install

# ensures the cdk8s generated .ts files (imports/) exist.
# run by developers before editing app.ts files and by the CMP for each app.
# parallel worker pool, output cached by cdk8s.yaml hash in $CDK8S_IMPORT_CACHE
bun run cdk8s:import

# render ./APP_NAME/app.ts. app.ts default-exports a cdk8s App;
# .dev/cdk8s-synth.ts imports it and calls .synth() into $CDK8S_OUTDIR.
bun run cdk8s:synth APP_NAME

# bring up a local k3d cluster + nested vClusters (see README.md), a git daemon
# serving this working copy, ArgoCD, and the bootstrap ApplicationSet.
bun run local-cluster:up
  k3d cluster create
  vcluster create vc1, vc2   # vc2's prod-only memory-ssd persistence is stripped
  git daemon                 # serves this repo; `argocd-head` points at HEAD
  kubectl apply argocd       # installs ArgoCD (kustomize + helm)
  K8S_LOCAL=1 bun run cdk8s:synth application-set | kubectl apply -f -
  bun run local-cluster:sync

# publish local changes and let ArgoCD reconcile
bun run local-cluster:sync
  # warns if the repo is dirty (ArgoCD only sees committed work)
  # moves `argocd-head` to HEAD
  # refreshes the `apps` ApplicationSet (restarts the controller if no argocd CLI)
bun run local-cluster:down
  git daemon stop
  k3d cluster delete

# App-specific GitHub Actions, runs in the app's repo
git clone https://github.com/kir-dev/k8s --depth 1
cd k8s
bun install
bun run renovate APP_NAME
  bun .dev/renovate.ts
    RENOVATE_CONFIG_FILE=./APP_NAME/renovate.ts bunx renovate@<pinned>
```

## prod vs local

`application-set/app.ts` is the single source of the ApplicationSet. It calls
`isLocal()` (`.dev/is-local.ts`):

- `K8S_LOCAL` env var, if set, wins.
- otherwise `isLocal()` is true when the checkout's `git remote get-url origin`
  is a `git://` URL — i.e. the local ArgoCD clone from the git daemon. prod's
  origin is `https://github.com/kir-dev/k8s`.

`sourceRepoUrl()`/`sourceRevision()` therefore render kir-dev/k8s `HEAD` in prod
and `git://<host>:<port>/<repo>` `argocd-head` locally. `local-cluster:up` sets
`K8S_LOCAL=1 K8S_LOCAL_REPO_URL=...` for the one-time bootstrap synth.

## cdk8s apps have the following files

- `versions.ts`:
  ```ts
  export const versions = {
    image: 'ghcr.io/kir-dev/example:v1.2.3@sha256:...',
  };
  ```
- `app.ts`: default-exports a cdk8s app:
  ```ts
  import { Construct } from 'constructs';
  import { App, Chart, ChartProps } from 'cdk8s';
  import { versions } from './versions.ts';
  export class MyChart extends Chart {
    constructor(scope: Construct, id: string, props: ChartProps = { }) {
      super(scope, id, props);
      new KubeDeployment(this, 'my-deployment', { ... });
    }
  }
  const app = new App();
  new MyChart(app, 'typescript');
  export default app;
  ```
- `renovate.ts`: Renovate config updating `versions.ts` for the app
  ```ts
  import { appConfig } from '../.dev/renovate-config.ts';
  export default appConfig('APP_NAME');
  ```

Renovate runs with the Node runtime (bunx's default); `--bun` crashes on
Renovate's native `re2` addon. `appConfig()` scopes a `custom.regex` manager to
`<app>/versions.ts`, uses the `docker` datasource + `versioning: docker` and
`pinDigests`, and is the app's Renovate *global* config (token comes from the
app repo's `RENOVATE_TOKEN` secret).

## notes

- ArgoCD CMP caches `bun install` (`BUN_INSTALL_CACHE_DIR`) and `cdk8s:import`
  (`CDK8S_IMPORT_CACHE`) on the `cmp-cache` volume; an `emptyDir` for now.
- https://hub.docker.com/r/nixos/nix
- https://docs.renovatebot.com/getting-started/running/#using-typescript-config-files
- https://argo-cd.readthedocs.io/en/stable/user-guide/config-management-plugins/
- env vars when rendering an argocd Application (like ARGOCD_APP_NAME):
  https://argo-cd.readthedocs.io/en/stable/user-guide/build-environment/
- https://cdk8s.io/docs/latest/cli/import/
