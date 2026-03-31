import assert from "node:assert/strict";
import test from "node:test";

import {
  buildExperienceFragmentTree,
  hasOverlappingPaths,
  sanitizeJcrSubtree,
} from "../jcr-helpers.js";

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

test("buildExperienceFragmentTree reconstructs ancestors and renders a stable tree", () => {
  const basePath = "/content/experience-fragments/caixabank-italia";
  const { root, tree, stats } = buildExperienceFragmentTree(
    basePath,
    [
      { path: `${basePath}/es/site/header`, title: "Header" },
      { path: `${basePath}/es/site/footer`, title: "Footer" },
      { path: `${basePath}/it/site/header`, title: "Header" },
      { path: `${basePath}/it/site/footer`, title: "Footer" },
      { path: `${basePath}/modals/cookies-modal`, title: "Cookies modal" },
    ],
    [
      { path: `${basePath}/es/site/header/master`, title: "Master" },
      { path: `${basePath}/es/site/footer/master`, title: "Master" },
      { path: `${basePath}/it/site/header/master`, title: "Master" },
      { path: `${basePath}/it/site/footer/master`, title: "Master" },
      { path: `${basePath}/modals/cookies-modal/master`, title: "Master" },
    ]
  );

  assert.equal(root.children.length, 3);
  assert.match(tree, /caixabank-italia\/\n├── es\//);
  assert.match(tree, /header\/\n.*master/s);
  assert.deepEqual(stats, {
    fragmentCount: 5,
    variationCount: 5,
    totalNodeCount: 16,
  });
});
