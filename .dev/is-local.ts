/**
 * Are we rendering for the local test cluster (or a developer's machine) rather
 * than production?
 *
 * Used by `application-set/app.ts` to decide where the generated Applications
 * point. The ArgoCD CMP runs `app.ts` on every render, both in prod and in the
 * local cluster, from a checkout whose `origin` is the source repository:
 *
 *   - prod  -> https://github.com/kir-dev/k8s
 *   - local -> git://git-server.argocd.svc.cluster.local:9418/k8s.git
 *              (in-cluster git daemon, see .dev/local-cluster.ts)
 *
 * `local-cluster:*` sets K8S_LOCAL=1 when it renders the bootstrap
 * ApplicationSet on the developer's machine (where origin is a normal remote).
 */
import { $ } from 'bun';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');

export async function isLocal(): Promise<boolean> {
  const env = process.env.K8S_LOCAL;
  if (env !== undefined) return env !== '' && env !== '0' && env !== 'false';
  return (await repoUrl()).startsWith('git://');
}

/** The URL of the repository `app.ts` is currently being rendered from. */
export async function repoUrl(): Promise<string> {
  const result = await $`git -C ${ROOT} remote get-url origin`.quiet().nothrow();
  if (result.exitCode !== 0) return '';
  return (await result.text()).trim();
}

/** Where Application sync from in production. */
export const PROD_REPO_URL = 'https://github.com/kir-dev/k8s';

/** The branch `local-cluster:sync` advances to the current HEAD. */
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
  return process.env.K8S_LOCAL_REPO_URL || (await repoUrl());
}

/** The revision the generated Applications should track. */
export async function sourceRevision(): Promise<string> {
  return (await isLocal()) ? LOCAL_REVISION : 'HEAD';
}
