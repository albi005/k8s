/**
 * Are we rendering for the local test cluster (or a developer's machine) rather
 * than production?
 *
 * Used by `application-set/app.ts` to decide where the generated Applications
 * point. The ArgoCD CMP runs `app.ts` on every render, both in prod and in the
 * local cluster:
 *
 *   - prod  -> https://github.com/kir-dev/k8s
 *   - local -> git://git-server.argocd.svc.cluster.local:9418/k8s.git
 *              (in-cluster git daemon, see .dev/local-cluster.ts)
 *
 * Detection, in order:
 *   1. `K8S_LOCAL` env (set by `local-cluster:*` for host-side synthesis).
 *   2. `ARGOCD_APP_SOURCE_REPO_URL` (ArgoCD passes the Application's source URL
 *      to CMP plugins; a `git://` URL means the in-cluster git server).
 *   3. That git server actually being reachable, which is true in the local
 *      cluster and false in prod even when the Application source is stale.
 */
import { $ } from 'bun';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const LOCAL_GIT_HOST = 'git-server.argocd.svc.cluster.local';
const LOCAL_GIT_PORT = 9418;

export async function isLocal(): Promise<boolean> {
  const env = process.env.K8S_LOCAL;
  if (env !== undefined) return env !== '' && env !== '0' && env !== 'false';
  if ((process.env.ARGOCD_APP_SOURCE_REPO_URL ?? '').startsWith('git://')) return true;
  if (await localGitServerReachable()) return true;
  return (await repoUrl()).startsWith('git://');
}

async function localGitServerReachable(): Promise<boolean> {
  if (process.platform !== 'linux') return false;
  const probe = `echo > /dev/tcp/${LOCAL_GIT_HOST}/${LOCAL_GIT_PORT}`;
  const result = await $`timeout 3 bash -c ${probe}`.quiet().nothrow();
  return result.exitCode === 0;
}

/** The URL of the repository `app.ts` is currently being rendered from. */
export async function repoUrl(): Promise<string> {
  const result = await $`git -C ${ROOT} remote get-url origin`.quiet().nothrow();
  if (result.exitCode !== 0) return '';
  return (await result.text()).trim();
}

/** Where Application sync from in production. */
export const PROD_REPO_URL = 'https://github.com/kir-dev/k8s';

/** The branch `local-cluster:sync` pushes to. */
export const LOCAL_REVISION = 'argocd-head';

/**
 * The repository the generated Applications should point at.
 *
 * In prod that's always kir-dev/k8s. Locally it's the git daemon serving the
 * developer's working copy; `local-cluster:up` passes K8S_LOCAL_REPO_URL when
 * bootstrapping from a checkout whose origin is still the normal remote.
 */
export async function sourceRepoUrl(): Promise<string> {
  if (!(await isLocal())) return PROD_REPO_URL;
  return process.env.K8S_LOCAL_REPO_URL || repoUrl();
}

/** The revision the generated Applications should track. */
export async function sourceRevision(): Promise<string> {
  return (await isLocal()) ? LOCAL_REVISION : 'HEAD';
}
