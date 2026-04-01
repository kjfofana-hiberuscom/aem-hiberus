import assert from "node:assert/strict";
import test from "node:test";

import {
  adaptExperienceFragmentData,
  buildExperienceFragmentTree,
  compareExperienceFragmentData,
  hasOverlappingPaths,
  inspectExperienceFragmentData,
  sanitizeJcrSubtree,
} from "../jcr-helpers.js";

function createSampleExperienceFragment(
  basePath: string,
  language: string,
  options: {
    text?: string;
    linkUrl?: string;
    navigationRoot?: string;
    replicationAction?: string;
  } = {}
): Record<string, unknown> {
  return {
    "jcr:primaryType": "cq:Page",
    "jcr:content": {
      "jcr:primaryType": "cq:PageContent",
      "jcr:title": "Header",
      "jcr:language": language,
      "sling:resourceType": "cq/experience-fragments/components/experiencefragment",
      "cq:lastModified": "2026-03-31T08:00:00.000Z",
      "cq:lastReplicationAction": options.replicationAction ?? "Activate",
    },
    master: {
      "jcr:primaryType": "cq:Page",
      "jcr:content": {
        "jcr:primaryType": "cq:PageContent",
        "jcr:title": "Master",
        "cq:xfVariantType": "web",
        root: {
          "jcr:primaryType": "nt:unstructured",
          "sling:resourceType": "wcm/foundation/components/responsivegrid",
          container: {
            "jcr:primaryType": "nt:unstructured",
            "sling:resourceType": "core/wcm/components/container/v1/container",
            title: {
              "jcr:primaryType": "nt:unstructured",
              "sling:resourceType": "atomic/title",
              text: options.text ?? "Ostrzezenie o oszustwach",
            },
            link: {
              "jcr:primaryType": "nt:unstructured",
              "sling:resourceType": "atomic/button",
              linkURL: options.linkUrl ?? "/caixabank-polonia/pl/header",
              navigationRoot: options.navigationRoot ?? "/content/caixabank-polonia",
            },
          },
        },
      },
    },
    secondary: {
      "jcr:primaryType": "cq:Page",
      "jcr:content": {
        "jcr:primaryType": "cq:PageContent",
        "jcr:title": "Secondary",
        "cq:xfVariantType": "email",
      },
    },
  };
}

test("sanitizeJcrSubtree removes volatile properties recursively and keeps content fields", () => {
  const input = {
    "jcr:primaryType": "cq:Page",
    "jcr:uuid": "deadbeef",
    "jcr:content": {
      "jcr:primaryType": "cq:PageContent",
      "jcr:title": "Header",
      "jcr:created": "2026-03-31T08:00:00.000Z",
      "cq:lastReplicationAction": "Activate",
      "sling:resourceType": "cq/experience-fragments/components/experiencefragment",
    },
    master: {
      "jcr:primaryType": "cq:Page",
      "jcr:content": {
        "jcr:primaryType": "cq:PageContent",
        "cq:xfVariantType": "web",
        "jcr:lastModifiedBy": "admin",
        text: "Keep me",
      },
    },
  };

  const sanitized = sanitizeJcrSubtree(input) as Record<string, unknown>;
  const sanitizedContent = sanitized["jcr:content"] as Record<string, unknown>;
  const sanitizedMaster = sanitized["master"] as Record<string, unknown>;
  const sanitizedMasterContent = sanitizedMaster["jcr:content"] as Record<string, unknown>;

  assert.equal(sanitized["jcr:uuid"], undefined);
  assert.equal(sanitizedContent["jcr:created"], undefined);
  assert.equal(sanitizedContent["cq:lastReplicationAction"], undefined);
  assert.equal(sanitizedContent["sling:resourceType"], "cq/experience-fragments/components/experiencefragment");
  assert.equal(sanitizedMasterContent["jcr:lastModifiedBy"], undefined);
  assert.equal(sanitizedMasterContent["text"], "Keep me");
});

test("hasOverlappingPaths detects same, parent-child, and sibling-safe paths", () => {
  assert.equal(hasOverlappingPaths("/content/site/en", "/content/site/en"), true);
  assert.equal(hasOverlappingPaths("/content/site/en", "/content/site/en/home"), true);
  assert.equal(hasOverlappingPaths("/content/site/en/home", "/content/site/en"), true);
  assert.equal(hasOverlappingPaths("/content/site/en", "/content/site/it"), false);
});

test("inspectExperienceFragmentData classifies content, language, status, and review needs", () => {
  const basePath = "/content/experience-fragments/caixabank-polonia";
  const xfPath = `${basePath}/pl/site/header`;
  const inspection = inspectExperienceFragmentData(
    xfPath,
    createSampleExperienceFragment(basePath, "pl"),
    basePath
  );

  assert.equal(inspection.language, "pl");
  assert.equal(inspection.status, "published");
  assert.equal(inspection.category, "site");
  assert.deepEqual(inspection.variationNames, ["master", "secondary"]);
  assert.equal(inspection.analysis.isEmpty, false);
  assert.equal(inspection.analysis.translationRequired, true);
  assert.equal(inspection.analysis.contentSummary.componentCount, 2);
  assert.equal(inspection.analysis.contentSummary.variationCount, 2);
});

test("adaptExperienceFragmentData rewrites whitelisted URL fields without touching text", () => {
  const xfPath = "/content/experience-fragments/caixabank-italia/it/site/header";
  const sourceData = createSampleExperienceFragment("/content/experience-fragments/caixabank-polonia", "pl");

  const { adaptedContent, result } = adaptExperienceFragmentData(xfPath, sourceData, {
    sourceLanguage: "pl",
    targetLanguage: "it",
    internalUrlPatternFrom: "/caixabank-polonia/pl/",
    internalUrlPatternTo: "/caixabank-italia/it/",
    navigationRootFrom: "/content/caixabank-polonia",
    navigationRootTo: "/content/caixabank-italia",
  });

  const link = (((((adaptedContent["master"] as Record<string, unknown>)["jcr:content"] as Record<string, unknown>)["root"] as Record<string, unknown>)["container"] as Record<string, unknown>)["link"] as Record<string, unknown>);
  const title = (((((adaptedContent["master"] as Record<string, unknown>)["jcr:content"] as Record<string, unknown>)["root"] as Record<string, unknown>)["container"] as Record<string, unknown>)["title"] as Record<string, unknown>);

  assert.equal(result.adaptedUrls, 2);
  assert.equal(result.adaptedNodes, 1);
  assert.equal(link["linkURL"], "/caixabank-italia/it/header");
  assert.equal(link["navigationRoot"], "/content/caixabank-italia");
  assert.equal(title["text"], "Ostrzezenie o oszustwach");
});

test("compareExperienceFragmentData ignores volatile properties and classifies URL-only diffs as adapted", () => {
  const sourcePath = "/content/experience-fragments/site/pl/site/header";
  const targetPath = "/content/experience-fragments/site/it/site/header";
  const sourceData = createSampleExperienceFragment("/content/experience-fragments/site", "pl");
  const targetData = createSampleExperienceFragment("/content/experience-fragments/site", "it", {
    linkUrl: "/caixabank-italia/it/header",
    navigationRoot: "/content/caixabank-italia",
  });

  const result = compareExperienceFragmentData(sourcePath, sourceData, targetPath, targetData);

  assert.equal(result.inspectedLeafCount > 0, true);
  assert.equal(result.ready, false);
  assert.ok(result.differences.some((difference) => difference.status === "adapted"));
  assert.ok(result.differences.some((difference) => difference.property === "linkURL"));
});

test("buildExperienceFragmentTree reconstructs ancestors and renders a stable tree", () => {
  const basePath = "/content/experience-fragments/caixabank-italia";
  const { root, tree, stats } = buildExperienceFragmentTree(
    basePath,
    [
      { path: `${basePath}/es/site/header`, title: "Header", language: "es", category: "site" },
      { path: `${basePath}/it/site/header`, title: "Header", language: "it", category: "site" },
      { path: `${basePath}/it/modals/cookies-modal`, title: "Cookies modal", language: "it", category: "modals" },
    ],
    [
      { path: `${basePath}/es/site/header/master`, title: "Master" },
      { path: `${basePath}/it/site/header/master`, title: "Master" },
      { path: `${basePath}/it/modals/cookies-modal/master`, title: "Master" },
    ]
  );

  assert.equal(root.children.length, 2);
  assert.match(tree, /caixabank-italia\/\n├── es\//);
  assert.match(tree, /cookies-modal\/\n.*master/s);
  assert.deepEqual(stats, {
    fragmentCount: 3,
    variationCount: 3,
    totalNodeCount: 12,
  });
});
