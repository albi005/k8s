export const environment: "Development" | "Production" = ((e) => {
    if (e == "Development" || e == "Production") return e;
    if (!e) return "Development";
    throw new Error("Invalid KIRDEV_ENVIRONMENT.");
})(process.env.KIRDEV_ENVIRONMENT);

export const k8sRepoUrl =
    process.env.KIRDEV_K8S_REPO_URL ??
    (() => {
        if (environment == "Development") {
            return `git://git-server.argocd.svc.cluster.local:9418/k8s.git`;
        }
        throw new Error("KIRDEV_K8S_REPO_URL not set.");
    })();

export const k8sRepoPort = process.env.KIRDEV_K8S_REPO_PORT;

export const k8sRepoRevision = process.env.KIRDEV_K8S_REPO_REVISION;
