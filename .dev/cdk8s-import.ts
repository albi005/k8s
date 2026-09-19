/**
 * Default `cdk8s import` is slow and has a bug when receiving and redirect that makes it even slower.
 * This script runs each import in parallel and patches cdk8s's download().
 */
import { $ } from "bun";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";

const cacheDir = process.env.CDK8S_IMPORT_CACHE ?? join(homedir(), ".cache", "cdk8s-imports");

const cdk8sConfig = parseYaml(readFileSync("cdk8s.yaml", "utf-8")) as { imports: string[] };
const cdk8sImports = cdk8sConfig.imports;
const importsDir = "imports";

// Reuse cached imports dir if cdk8s.yaml hasn't changed
const cdk8sConfigHash = createHash("sha256").update(readFileSync("cdk8s.yaml")).digest("hex");
const cachedImportsDir = join(cacheDir, "out", cdk8sConfigHash, "imports");
if (existsSync(cachedImportsDir)) {
    rmSync(importsDir, { recursive: true, force: true });
    symlinkSync(cachedImportsDir, importsDir, "dir");
    process.exit(0);
}

// cdk8s.yaml changed, create new imports dir
rmSync(importsDir, { recursive: true, force: true });
const started = Date.now();

const shellOutputs = await Promise.all(cdk8sImports.map((spec) => $`bun .dev/cdk8s-import-one.ts ${spec}`.nothrow()));

const failed = shellOutputs.filter((result) => result.exitCode !== 0).length;
const wall = ((Date.now() - started) / 1000).toFixed(1);
console.error(`${cdk8sImports.length - failed}/${cdk8sImports.length} imports OK in ${wall}s`);
if (failed) process.exit(1);

// Cache
mkdirSync(cachedImportsDir, { recursive: true });
cpSync(importsDir, cachedImportsDir, { recursive: true });
console.error(`cached -> ${cachedImportsDir}`);
