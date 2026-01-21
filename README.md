# Kir-Dev Kubernetes configuration

## Bootstrapping

```bash
# Create a cluster
k3d cluster create mycluster --image rancher/k3s:v1.29.6-k3s1

git clone https://github.com/kir-dev/k8s
cd k8s

# Create a vcluster inside it
vcluster create --upgrade green -n vc-green -f vcluster.yaml

# Install ArgoCD into the Kubernetes cluster
kubectl apply --kustomize argocd/

# Install this repo as an ArgoCD Application
kubectl apply -f application-set/
```

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
