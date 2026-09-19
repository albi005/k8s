/**
 * Local test cluster lifecycle (PLAN.md).
 *
 *   bun run local-cluster:up     k3d + nested vClusters + ArgoCD + git server + ApplicationSet
 *   bun run local-cluster:sync   push HEAD to the in-cluster git server and reconcile
 *   bun run local-cluster:down   delete the k3d cluster
 *
 * ArgoCD runs in the innermost vCluster (vc2), so a git daemon on the host
 * isn't reachable from it (nested DNS + host firewall). Instead an in-cluster
 * `git-server` serves a bare repo; `sync` pushes your committed HEAD to it via
 * `kubectl port-forward`, and ArgoCD renders from a `git://` URL. `sync`
 * refuses to push while the tree is dirty unless you pass --yes.
 */
import { $ } from "bun";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { createInterface } from "node:readline/promises";

const ROOT = resolve(import.meta.dir, "..");
const CLUSTER = process.env.LOCAL_CLUSTER_NAME ?? "mycluster";
const K3S_IMAGE = process.env.LOCAL_K3S_IMAGE ?? "rancher/k3s:v1.35.0-k3s1";
const BRANCH = "argocd-head";
const GIT_NAMESPACE = "argocd";
const GIT_SERVICE = "git-server";
const GIT_REPO = "k8s.git";
/** Reachable from inside the cluster (vc2). */
const GIT_SERVICE_URL = `git://${GIT_SERVICE}.${GIT_NAMESPACE}.svc.cluster.local:9418/${GIT_REPO}`;
/** Local port used to push into the cluster through `kubectl port-forward`. */
const FORWARD_PORT = Number(process.env.DEV_GIT_FORWARD_PORT ?? 19418);
const STATE_DIR = join("/tmp", "k8s-local-cluster");
mkdirSync(STATE_DIR, { recursive: true });

const VCLUSTERS = [
    { name: "vc1", namespace: "vc1", file: join(ROOT, ".vclusters/vc1/vcluster.yaml"), local: false },
    { name: "vc2", namespace: "vc2", file: join(ROOT, ".vclusters/vc2/vcluster.yaml"), local: true },
];

const args = process.argv.slice(2);
const command = args[0];
const yes = args.includes("--yes") || args.includes("-y");

type ShellCmd = ReturnType<typeof $>;

async function check(cmd: ShellCmd): Promise<void> {
    const result = await cmd.nothrow();
    if (result.exitCode !== 0) {
        console.error("✗ command failed");
        process.exit(1);
    }
}

async function ok(cmd: ShellCmd): Promise<boolean> {
    return (await cmd.quiet().nothrow()).exitCode === 0;
}

async function text(cmd: ShellCmd): Promise<string> {
    return (await cmd.quiet().nothrow().text()).trim();
}

function have(cmd: string): Promise<boolean> {
    return ok($`which ${cmd}`);
}

async function isDirty(): Promise<boolean> {
    return (await text($`git -C ${ROOT} status --porcelain`)) !== "";
}

async function confirm(question: string): Promise<boolean> {
    if (yes) return true;
    if (!process.stdin.isTTY) {
        console.error("✗ not a TTY; re-run with --yes to proceed");
        return false;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    rl.close();
    return answer === "y" || answer === "yes";
}

// --- cluster --------------------------------------------------------------

async function k3dClusterExists(): Promise<boolean> {
    const r = await $`k3d cluster list -o json`.quiet().nothrow();
    if (r.exitCode !== 0) return false;
    try {
        const clusters = JSON.parse(await r.text()) as { name: string }[];
        return clusters.some((c) => c.name === CLUSTER);
    } catch {
        return false;
    }
}

async function vclusterExists(name: string): Promise<boolean> {
    const r = await $`vcluster list -o json`.quiet().nothrow();
    if (r.exitCode !== 0) return false;
    try {
        const vcs = JSON.parse(await r.text()) as { name: string }[];
        return vcs.some((v) => v.name === name);
    } catch {
        return false;
    }
}

/** Create the vCluster on the current context, or connect to it if it exists. */
async function ensureVcluster(v: (typeof VCLUSTERS)[number]): Promise<void> {
    if (!(await vclusterExists(v.name))) {
        await check($`vcluster create ${v.name} -n ${v.namespace} -f ${localVclusterFile(v)}`);
        return;
    }
    console.log(`✓ vcluster ${v.name} exists`);
    if (!(await currentContext()).includes(`vcluster_${v.name}_`)) {
        await check($`vcluster connect ${v.name} -n ${v.namespace}`);
    }
}

/** `.vclusters/vc2` persists its control plane on a prod storage class; drop it locally. */
function localVclusterFile(v: (typeof VCLUSTERS)[number]): string {
    if (!v.local) return v.file;
    const doc = parseYaml(readFileSync(v.file, "utf-8"));
    if (doc?.controlPlane?.statefulSet?.persistence) {
        delete doc.controlPlane.statefulSet.persistence;
        const out = join(STATE_DIR, `${v.name}-local.yaml`);
        writeFileSync(out, stringifyYaml(doc));
        console.log(`✓ wrote ${out} (memory-ssd persistence removed)`);
        return out;
    }
    return v.file;
}

async function currentContext(): Promise<string> {
    return text($`kubectl config current-context`);
}

async function assertLocalContext(): Promise<void> {
    const ctx = await currentContext();
    if (!ctx.includes("vcluster") || !ctx.includes(CLUSTER)) {
        console.error(`✗ current kubectl context "${ctx}" does not look like the local cluster (${CLUSTER}).`);
        console.error("  Run `vcluster connect vc2 -n vc2` (or re-run local-cluster:up) first.");
        process.exit(1);
    }
}

// --- git server -----------------------------------------------------------

async function installGitServer(): Promise<void> {
    await check($`kubectl apply -f ${join(ROOT, ".dev/git-server.yaml")}`);
    await check($`kubectl -n ${GIT_NAMESPACE} rollout status deployment/${GIT_SERVICE} --timeout=180s`);
}

/**
 * Push the current HEAD into the in-cluster bare repo as `argocd-head`.
 *
 * The local port-forward is the only path from the host into vc2, so the
 * cluster's own git daemon can't be reached directly.
 */
async function publishHead(): Promise<void> {
    const forward = Bun.spawn(
        ["kubectl", "-n", GIT_NAMESPACE, "port-forward", `svc/${GIT_SERVICE}`, `${FORWARD_PORT}:9418`],
        { stdout: "ignore", stderr: "ignore" },
    );
    try {
        const localUrl = `git://127.0.0.1:${FORWARD_PORT}/${GIT_REPO}`;
        let ready = false;
        for (let i = 0; i < 40 && !ready; i++) {
            ready = await ok($`timeout 3 git ls-remote ${localUrl}`);
            if (!ready) await Bun.sleep(500);
        }
        if (!ready) {
            console.error(`✗ could not reach the in-cluster git server on 127.0.0.1:${FORWARD_PORT}`);
            process.exit(1);
        }
        await check($`git -C ${ROOT} push --force ${localUrl} HEAD:refs/heads/${BRANCH}`);
    } finally {
        forward.kill();
    }
}

// --- argocd ---------------------------------------------------------------

async function installArgoCd(): Promise<void> {
    await check($`bash -c ${"kubectl kustomize --enable-helm argocd/ | kubectl apply -f -"}`.cwd(ROOT));
    await check(
        $`kubectl wait --for=condition=Established --timeout=180s crd/applications.argoproj.io crd/applicationsets.argoproj.io`,
    );
    await check($`kubectl -n argocd rollout status deployment/argocd-applicationset-controller --timeout=180s`);
}

async function applyDevStorageClasses(): Promise<void> {
    await check($`kubectl apply -f ${join(ROOT, ".dev/dev-storage-classes.yaml")}`);
}

async function applyBootstrapApplicationSet(): Promise<void> {
    await check($`bun run cdk8s:synth application-set`.cwd(ROOT));
    // cdk8s-synth prints progress to stderr; read the generated file instead.
    const manifest = readFileSync(join(ROOT, "dist/application-set/application-set.k8s.yaml"), "utf-8");
    await check($`echo ${manifest} | kubectl apply -f -`);
}

// --- commands -------------------------------------------------------------

async function up(): Promise<void> {
    for (const bin of ["k3d", "vcluster", "kubectl", "helm", "git", "bun"]) {
        if (!(await have(bin))) {
            console.error(`✗ missing required tool: ${bin}`);
            process.exit(1);
        }
    }

    if (await isDirty()) {
        console.warn("⚠ the working tree has uncommitted changes.");
        console.warn("  ArgoCD only sees committed work; run `bun run local-cluster:sync` to publish HEAD.");
    }

    if (!existsSync(join(ROOT, "node_modules"))) await check($`bun install`.cwd(ROOT));
    await check($`bun run cdk8s:import`.cwd(ROOT));

    if (!(await k3dClusterExists())) {
        await check($`k3d cluster create ${CLUSTER} --image ${K3S_IMAGE}`);
    } else {
        console.log(`✓ k3d cluster ${CLUSTER} exists`);
    }

    // vc1 is created on the k3d cluster, vc2 nested inside vc1. On a re-run the
    // existing vCluster must be re-connected so the next one lands in the right
    // parent.
    await check($`kubectl config use-context k3d-${CLUSTER}`);
    await ensureVcluster(VCLUSTERS[0]);
    await ensureVcluster(VCLUSTERS[1]);

    // ArgoCD lives in the innermost vCluster (vc2) locally (README.md).
    await applyDevStorageClasses();
    await installArgoCd();
    await installGitServer();

    await sync();
}

async function sync(): Promise<void> {
    await assertLocalContext();

    if (await isDirty()) {
        console.warn("⚠ the working tree is dirty. Only committed work is pushed to");
        console.warn(`  ${BRANCH}, so ArgoCD will not see your uncommitted changes.`);
        if (!(await confirm("Continue anyway?"))) process.exit(1);
    }

    await publishHead();

    // Re-apply the bootstrap ApplicationSet from the working tree so it always
    // points at the in-cluster git server (self-managed ArgoCD would otherwise
    // be able to flip it to the prod URL).
    process.env.K8S_LOCAL = "1";
    process.env.K8S_LOCAL_REPO_URL = GIT_SERVICE_URL;
    await applyBootstrapApplicationSet();

    // Force the ApplicationSet controller to re-read the pushed branch. The
    // `apps` ApplicationSet is self-managed, so syncing its Application updates
    // the generator; the child Applications follow.
    if (await have("argocd")) {
        await $`argocd app get application-set --refresh`.nothrow();
        await $`argocd app sync application-set --prune`.nothrow();
    } else {
        await $`kubectl -n argocd annotate applicationset/apps argocd.argoproj.io/refresh=hard --overwrite`
            .quiet()
            .nothrow();
        await $`kubectl -n argocd rollout restart deployment/argocd-applicationset-controller`.quiet().nothrow();
    }

    console.log(`
──────────────────────────────────────────────
Local cluster ready.
  repo:      ${GIT_SERVICE_URL}
  branch:    ${BRANCH}
  watch:     kubectl -n argocd get applications -w
  portal:    kubectl -n argocd port-forward svc/argocd-server 8080:443
  teardown:  bun run local-cluster:down
──────────────────────────────────────────────`);
}

async function down(): Promise<void> {
    if (await k3dClusterExists()) {
        await check($`k3d cluster delete ${CLUSTER}`);
    } else {
        console.log(`k3d cluster ${CLUSTER} not found`);
    }
}

const commands = { up, sync, down } as const;
if (!command || !(command in commands)) {
    console.error("usage: bun run local-cluster:{up,sync,down} [--yes]");
    process.exit(1);
}
await commands[command as keyof typeof commands]();
