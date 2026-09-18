we are working on a comprehensive GitOps setup.

the current version uses ArgoCD with each ArgoCD Application stored in a top-level directory in the repo,
as either classic K8s .yaml files or a kustomize.yaml.

i want to add support for cdk8s-based apps, with automatic update PRs using Renovate.
additionally i want to be able to deploy a cluster locally for testing.

## todo

- [x] keep the same top-level setup and add support for cdk8s apps using a `app.ts` file as the entry-point
      (done via an ArgoCD Config Management Plugin sidecar, see `argocd/kustomization.yaml`; sample in `demo/`)
- [ ] the current setup uses some Renovate magic to open PRs from other repositories from GitHub Actions.
  see kir-dev/k8s and kir-dev/StartSCH (both already in ~/src).
  create a script that can be run from the CI/CD pipelines of other repositories that opens an update PR for that specific app.

## rules
- top-level directories other than the ones starting with a `.` are ArgoCD Applications.
  keep non-Application files either in a dir like `.cdk8s` (or something else) or at the top-level.
- use bun. don't add dependencies unless necessary.

## notes

- https://hub.docker.com/r/nixos/nix
  - https://discourse.nixos.org/t/how-to-use-nix-only-in-docker-for-a-project/18043/2
- https://docs.renovatebot.com/getting-started/running/#using-typescript-config-files
- https://docs.renovatebot.com/modules/manager/nix/
- Gum-like prompts in JS: https://www.npmjs.com/package/@clack/prompts
- https://nixery.dev/
- https://argo-cd.readthedocs.io/en/stable/user-guide/commands/argocd_app_sync/
- env vars when rendering an argocd Application (like ARGOCD_APP_NAME):
  https://argo-cd.readthedocs.io/en/stable/user-guide/build-environment/
- https://cdk8s.io/docs/latest/cli/import/
- ```ts
  const module = await import(path.resolve(import.meta.dir, `../${filename}.ts`))
  module.default
  module.myFunc()
  ```

## plan

```sh
bun install

# ran by the developer before editing app.ts files and by argocd for each cdk8s Application,
# ensures that cdk8s generated .ts files exist
bun run cdk8s:import

# renders ./APP_NAME/app.ts.
# if argocd sees a top-level directory with an app.ts, it creates an argocd
# Application that gets its resources by running this command.
bun run cdk8s:synth APP_NAME
  bun run ./.dev/cdk8s-synth.ts

# create a local k8s cluster using k3d, create the vclusters (see README.md),
# add argocd, add app for local git repo
bun run local-cluster:up
  k3d cluster create
  vcluster create
  git daemon
  # create a `argocd-head` branch at HEAD
  kubectl apply argocd # install argocd with an ApplicationSet pointing at the git daemon's `argocd-head` branch
  bun run local-cluster:sync

bun run local-cluster:sync
  # warn the user if the repo is dirty and ask them whether to continue
  # move the `argocd-head` git branch to HEAD
  argocd sync # the main ApplicationSet's Application which hopefully also updates the child Applications
bun run local-cluster:down
  k3d delete

# App-specific GitHub Actions, runs in the app's repo
git clone https://github.com/kir-dev/k8s --depth 1
cd k8s
bun install
bun run renovate APP_NAME
  bun ./.dev/renovate.ts
    RENOVATE_CONFIG_FILE=./APP_NAME/renovate.ts renovate
```

cdk8s apps have the following files:
- `versions.ts`:
  ```ts
  export const versions = {
    image: "https://ghcr.io/kir-dev/...:...@sha256:...",
  };
  ```
- `app.ts`: returns a cdk8s app:
  ```ts
  import { Construct } from 'constructs';
  import { App, Chart, ChartProps } from 'cdk8s';
  import { versions } from './versions.ts';
  export class MyChart extends Chart {
    constructor(scope: Construct, id: string, props: ChartProps = { }) {
      super(scope, id, props);
      new KubeDeployment(this, 'my-deployment', {...});
      ...
    }
  }
  const app = new App();
  new MyChart(app, 'typescript');
  export default app;
  ```
- `renovate.ts`: Renovate config updating versions.ts for the app
  ```ts
  import type { AllConfig } from 'renovate/dist/config/types';
  export default {...} as AllConfig;
  ```
