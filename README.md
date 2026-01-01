# Kir-Dev Kubernetes configuration

## Bootstrapping

```bash
git clone https://github.com/kir-dev/k8s
cd k8s

# Install ArgoCD into the Kubernetes cluster
kubectl apply --kustomize argocd

# Install this repo as an ArgoCD Application
kubectl apply applications.yaml
```

## Documentation

- https://kubectl.docs.kubernetes.io/references/kustomize/kustomization/
- ArgoCD `Application`: https://argo-cd.readthedocs.io/en/stable/operator-manual/application.yaml
