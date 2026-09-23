/**
 * Patch cdk8s-cli's CRD importer to aggregate CRDs from multiple sources into
 * a single module per API group.
 *
 * Mirrors https://github.com/cdk8s-team/cdk8s-cli/pull/3798 . Without it,
 * importing several CRD files that share an API group writes the same module
 * file once per file, so the last import overwrites all the others.
 * (https://github.com/cdk8s-team/cdk8s-cli/issues/3797)
 */
export function patchCdk8sCrdMerge(require: NodeJS.Require): void {
    const crd = require("../node_modules/cdk8s-cli/lib/import/crd");

    // Don't patch twice if something already provides the API.
    if (crd.ImportCustomResourceDefinition.fromSpecs) {
        return;
    }

    crd.ImportCustomResourceDefinition.fromSpecs = async (importSpecs: { source: string }[]) => {
        // Resolve `download` through the same module instance that
        // `cdk8s-download-patch` mutates, so its caching/redirect fixes apply.
        const { download } = require("../node_modules/cdk8s-cli/lib/util");
        const manifests = await Promise.all(importSpecs.map((spec) => download(spec.source)));
        const combinedManifest = manifests.join("\n---\n");
        return new crd.ImportCustomResourceDefinition(combinedManifest);
    };

    crd.ImportCustomResourceDefinition.fromManifest = (manifest: string) =>
        new crd.ImportCustomResourceDefinition(manifest);
}
