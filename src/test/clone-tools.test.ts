import assert from "node:assert/strict";
import test from "node:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AemClient } from "../client.js";
import { registerExperienceFragmentTools } from "../tools/experience-fragments.js";
import { registerPageTools } from "../tools/pages.js";

type ToolHandler = (input: Record<string, unknown>) => Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}>;

function createServerHarness(): {
  server: McpServer;
  handlers: Map<string, ToolHandler>;
} {
  const handlers = new Map<string, ToolHandler>();

  const server = {
    registerTool(name: string, _meta: unknown, handler: ToolHandler) {
      handlers.set(name, handler);
    },
  } as unknown as McpServer;

  return { server, handlers };
}

function parseToolResult(result: Awaited<ReturnType<ToolHandler>>): Record<string, unknown> {
  return JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
}

function createSampleExperienceFragment(
  title: string,
  language: string,
  options: {
    category?: "site" | "modals";
    text?: string;
    linkUrl?: string;
    navigationRoot?: string;
    replicationAction?: string;
  } = {}
): Record<string, unknown> {
  const category = options.category ?? "site";
  return {
    "jcr:primaryType": "cq:Page",
    "jcr:content": {
      "jcr:primaryType": "cq:PageContent",
      "jcr:title": title,
      "jcr:language": language,
      "sling:resourceType": "cq/experience-fragments/components/experiencefragment",
      "cq:lastModified": "2026-03-31T08:00:00.000Z",
      "cq:lastReplicationAction": options.replicationAction ?? "Activate",
      category,
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
              text: options.text ?? `Header ${language}`,
            },
            link: {
              "jcr:primaryType": "nt:unstructured",
              "sling:resourceType": "atomic/button",
              linkURL: options.linkUrl ?? `/content/caixabank-${language}/${language}/home`,
              navigationRoot: options.navigationRoot ?? `/content/caixabank-${language}`,
            },
          },
        },
      },
    },
  };
}

test("clonePage clones a page subtree and strips volatile properties", async () => {
  const sourcePagePath = "/content/site/en/home";
  const targetPagePath = "/content/site/it/home";
  const sourceTree = {
    "jcr:primaryType": "cq:Page",
    "jcr:content": {
      "jcr:primaryType": "cq:PageContent",
      "jcr:title": "Home",
      "cq:template": "/conf/site/settings/wcm/templates/content-page",
      "jcr:created": "2026-03-31T08:00:00.000Z",
      "sling:resourceType": "site/components/page",
    },
    root: {
      "jcr:primaryType": "nt:unstructured",
      "jcr:uuid": "abc123",
      text: "Hello",
    },
  };

  let importedContent: Record<string, unknown> | undefined;

  const client = {
    async exists(path: string): Promise<boolean> {
      return [sourcePagePath, "/content/site/it", targetPagePath].includes(path)
        ? path !== targetPagePath
        : false;
    },
    async getJson(path: string, depth: number | "infinity"): Promise<Record<string, unknown>> {
      if (path === sourcePagePath && depth === "infinity") {
        return sourceTree;
      }
      if (path === targetPagePath && depth === 1 && importedContent) {
        return importedContent;
      }
      throw new Error(`Unexpected getJson call for ${path}`);
    },
    async slingImport(path: string, content: object): Promise<Record<string, unknown>> {
      assert.equal(path, targetPagePath);
      importedContent = content as Record<string, unknown>;
      return {};
    },
    async slingDelete(): Promise<Record<string, unknown>> {
      throw new Error("slingDelete should not be called in this test");
    },
  } as unknown as AemClient;

  const { server, handlers } = createServerHarness();
  registerPageTools(server, client, {
    aemUrl: "http://localhost:4502",
    user: "admin",
    password: "admin",
    readOnly: false,
  });

  const clonePage = handlers.get("clonePage");
  assert.ok(clonePage);

  const result = await clonePage({
    sourcePagePath,
    targetPagePath,
    overwrite: false,
  });

  assert.equal(result.isError, undefined);
  const payload = parseToolResult(result);
  assert.equal(payload["sourcePath"], sourcePagePath);
  assert.equal(payload["targetPath"], targetPagePath);
  assert.equal(payload["pageTitle"], "Home");
  assert.equal(payload["template"], "/conf/site/settings/wcm/templates/content-page");
  assert.equal((payload["verification"] as Record<string, unknown>)["exists"], true);

  const importedJcrContent = importedContent?.["jcr:content"] as Record<string, unknown>;
  assert.equal(importedJcrContent["jcr:created"], undefined);
  assert.equal((importedContent?.["root"] as Record<string, unknown>)["jcr:uuid"], undefined);
});

test("cloneExperienceFragment fails when target exists and overwrite is false", async () => {
  const sourceXfPath = "/content/experience-fragments/site/en/header";
  const targetXfPath = "/content/experience-fragments/site/it/header";

  const client = {
    async exists(path: string): Promise<boolean> {
      return [sourceXfPath, targetXfPath, "/content/experience-fragments/site/it"].includes(path);
    },
    async getJson(): Promise<Record<string, unknown>> {
      throw new Error("getJson should not be called when target already exists");
    },
    async slingImport(): Promise<Record<string, unknown>> {
      throw new Error("slingImport should not be called when target already exists");
    },
    async slingDelete(): Promise<Record<string, unknown>> {
      throw new Error("slingDelete should not be called when overwrite=false");
    },
  } as unknown as AemClient;

  const { server, handlers } = createServerHarness();
  registerExperienceFragmentTools(server, client, {
    aemUrl: "http://localhost:4502",
    user: "admin",
    password: "admin",
    readOnly: false,
  });

  const cloneExperienceFragment = handlers.get("cloneExperienceFragment");
  assert.ok(cloneExperienceFragment);

  const result = await cloneExperienceFragment({
    sourceXfPath,
    targetXfPath,
    overwrite: false,
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? "", /Target path already exists/);
});

test("cloneExperienceFragment can create parent folders and return post-clone analysis", async () => {
  const sourceXfPath = "/content/experience-fragments/site/pl/site/header";
  const targetXfPath = "/content/experience-fragments/site/it/site/header";
  const sourceTree = createSampleExperienceFragment("Header", "pl", {
    text: "Ostrzezenie o oszustwach",
    linkUrl: "/caixabank-polonia/pl/header",
    navigationRoot: "/content/caixabank-polonia",
  });

  const existingPaths = new Set<string>([
    "/content/experience-fragments/site",
    sourceXfPath,
  ]);
  const createdPaths: string[] = [];
  let importedContent: Record<string, unknown> | undefined;

  const client = {
    async exists(path: string): Promise<boolean> {
      return existingPaths.has(path);
    },
    async post(path: string): Promise<Record<string, unknown>> {
      existingPaths.add(path);
      createdPaths.push(path);
      return {};
    },
    async getJson(path: string, depth: number | "infinity"): Promise<Record<string, unknown>> {
      if (path === sourceXfPath && depth === "infinity") {
        return sourceTree;
      }
      if (path === targetXfPath && depth === 1 && importedContent) {
        return importedContent;
      }
      throw new Error(`Unexpected getJson call for ${path}`);
    },
    async slingImport(path: string, content: object): Promise<Record<string, unknown>> {
      assert.equal(path, targetXfPath);
      importedContent = content as Record<string, unknown>;
      existingPaths.add(path);
      return {};
    },
    async slingDelete(): Promise<Record<string, unknown>> {
      throw new Error("slingDelete should not be called");
    },
  } as unknown as AemClient;

  const { server, handlers } = createServerHarness();
  registerExperienceFragmentTools(server, client, {
    aemUrl: "http://localhost:4502",
    user: "admin",
    password: "admin",
    readOnly: false,
  });

  const cloneExperienceFragment = handlers.get("cloneExperienceFragment");
  assert.ok(cloneExperienceFragment);

  const result = await cloneExperienceFragment({
    sourceXfPath,
    targetXfPath,
    overwrite: false,
    createParentFolders: true,
    postCloneAnalysis: true,
  });

  assert.equal(result.isError, undefined);
  assert.deepEqual(createdPaths, [
    "/content/experience-fragments/site/it",
    "/content/experience-fragments/site/it/site",
  ]);

  const payload = parseToolResult(result);
  assert.equal(payload["rootTitle"], "Header");
  assert.deepEqual(payload["variationNames"], ["master"]);

  const contentMetadata = payload["contentMetadata"] as Record<string, unknown>;
  assert.equal(contentMetadata["hasUntranslatedText"], true);
  assert.equal(contentMetadata["adaptedUrlCount"], 0);
  assert.equal(contentMetadata["requiresManualReview"], true);
});

test("createExperienceFragmentStructure creates missing language folders and is idempotent for existing paths", async () => {
  const existingPaths = new Set<string>([
    "/content/experience-fragments/caixabank-italia",
    "/content/experience-fragments/caixabank-italia/it",
  ]);
  const postedPaths: string[] = [];

  const client = {
    async exists(path: string): Promise<boolean> {
      return existingPaths.has(path);
    },
    async post(path: string): Promise<Record<string, unknown>> {
      postedPaths.push(path);
      existingPaths.add(path);
      return {};
    },
  } as unknown as AemClient;

  const { server, handlers } = createServerHarness();
  registerExperienceFragmentTools(server, client, {
    aemUrl: "http://localhost:4502",
    user: "admin",
    password: "admin",
    readOnly: false,
  });

  const createExperienceFragmentStructure = handlers.get("createExperienceFragmentStructure");
  assert.ok(createExperienceFragmentStructure);

  const result = await createExperienceFragmentStructure({
    xfBasePath: "/content/experience-fragments/caixabank-italia",
    languageCode: "it",
    xfTypes: ["site", "modals"],
  });

  const payload = parseToolResult(result);
  assert.deepEqual(postedPaths, [
    "/content/experience-fragments/caixabank-italia/it/site",
    "/content/experience-fragments/caixabank-italia/it/modals",
  ]);
  assert.deepEqual(payload["createdPaths"], postedPaths);
  assert.equal(payload["ready"], true);
});

test("detectXFContent summarizes authored components and translation needs", async () => {
  const xfPath = "/content/experience-fragments/site/pl/site/header";
  const client = {
    async getJson(path: string, depth: number | "infinity"): Promise<Record<string, unknown>> {
      assert.equal(path, xfPath);
      assert.equal(depth, "infinity");
      return createSampleExperienceFragment("Header", "pl", {
        text: "Ostrzezenie o oszustwach",
      });
    },
  } as unknown as AemClient;

  const { server, handlers } = createServerHarness();
  registerExperienceFragmentTools(server, client, {
    aemUrl: "http://localhost:4502",
    user: "admin",
    password: "admin",
    readOnly: false,
  });

  const detectXFContent = handlers.get("detectXFContent");
  assert.ok(detectXFContent);

  const result = await detectXFContent({ xfPath });
  const payload = parseToolResult(result);
  const components = payload["components"] as Array<Record<string, unknown>>;
  const contentSummary = payload["contentSummary"] as Record<string, unknown>;

  assert.equal(payload["language"], "pl");
  assert.equal(payload["isEmpty"], false);
  assert.equal(payload["translationRequired"], true);
  assert.equal(payload["estimatedTranslationKeys"], 1);
  assert.equal(components.length, 2);
  assert.equal(contentSummary["componentCount"], 2);
});

test("adaptXFContent rewrites only whitelisted URL properties", async () => {
  const xfPath = "/content/experience-fragments/site/it/site/header";
  const sourceTree = createSampleExperienceFragment("Header", "pl", {
    text: "Texto original",
    linkUrl: "/caixabank-polonia/pl/header",
    navigationRoot: "/content/caixabank-polonia",
  });
  let importedContent: Record<string, unknown> | undefined;

  const client = {
    async getJson(path: string, depth: number | "infinity"): Promise<Record<string, unknown>> {
      assert.equal(path, xfPath);
      assert.equal(depth, "infinity");
      return sourceTree;
    },
    async slingImport(path: string, content: object): Promise<Record<string, unknown>> {
      assert.equal(path, xfPath);
      importedContent = content as Record<string, unknown>;
      return {};
    },
  } as unknown as AemClient;

  const { server, handlers } = createServerHarness();
  registerExperienceFragmentTools(server, client, {
    aemUrl: "http://localhost:4502",
    user: "admin",
    password: "admin",
    readOnly: false,
  });

  const adaptXFContent = handlers.get("adaptXFContent");
  assert.ok(adaptXFContent);

  const result = await adaptXFContent({
    xfPath,
    sourceLanguage: "pl",
    targetLanguage: "it",
    internalUrlPatternFrom: "/caixabank-polonia/pl/",
    internalUrlPatternTo: "/caixabank-italia/it/",
    navigationRootFrom: "/content/caixabank-polonia",
    navigationRootTo: "/content/caixabank-italia",
    translateText: false,
  });

  const payload = parseToolResult(result);
  assert.equal(payload["adaptedUrls"], 2);
  assert.equal(payload["adaptedNodes"], 1);

  const masterContent = ((((importedContent?.["master"] as Record<string, unknown>)["jcr:content"] as Record<string, unknown>)["root"] as Record<string, unknown>)["container"] as Record<string, unknown>);
  const link = masterContent["link"] as Record<string, unknown>;
  const title = masterContent["title"] as Record<string, unknown>;

  assert.equal(link["linkURL"], "/caixabank-italia/it/header");
  assert.equal(link["navigationRoot"], "/content/caixabank-italia");
  assert.equal(title["text"], "Texto original");
});

test("getExperienceFragmentTree applies language/type filters and includes metadata", async () => {
  const basePath = "/content/experience-fragments/caixabank-italia";
  const fragments = {
    [`${basePath}/it/site/header`]: createSampleExperienceFragment("Header", "it", {
      category: "site",
      text: "Accesso online",
    }),
    [`${basePath}/it/modals/cookies-modal`]: createSampleExperienceFragment("Cookies", "it", {
      category: "modals",
      text: "",
      linkUrl: "/caixabank-italia/it/cookies",
    }),
    [`${basePath}/es/site/header`]: createSampleExperienceFragment("Header ES", "es", {
      category: "site",
      text: "Acceso online",
    }),
  };

  const client = {
    async get(path: string): Promise<Record<string, unknown>> {
      assert.equal(path, "/bin/querybuilder.json");
      return {
        hits: [
          { "jcr:path": `${basePath}/it/site/header`, "jcr:content/jcr:title": "Header", "jcr:content/cq:lastReplicationAction": "Activate" },
          { "jcr:path": `${basePath}/it/modals/cookies-modal`, "jcr:content/jcr:title": "Cookies", "jcr:content/cq:lastReplicationAction": "Deactivate" },
          { "jcr:path": `${basePath}/es/site/header`, "jcr:content/jcr:title": "Header ES", "jcr:content/cq:lastReplicationAction": "Activate" },
        ],
      };
    },
    async getJson(path: string, depth: number | "infinity"): Promise<Record<string, unknown>> {
      assert.equal(depth, "infinity");
      return fragments[path as keyof typeof fragments];
    },
  } as unknown as AemClient;

  const { server, handlers } = createServerHarness();
  registerExperienceFragmentTools(server, client, {
    aemUrl: "http://localhost:4502",
    user: "admin",
    password: "admin",
    readOnly: false,
  });

  const getExperienceFragmentTree = handlers.get("getExperienceFragmentTree");
  assert.ok(getExperienceFragmentTree);

  const result = await getExperienceFragmentTree({
    basePath,
    filterByLanguage: "it",
    filterByType: "site",
    filterByEmpty: false,
    includeContentSummary: true,
  });

  const payload = parseToolResult(result);
  const nodes = payload["nodes"] as Array<Record<string, unknown>>;

  assert.equal(nodes.length, 1);
  assert.match(String(payload["tree"]), /it\/\n.*site\/\n.*header\//s);
  assert.deepEqual(payload["stats"], {
    fragmentCount: 1,
    variationCount: 1,
    totalNodeCount: 5,
  });
});

test("compareXFStructure classifies URL-only differences as adapted", async () => {
  const sourcePath = "/content/experience-fragments/site/pl/site/header";
  const targetPath = "/content/experience-fragments/site/it/site/header";
  const sourceTree = createSampleExperienceFragment("Header", "pl", {
    linkUrl: "/caixabank-polonia/pl/header",
    navigationRoot: "/content/caixabank-polonia",
  });
  const targetTree = createSampleExperienceFragment("Header", "it", {
    linkUrl: "/caixabank-italia/it/header",
    navigationRoot: "/content/caixabank-italia",
  });

  const client = {
    async getJson(path: string): Promise<Record<string, unknown>> {
      return path === sourcePath ? sourceTree : targetTree;
    },
  } as unknown as AemClient;

  const { server, handlers } = createServerHarness();
  registerExperienceFragmentTools(server, client, {
    aemUrl: "http://localhost:4502",
    user: "admin",
    password: "admin",
    readOnly: false,
  });

  const compareXFStructure = handlers.get("compareXFStructure");
  assert.ok(compareXFStructure);

  const result = await compareXFStructure({ sourcePath, targetPath });
  const payload = parseToolResult(result);
  const differences = payload["differences"] as Array<Record<string, unknown>>;

  assert.equal(payload["ready"], false);
  assert.ok(differences.some((difference) => difference["status"] === "adapted"));
});

test("listXFByLanguage groups Experience Fragments by detected language", async () => {
  const xfBasePath = "/content/experience-fragments/caixabank-italia";
  const fragments = {
    [`${xfBasePath}/it/site/header`]: createSampleExperienceFragment("Header", "it"),
    [`${xfBasePath}/es/site/footer`]: createSampleExperienceFragment("Footer", "es"),
  };

  const client = {
    async get(path: string): Promise<Record<string, unknown>> {
      assert.equal(path, "/bin/querybuilder.json");
      return {
        hits: [
          { "jcr:path": `${xfBasePath}/it/site/header`, "jcr:content/jcr:title": "Header" },
          { "jcr:path": `${xfBasePath}/es/site/footer`, "jcr:content/jcr:title": "Footer" },
        ],
      };
    },
    async getJson(path: string, depth: number | "infinity"): Promise<Record<string, unknown>> {
      assert.equal(depth, "infinity");
      return fragments[path as keyof typeof fragments];
    },
  } as unknown as AemClient;

  const { server, handlers } = createServerHarness();
  registerExperienceFragmentTools(server, client, {
    aemUrl: "http://localhost:4502",
    user: "admin",
    password: "admin",
    readOnly: false,
  });

  const listXFByLanguage = handlers.get("listXFByLanguage");
  assert.ok(listXFByLanguage);

  const result = await listXFByLanguage({ xfBasePath, metadata: true });
  const payload = parseToolResult(result);
  const languages = payload["languages"] as Record<string, { count: number; xfs: unknown[] }>;

  assert.equal(languages["it"]?.count, 1);
  assert.equal(languages["es"]?.count, 1);
  assert.equal(languages["it"]?.xfs.length, 1);
});

test("clonePage returns a read-only error when writes are disabled", async () => {
  const { server, handlers } = createServerHarness();
  registerPageTools(server, {} as AemClient, {
    aemUrl: "http://localhost:4502",
    user: "admin",
    password: "admin",
    readOnly: true,
  });

  const clonePage = handlers.get("clonePage");
  assert.ok(clonePage);

  const result = await clonePage({
    sourcePagePath: "/content/site/en/home",
    targetPagePath: "/content/site/it/home",
    overwrite: false,
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? "", /AEM_READ_ONLY=true/);
});

test("clonePage fails when target parent path does not exist", async () => {
  const client = {
    async exists(path: string): Promise<boolean> {
      return path === "/content/site/en/home";
    },
    async getJson(): Promise<Record<string, unknown>> {
      throw new Error("getJson should not be called when target parent is missing");
    },
    async slingImport(): Promise<Record<string, unknown>> {
      throw new Error("slingImport should not be called when target parent is missing");
    },
    async slingDelete(): Promise<Record<string, unknown>> {
      throw new Error("slingDelete should not be called when target parent is missing");
    },
  } as unknown as AemClient;

  const { server, handlers } = createServerHarness();
  registerPageTools(server, client, {
    aemUrl: "http://localhost:4502",
    user: "admin",
    password: "admin",
    readOnly: false,
  });

  const clonePage = handlers.get("clonePage");
  assert.ok(clonePage);

  const result = await clonePage({
    sourcePagePath: "/content/site/en/home",
    targetPagePath: "/content/site/it/home",
    overwrite: false,
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? "", /Target parent path not found/);
});
