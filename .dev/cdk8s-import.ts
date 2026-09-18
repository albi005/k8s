/**
 * Fast cdk8s import: download + generate .ts, in parallel.
 *
 * Runs each import from cdk8s.yaml in its own worker process (real multi-core
 * parallelism) and patches cdk8s-cli's buggy download() with `fetch`. An
 * output-level cache makes warm runs (unchanged cdk8s.yaml) O(1).
 *
 * The cache lives in CDK8S_IMPORT_CACHE (default ~/.cache/cdk8s-imports). The
 * ArgoCD CMP points it at a persistent volume so `cdk8s:import` is a no-op
 * across syncs as long as cdk8s.yaml is unchanged.
 *
 * Usage: bun .dev/cdk8s-import.ts [outdir]
 */
import { $ } from 'bun';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, mkdirSync, rmSync, symlinkSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parse as parseYaml } from 'yaml';

const CACHE_DIR = process.env.CDK8S_IMPORT_CACHE ?? join(homedir(), '.cache', 'cdk8s-imports');
const CONCURRENCY = Number(process.env.CDK8S_IMPORT_PARALLELISM ?? 16);

const config = parseYaml(readFileSync('cdk8s.yaml', 'utf-8')) as { imports?: string[] };
const imports = config.imports ?? [];
const OUTDIR = process.argv[2] ?? 'imports';

// --- output cache: warm runs just link the previous result ---
const outputKey = createHash('sha256').update(readFileSync('cdk8s.yaml')).digest('hex');
const cachedImports = join(CACHE_DIR, 'out', outputKey, 'imports');
if (existsSync(cachedImports)) {
  rmSync(OUTDIR, { recursive: true, force: true });
  symlinkSync(cachedImports, OUTDIR, 'dir');
  console.error(`cached (${outputKey.slice(0, 8)}): linked -> ${OUTDIR}`);
  process.exit(0);
}

// --- worker pool: one process per import, bounded concurrency ---
rmSync(OUTDIR, { recursive: true, force: true });
const started = Date.now();
const queue = [...imports];
let running = 0;
let failed = 0;

async function runWorker(spec: string): Promise<void> {
  const result = await $`bun .dev/cdk8s-import-one.ts ${spec} ${OUTDIR}`.nothrow();
  if (result.exitCode !== 0) failed++;
}

async function pump(): Promise<void> {
  while (queue.length > 0 && running < CONCURRENCY) {
    running++;
    const spec = queue.shift()!;
    void runWorker(spec).then(() => {
      running--;
      void pump();
    });
  }
}

await pump();

// wait for any stragglers
while (running > 0) {
  await new Promise((r) => setTimeout(r, 100));
}

const wall = ((Date.now() - started) / 1000).toFixed(1);
console.error(`${imports.length - failed}/${imports.length} imports OK in ${wall}s`);
if (failed) process.exit(1);

// --- cache the generated output ---
mkdirSync(cachedImports, { recursive: true });
cpSync(OUTDIR, cachedImports, { recursive: true });
console.error(`cached -> ${cachedImports}`);
