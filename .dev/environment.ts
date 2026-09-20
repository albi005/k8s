export const environment: "Development" | "Production" = ((e) => {
    if (e == "Development" || e == "Production") return e;
    if (!e) throw new Error("KIRDEV_ENVIRONMENT not set.");
    throw new Error("Invalid KIRDEV_ENVIRONMENT.");
})(process.env.KIRDEV_ENVIRONMENT);

export const k8sRepoUrl = ((repo) => {
    if (!repo) throw new Error("KIRDEV_K8S_REPO_URL not set.");
    return repo;
})(process.env.KIRDEV_K8S_REPO_URL);

export const k8sRepoPort = process.env.KIRDEV_K8S_REPO_PORT;

export const k8sRepoRevision = process.env.KIRDEV_K8S_REPO_REVISION;
