# Kir-Dev Kubernetes configuration

## Bootstrapping

```bash
k3d cluster create mycluster --image rancher/k3s:v1.29.6-k3s1

vcluster create vc-1

git clone https://github.com/kir-dev/k8s
cd k8s

# Install ArgoCD into the Kubernetes cluster
kubectl apply --kustomize argocd

# Install this repo as an ArgoCD Application
kubectl apply -f application.yaml
```

## Documentation

- https://kubectl.docs.kubernetes.io/references/kustomize/kustomization/
- ArgoCD `Application` reference: https://argo-cd.readthedocs.io/en/stable/user-guide/application-specification/
- Manage Argo CD Using Argo CD: https://argo-cd.readthedocs.io/en/stable/operator-manual/declarative-setup/#manage-argo-cd-using-argo-cd
