/**
 * Patch cdk8s download() https://github.com/cdk8s-team/cdk8s-cli/blob/7d810de7cbd34d1729e35192c05a3bf00ac33dd7/src/util.ts#L164
 * to fix redirect handling and add caching.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const cacheDir = process.env.CDK8S_IMPORT_CACHE ?? join(homedir(), ".cache", "cdk8s-imports");

/**
 * Must be called with the same `require` used to load cdk8s-cli so we mutate
 * the exact module instance its crd.js / k8s.js call into.
 */
export function patchCdk8sDownload(require: NodeJS.Require): void {
    // Resolved relative to the `require` passed in (createRequire lives in
    // .dev/cdk8s-import-one.ts), so `../node_modules` is the repo root.
    const util = require("../node_modules/cdk8s-cli/lib/util");
    const original = util.download;
    util.download = async (url: string): Promise<string> => {
        // Let the original function handle non-https requests
        if (!/^https?:/i.test(url)) {
            return original(url);
        }

        // Check the cache
        const cacheKey = createHash("sha256").update(url).digest("hex");
        const cacheFilePath = join(cacheDir, cacheKey);
        if (existsSync(cacheFilePath)) {
            return readFileSync(cacheFilePath, "utf-8");
        }

        // No cache, request and store in cache
        const res = await fetch(url, { redirect: "follow" });
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${url}`);
        const text = await res.text();
        mkdirSync(cacheDir, { recursive: true });
        writeFileSync(cacheFilePath, text);
        return text;
    };
}
