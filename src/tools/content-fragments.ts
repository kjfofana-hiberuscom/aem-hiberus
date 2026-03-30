import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AemClient } from "../client.js";
import type { AemConfig } from "../config.js";

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}
function err(msg: string) {
  return { content: [{ type: "text" as const, text: msg }], isError: true };
}
function readOnlyErr() {
  return err("Operation blocked: AEM_READ_ONLY=true");
}

function normalizeFragment(raw: any, path: string): object {
  const elements = raw.properties?.elements || {};
  const variations = raw.properties?.variations || {};
  return {
    path,
    title: raw.properties?.title || raw.properties?.["jcr:title"] || "",
    model: raw.properties?.["cq:model"] || "",
    description: raw.properties?.description || "",
    fields: Object.entries(elements).map(([name, el]: [string, any]) => ({
      name,
      value: el.value ?? el[":value"] ?? "",
      type: el[":type"] || "text",
    })),
    variations: Object.entries(variations).map(([name, v]: [string, any]) => ({
      name,
      title: v.title || name,
      fields: Object.entries(v.elements || {}).map(([fn, fe]: [string, any]) => ({
        name: fn,
        value: fe.value ?? fe[":value"] ?? "",
        type: fe[":type"] || "text",
      })),
    })),
    metadata: {
      created: raw.properties?.["jcr:created"],
      modified: raw.properties?.["jcr:lastModified"] || raw.properties?.["cq:lastModified"],
      createdBy: raw.properties?.["jcr:createdBy"],
      status: raw.properties?.["cq:lastReplicationAction"] || "not published",
    },
  };
}

export function registerContentFragmentTools(
  server: McpServer,
  client: AemClient,
  config: AemConfig
): void {
  // -------------------------------------------------------------------------
  // getContentFragment
  // -------------------------------------------------------------------------
  server.registerTool(
    "getContentFragment",
    {
      description: "Get a Content Fragment with all its fields and variations",
      inputSchema: {
        path: z.string().describe("Full DAM path to the Content Fragment (e.g. /content/dam/site/fragments/my-fragment)"),
      },
    },
    async ({ path }) => {
      try {
        const result = await client.get(`/api/assets${path}.json`);
        return ok(normalizeFragment(result, path));
      } catch (e: any) {
        return err(`getContentFragment failed: ${e.message}`);
      }
    }
  );

  // -------------------------------------------------------------------------
  // listContentFragments
  // -------------------------------------------------------------------------
  server.registerTool(
    "listContentFragments",
    {
      description: "List Content Fragments under a given DAM path",
      inputSchema: {
        path: z.string().describe("Root DAM path to search (e.g. /content/dam/site/fragments)"),
        model: z.string().optional().describe("Filter by model path"),
        limit: z.number().int().min(1).max(100).default(20).describe("Max results"),
        offset: z.number().int().min(0).default(0).describe("Pagination offset"),
      },
    },
    async ({ path, model, limit, offset }) => {
      try {
        const params: Record<string, any> = {
          type: "dam:Asset",
          path,
          "p.limit": limit,
          "p.offset": offset,
          orderby: "@jcr:content/jcr:lastModified",
          "orderby.sort": "desc",
        };
        if (model) {
          params["property"] = "jcr:content/data/cq:model";
          params["property.value"] = model;
        }
        const result = await client.get("/bin/querybuilder.json", params);
        const hits = result.hits || [];
        return ok({
          fragments: hits.map((h: any) => ({
            path: h.path,
            title: h["jcr:content"]?.["jcr:title"] || h.name,
            model: h["jcr:content"]?.data?.["cq:model"] || "",
            modified: h["jcr:content"]?.["jcr:lastModified"] || "",
            status: h["jcr:content"]?.["cq:lastReplicationAction"] || "not published",
          })),
          totalCount: result.total || hits.length,
          limit,
          offset,
        });
      } catch (e: any) {
        return err(`listContentFragments failed: ${e.message}`);
      }
    }
  );

  // -------------------------------------------------------------------------
  // manageContentFragment
  // -------------------------------------------------------------------------
  server.registerTool(
    "manageContentFragment",
    {
      description: "Create, update, or delete a Content Fragment",
      inputSchema: {
        action: z.enum(["create", "update", "delete"]).describe("Operation to perform"),
        fragmentPath: z.string().optional().describe("Path to the fragment (required for update/delete)"),
        parentPath: z.string().optional().describe("Parent DAM path (required for create)"),
        name: z.string().optional().describe("Node name (auto-generated from title if omitted)"),
        title: z.string().optional().describe("Fragment title (required for create)"),
        model: z.string().optional().describe("Model path (required for create)"),
        fields: z.record(z.unknown()).optional().describe("Field values to set"),
        description: z.string().optional().describe("Fragment description"),
        force: z.boolean().optional().default(false).describe("Force delete"),
      },
    },
    async ({ action, fragmentPath, parentPath, name, title, model, fields, description }) => {
      if (config.readOnly) return readOnlyErr();
      try {
        if (action === "create") {
          if (!parentPath || !title || !model) {
            return err("create requires parentPath, title, and model");
          }
          const nodeName = name || title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
          const cfPath = `${parentPath}/${nodeName}`;
          const fd = new URLSearchParams();
          fd.append("./jcr:primaryType", "dam:Asset");
          fd.append("./jcr:content/jcr:primaryType", "dam:AssetContent");
          fd.append("./jcr:content/jcr:title", title);
          fd.append("./jcr:content/data/jcr:primaryType", "nt:unstructured");
          fd.append("./jcr:content/data/cq:model", model);
          if (description) fd.append("./jcr:content/data/description", description);
          if (fields) {
            for (const [k, v] of Object.entries(fields)) {
              fd.append(`./jcr:content/data/master/${k}`, String(v));
            }
          }
          await client.post(cfPath, fd);
          return ok({ action, path: cfPath, title, model });
        }

        if (action === "update") {
          if (!fragmentPath) return err("update requires fragmentPath");
          const fd = new URLSearchParams();
          if (title) fd.append("./jcr:content/jcr:title", title);
          if (description) fd.append("./jcr:content/data/description", description);
          if (fields) {
            for (const [k, v] of Object.entries(fields)) {
              fd.append(`./jcr:content/data/master/${k}`, String(v));
            }
          }
          await client.post(fragmentPath, fd);
          return ok({ action, path: fragmentPath });
        }

        if (action === "delete") {
          if (!fragmentPath) return err("delete requires fragmentPath");
          const fd = new URLSearchParams();
          fd.append(":operation", "delete");
          await client.post(fragmentPath, fd);
          return ok({ action, path: fragmentPath });
        }

        return err(`Unknown action: ${action}`);
      } catch (e: any) {
        return err(`manageContentFragment failed: ${e.message}`);
      }
    }
  );

  // -------------------------------------------------------------------------
  // manageContentFragmentVariation
  // -------------------------------------------------------------------------
  server.registerTool(
    "manageContentFragmentVariation",
    {
      description: "Create, update, or delete a Content Fragment variation",
      inputSchema: {
        action: z.enum(["create", "update", "delete"]).describe("Operation to perform"),
        fragmentPath: z.string().describe("Path to the parent Content Fragment"),
        variationName: z.string().describe("Name of the variation"),
        title: z.string().optional().describe("Variation title (required for create)"),
        fields: z.record(z.unknown()).optional().describe("Field values to set"),
      },
    },
    async ({ action, fragmentPath, variationName, title, fields }) => {
      if (config.readOnly) return readOnlyErr();
      const variationPath = `${fragmentPath}/jcr:content/data/${variationName}`;
      try {
        if (action === "create") {
          if (!title) return err("create requires title");
          const fd = new URLSearchParams();
          fd.append("./jcr:primaryType", "nt:unstructured");
          fd.append("./jcr:title", title);
          if (fields) {
            for (const [k, v] of Object.entries(fields)) {
              fd.append(`./${k}`, String(v));
            }
          }
          await client.post(variationPath, fd);
          return ok({ action, fragmentPath, variationName, title });
        }

        if (action === "update") {
          const fd = new URLSearchParams();
          if (title) fd.append("./jcr:title", title);
          if (fields) {
            for (const [k, v] of Object.entries(fields)) {
              fd.append(`./${k}`, String(v));
            }
          }
          await client.post(variationPath, fd);
          return ok({ action, fragmentPath, variationName });
        }

        if (action === "delete") {
          const fd = new URLSearchParams();
          fd.append(":operation", "delete");
          await client.post(variationPath, fd);
          return ok({ action, fragmentPath, variationName });
        }

        return err(`Unknown action: ${action}`);
      } catch (e: any) {
        return err(`manageContentFragmentVariation failed: ${e.message}`);
      }
    }
  );
}
