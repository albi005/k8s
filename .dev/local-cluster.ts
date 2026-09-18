#!/usr/bin/env bun
/**
 * Local test cluster lifecycle (PLAN.md).
 *
 *   bun run local-cluster:up     k3d + nested vClusters + git daemon + ArgoCD + ApplicationSet
 *   bun run local-cluster:sync   advance `argocd-head` to HEAD and let ArgoCD reconcile
 *   bun run local-cluster:down   stop the daemon and delete the k3d cluster
 *
 * The git daemon serves this working copy directly (no bare clone), so the
 * local ArgoCD renders your uncommitted work once it is on the `argocd-head`
 * branch. `sync` refuses to advance the branch while the tree is dirty unless
 * you pass --yes.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { createInterface } from 'node:readline/promises';

const ROOT = resolve(import.meta.dir, '..');
const CLUSTER = process.env.LOCAL_CLUSTER_NAME ?? 'mycluster';
const K3S_IMAGE = process.env.LOCAL_K3S_IMAGE ?? 'rancher/k3s:v1.35.0-k3s1';
const GIT_PORT = Number(process.env.DEV_GIT_PORT ?? 9418);
const GIT_HOST = process.env.DEV_GIT_HOST ?? 'host.k3d.internal';
const GIT_BASE = process.env.DEV_GIT_BASE ?? dirname(ROOT);
const REPO_NAME = basename(ROOT);
const REPO_URL = `git://${GIT_HOST}:${GIT_PORT}/${REPO_NAME}`;
const BRANCH = 'argocd-head';
const STATE_DIR = join('/tmp', 'k8s-local-cluster');
const DAEMON_PID = join(STATE_DIR, 'git-daemon.pid');

const VCLUSTERS = [
  { name: 'vc1', namespace: 'vc1', file: join(ROOT, '.vclusters/vc1/vcluster.yaml'), local: false },
  { name: 'vc2', namespace: 'vc2', file: join(ROOT, '.vclusters/vc2/vcluster.yaml'), local: true },
];

const args = process.argv.slice(2);
const command = args[0];
const yes = args.includes('--yes') || args.includes('-y');

function sh(cmd: string, argv: string[], opts: { input?: string; quiet?: boolean } = {}) {
  const r = spawnSync(cmd, argv, {
    cwd: ROOT,
    input: opts.input,
    encoding: 'utf-8',
    stdio: opts.input !== undefined ? ['pipe', 'inherit', 'inherit'] : (opts.quiet ? 'pipe' : 'inherit'),
  });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

function must(cmd: string, argv: string[], opts: { input?: string; quiet?: boolean } = {}): string {
  const r = sh(cmd, argv, opts);
  if (!r.ok) {
    console.error(`✗ ${cmd} ${argv.join(' ')} failed`);
    process.exit(1);
  }
  return r.out;
}

function have(cmd: string): boolean {
  return sh('which', [cmd], { quiet: true }).ok;
}

function git(...argv: string[]): string {
  return must('git', ['-C', ROOT, ...argv], { quiet: true });
}

function isDirty(): boolean {
  return git('status', '--porcelain') !== '';
}

async function confirm(question: string): Promise<boolean> {
  if (yes) return true;
  if (!process.stdin.isTTY) {
    console.error('✗ not a TTY; re-run with --yes to proceed');
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
  rl.close();
  return answer === 'y' || answer === 'yes';
}

// --- git daemon -----------------------------------------------------------

function daemonPid(): number | undefined {
  if (!existsSync(DAEMON_PID)) return undefined;
  const pid = Number(readFileSync(DAEMON_PID, 'utf-8').trim());
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return undefined;
  }
}

function startDaemon(): void {
  const running = daemonPid();
  if (running) {
    console.log(`✓ git daemon already running (pid ${running})`);
    return;
  }
  const r = sh('git', [
    'daemon', '--reuseaddr', '--export-all',
    `--base-path=${GIT_BASE}`,
    '--listen=0.0.0.0', `--port=${GIT_PORT}`,
    `--pid-file=${DAEMON_PID}`,
    '--detach',
  ]);
  if (!r.ok || !daemonPid()) {
    console.error(`✗ failed to start git daemon on port ${GIT_PORT}. Try DEV_GIT_PORT=<highport> or sudo.`);
    process.exit(1);
  }
  console.log(`✓ git daemon on 0.0.0.0:${GIT_PORT} serving ${GIT_BASE}`);
}

function stopDaemon(): void {
  const pid = daemonPid();
  if (!pid) {
    console.log('git daemon not running');
    return;
  }
  process.kill(pid, 'SIGTERM');
  rmSync(DAEMON_PID, { force: true });
  console.log(`✓ stopped git daemon (pid ${pid})`);
}

function advanceBranch(): void {
  must('git', ['-C', ROOT, 'update-ref', `refs/heads/${BRANCH}`, 'HEAD'], { quiet: true });
  console.log(`✓ ${BRANCH} -> ${git('rev-parse', '--short', 'HEAD')}`);
}

// --- cluster --------------------------------------------------------------

function k3dClusterExists(): boolean {
  const r = sh('k3d', ['cluster', 'list', '-o', 'json'], { quiet: true });
  if (!r.ok) return false;
  try {
    const clusters = JSON.parse(r.out) as { name: string }[];
    return clusters.some((c) => c.name === CLUSTER);
  } catch {
    return false;
  }
}

function vclusterExists(name: string): boolean {
  const r = sh('vcluster', ['list', '-o', 'json'], { quiet: true });
  if (!r.ok) return false;
  try {
    const vcs = JSON.parse(r.out) as { name: string }[];
    return vcs.some((v) => v.name === name);
  } catch {
    return false;
  }
}

/** `.vclusters/vc2` persists its control plane on a prod storage class; drop it locally. */
function localVclusterFile(v: (typeof VCLUSTERS)[number]): string {
  if (!v.local) return v.file;
  const doc = parseYaml(readFileSync(v.file, 'utf-8'));
  if (doc?.controlPlane?.statefulSet?.persistence) {
    delete doc.controlPlane.statefulSet.persistence;
    const out = join(STATE_DIR, `${v.name}-local.yaml`);
    writeFileSync(out, stringifyYaml(doc));
    console.log(`✓ wrote ${out} (memory-ssd persistence removed)`);
    return out;
  }
  return v.file;
}

function currentContext(): string {
  return sh('kubectl', ['config', 'current-context'], { quiet: true }).out;
}

function assertLocalContext(): void {
  const ctx = currentContext();
  if (!ctx.includes('vcluster') || !ctx.includes(CLUSTER)) {
    console.error(`✗ current kubectl context "${ctx}" does not look like the local cluster (${CLUSTER}).`);
    console.error('  Run `vcluster connect vc2 -n vc2` (or re-run local-cluster:up) first.');
    process.exit(1);
  }
}

function applyDevStorageClasses(): void {
  must('kubectl', ['apply', '-f', join(ROOT, '.dev/dev-storage-classes.yaml')]);
}

function installArgoCd(): void {
  must('bash', ['-c', 'kubectl kustomize --enable-helm argocd/ | kubectl apply -f -']);
  must('kubectl', [
    'wait', '--for=condition=Established', '--timeout=180s',
    'crd/applications.argoproj.io', 'crd/applicationsets.argoproj.io',
  ]);
  must('kubectl', ['-n', 'argocd', 'rollout', 'status', 'deployment/argocd-applicationset-controller', '--timeout=180s']);
}

function applyBootstrapApplicationSet(): void {
  must('bun', ['run', 'cdk8s:synth', 'application-set'], { quiet: true });
  // cdk8s-synth prints progress to stderr; read the generated file instead.
  const manifest = readFileSync(join(ROOT, 'dist/application-set/application-set.k8s.yaml'), 'utf-8');
  must('kubectl', ['apply', '-f', '-'], { input: manifest });
}

// --- commands -------------------------------------------------------------

async function up(): Promise<void> {
  for (const bin of ['k3d', 'vcluster', 'kubectl', 'helm', 'git', 'bun']) {
    if (!have(bin)) {
      console.error(`✗ missing required tool: ${bin}`);
      process.exit(1);
    }
  }

  if (isDirty()) {
    console.warn('⚠ the working tree has uncommitted changes.');
    console.warn('  ArgoCD only sees committed work; run `bun run local-cluster:sync` to publish HEAD.');
  }

  if (!existsSync(join(ROOT, 'node_modules'))) must('bun', ['install']);
  must('bun', ['run', 'cdk8s:import']);

  if (!k3dClusterExists()) {
    must('k3d', ['cluster', 'create', CLUSTER, '--image', K3S_IMAGE]);
  } else {
    console.log(`✓ k3d cluster ${CLUSTER} exists`);
  }
  must('kubectl', ['config', 'use-context', `k3d-${CLUSTER}`], { quiet: true });

  for (const v of VCLUSTERS) {
    if (vclusterExists(v.name)) {
      console.log(`✓ vcluster ${v.name} exists`);
      continue;
    }
    must('vcluster', ['create', v.name, '-n', v.namespace, '-f', localVclusterFile(v)]);
  }

  // `vcluster create` leaves the context on the last created vcluster (vc2),
  // which is where ArgoCD lives locally (README.md).
  advanceBranch();
  startDaemon();
  applyDevStorageClasses();
  installArgoCd();

  process.env.K8S_LOCAL = '1';
  process.env.K8S_LOCAL_REPO_URL = REPO_URL;
  applyBootstrapApplicationSet();

  await sync();
}

async function sync(): Promise<void> {
  if (!currentContext()) {
    console.error('✗ kubectl is not configured');
    process.exit(1);
  }
  assertLocalContext();

  if (isDirty()) {
    console.warn('⚠ the working tree is dirty. ArgoCD will render the last commit on');
    console.warn(`  ${BRANCH}, not your uncommitted changes.`);
    if (!(await confirm('Continue anyway?'))) process.exit(1);
  }

  advanceBranch();

  // Force the ApplicationSet controller to re-read the moved branch. The
  // `apps` ApplicationSet is self-managed, so syncing its Application updates
  // the generator; the child Applications follow.
  if (have('argocd')) {
    sh('argocd', ['app', 'get', 'application-set', '--refresh']);
    sh('argocd', ['app', 'sync', 'application-set', '--prune']);
  } else {
    sh('kubectl', ['-n', 'argocd', 'annotate', 'applicationset/apps', 'argocd.argoproj.io/refresh=hard', '--overwrite'], { quiet: true });
    sh('kubectl', ['-n', 'argocd', 'rollout', 'restart', 'deployment/argocd-applicationset-controller'], { quiet: true });
  }

  console.log(`
──────────────────────────────────────────────
Local cluster ready.
  repo:      ${REPO_URL}
  branch:    ${BRANCH}
  watch:     kubectl -n argocd get applications -w
  portal:    kubectl -n argocd port-forward svc/argocd-server 8080:443
  teardown:  bun run local-cluster:down
──────────────────────────────────────────────`);
}

function down(): void {
  stopDaemon();
  if (k3dClusterExists()) {
    must('k3d', ['cluster', 'delete', CLUSTER]);
  } else {
    console.log(`k3d cluster ${CLUSTER} not found`);
  }
}

const commands: Record<string, () => void | Promise<void>> = { up, sync, down };
if (!command || !(command in commands)) {
  console.error('usage: bun run local-cluster:{up,sync,down} [--yes]');
  process.exit(1);
}
await commands[command]();
