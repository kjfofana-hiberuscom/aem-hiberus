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
      return [
        sourcePagePath,
        "/content/site/it",
        targetPagePath,
      ].includes(path)
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
    async slingImport(
      path: string,
      content: object
    ): Promise<Record<string, unknown>> {
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
  assert.equal(((importedContent?.["root"] as Record<string, unknown>)["jcr:uuid"]), undefined);
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

test("cloneExperienceFragment overwrites target and reports copied variations", async () => {
  const sourceXfPath = "/content/experience-fragments/site/pl/header";
  const targetXfPath = "/content/experience-fragments/site/it/header";
  const sourceTree = {
    "jcr:primaryType": "cq:Page",
    "jcr:content": {
      "jcr:primaryType": "cq:PageContent",
      "jcr:title": "Header",
      "sling:resourceType": "cq/experience-fragments/components/experiencefragment",
      "cq:lastModified": "2026-03-31T08:00:00.000Z",
    },
    master: {
      "jcr:primaryType": "cq:Page",
      "jcr:content": {
        "jcr:primaryType": "cq:PageContent",
        "jcr:title": "Master",
        "cq:xfVariantType": "web",
      },
    },
    email: {
      "jcr:primaryType": "cq:Page",
      "jcr:content": {
        "jcr:primaryType": "cq:PageContent",
        "jcr:title": "Email",
        "cq:xfVariantType": "email",
      },
    },
  };

  let deletedTarget = "";

  const client = {
    async exists(path: string): Promise<boolean> {
      return [sourceXfPath, targetXfPath, "/content/experience-fragments/site/it"].includes(path);
    },
    async getJson(path: string, depth: number | "infinity"): Promise<Record<string, unknown>> {
      if (path === sourceXfPath && depth === "infinity") return sourceTree;
      if (path === targetXfPath && depth === 1) return sourceTree;
      throw new Error(`Unexpected getJson call for ${path}`);
    },
    async slingImport(): Promise<Record<string, unknown>> {
      return {};
    },
    async slingDelete(path: string): Promise<Record<string, unknown>> {
      deletedTarget = path;
      return {};
    },
    async get(): Promise<Record<string, unknown>> {
      return { hits: [] };
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
    overwrite: true,
  });

  assert.equal(deletedTarget, targetXfPath);
  const payload = parseToolResult(result);
  assert.deepEqual(payload["variationNames"], ["email", "master"]);
  assert.equal(payload["rootTitle"], "Header");
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

test("getExperienceFragmentTree returns an empty tree when no fragments exist", async () => {
  const client = {
    async get(): Promise<Record<string, unknown>> {
      return { hits: [], total: 0 };
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
    basePath: "/content/experience-fragments/site",
  });

  const payload = parseToolResult(result);
  assert.equal(payload["tree"], "/content/experience-fragments/site/");
  assert.deepEqual(payload["nodes"], []);
  assert.deepEqual(payload["stats"], {
    fragmentCount: 0,
    variationCount: 0,
    totalNodeCount: 1,
  });
});

test("getExperienceFragmentTree returns structured nodes and ascii tree", async () => {
  const basePath = "/content/experience-fragments/caixabank-italia";
  const client = {
    async get(
      path: string,
      params?: Record<string, unknown>
    ): Promise<Record<string, unknown>> {
      assert.equal(path, "/bin/querybuilder.json");
      if (params?.["property"] === "jcr:content/sling:resourceType") {
        return {
          hits: [
            { "jcr:path": `${basePath}/es/site/header`, "jcr:content/jcr:title": "Header" },
            { "jcr:path": `${basePath}/it/site/footer`, "jcr:content/jcr:title": "Footer" },
            { "jcr:path": `${basePath}/modals/cookies-modal`, "jcr:content/jcr:title": "Cookies modal" },
          ],
        };
      }

      return {
        hits: [
          { "jcr:path": `${basePath}/es/site/header/master`, "jcr:content/jcr:title": "Master" },
          { "jcr:path": `${basePath}/it/site/footer/master`, "jcr:content/jcr:title": "Master" },
          { "jcr:path": `${basePath}/modals/cookies-modal/master`, "jcr:content/jcr:title": "Master" },
        ],
      };
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

  const result = await getExperienceFragmentTree({ basePath });
  const payload = parseToolResult(result);
  const nodes = payload["nodes"] as Array<Record<string, unknown>>;

  assert.equal(nodes.length, 3);
  assert.match(String(payload["tree"]), /cookies-modal\/\n.*master/s);
  assert.deepEqual(payload["stats"], {
    fragmentCount: 3,
    variationCount: 3,
    totalNodeCount: 12,
  });
});
