/**
 * Are we rendering for the local test cluster (or a developer's machine) rather
 * than production?
 *
 * Used by `application-set/app.ts` to decide where the generated Applications
 * point. The ArgoCD CMP runs `app.ts` on every render, both in prod and in the
 * local cluster, from a checkout whose `origin` is the source repository:
 *
 *   - prod  -> https://github.com/kir-dev/k8s
 *   - local -> git://host.k3d.internal:9418/k8s (git daemon, see PLAN.md)
 *
 * `local-cluster:*` sets K8S_LOCAL=1 when it renders the bootstrap
 * ApplicationSet on the developer's machine (where origin is a normal remote).
 */
import { execFileSync } from 'node:child_process';

export function isLocal(): boolean {
  const env = process.env.K8S_LOCAL;
  if (env !== undefined) return env !== '' && env !== '0' && env !== 'false';
  return repoUrl().startsWith('git://');
}

/** The URL of the repository `app.ts` is currently being rendered from. */
export function repoUrl(): string {
  try {
    return execFileSync('git', ['remote', 'get-url', 'origin'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
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
export function sourceRepoUrl(): string {
  if (!isLocal()) return PROD_REPO_URL;
  return process.env.K8S_LOCAL_REPO_URL || repoUrl();
}

/** The revision the generated Applications should track. */
export function sourceRevision(): string {
  return isLocal() ? LOCAL_REVISION : 'HEAD';
}
