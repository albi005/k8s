
TODO: Update README
TODO: is the resource request/limit bug not mentioned anywhere?

# Kir-Dev Kubernetes configuration

## Bootstrapping

Install
[kubectl](https://kubernetes.io/docs/tasks/tools/#kubectl),
[k3d](https://k3d.io), and
the [vCluster CLI](https://www.vcluster.com/install)
(`nix-shell -p kubectl k3d vcluster` if you have Nix), plus
[bun](https://bun.sh) and `helm`, then:

```bash
git clone https://github.com/kir-dev/k8s
cd k8s

# create the k3d cluster + nested vClusters, an in-cluster git server,
# install ArgoCD and the bootstrap ApplicationSet
bun install
bun run local-cluster:up

# after committing changes, publish them and let ArgoCD reconcile
bun run local-cluster:sync

# tear everything down
bun run local-cluster:down
```

`local-cluster:up` is idempotent for the cluster/vClusters and reproduces the
manual steps that used to be documented here (see `PLAN.md` for the full flow).

## Adding a new app

Create a new directory containing
- `.yaml` files defining Kubernetes resources, or
- a `kustomization.yaml`.
  - You can use
    [`helmCharts:`](https://kubectl.docs.kubernetes.io/references/kustomize/builtins/#_helmchartinflationgenerator_)
    to install Helm charts. Set values either using `valuesInline:` or by creating a `values.yaml` and
    referencing it using `valuesFile:`.
- a cdk8s app: an `app.ts` (see `PLAN.md`).

ArgoCD checks each top-level directory except the ones starting with a `.`. If
it sees `kustomization.yaml`, it `kubectl apply --kustomize`s it, otherwise it
applies `.yaml` files using `kubectl apply`.

### cdk8s apps

See `PLAN.md` for the cdk8s layout (`app.ts`, `versions.ts`, `renovate.ts`) and
the shared `cdk8s.yaml`/`imports/` model. `demo/` is a minimal example.


## Documentation

- https://kubectl.docs.kubernetes.io/references/kustomize/kustomization/
- ArgoCD `Application` reference: https://argo-cd.readthedocs.io/en/stable/user-guide/application-specification/
- Manage Argo CD Using Argo CD:
  https://argo-cd.readthedocs.io/en/stable/operator-manual/declarative-setup/#manage-argo-cd-using-argo-cd
- Kustomization file documentation: https://kubectl.docs.kubernetes.io/references/kustomize/kustomization/

## Notes

- Some Helm charts put CRDs into `templates/` instead `crds/` so `includeCRDs: true/false` in `kustomization.yaml` has
  no effect
- Some Helm charts include a schema for `values.yaml`. https://artifacthub.io shows whether there is one.
    - To get code completion, put a
      ```yaml
      # yaml-language-server: $schema=https://.../values.schema.json
      ```
      at the top of the `values.yaml`. Find the `values.schema.json` file in the chart's GitHub repository,
      then press the *Raw* button to get a link.
- Set `resources.{limits,requests}.ephemeral-storage`, as the default (1GiB) uses more than allowed by the quota
  (especially for the limit)
- Always specify the Postgres image version for CNPG `Cluster`s, otherwise backups can't be restored
  due to the version mismatch
- Don't forget `database`/`owner` fields when restoring a CNPG DB from a backup