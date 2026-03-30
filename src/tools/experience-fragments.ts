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

export function registerExperienceFragmentTools(
  server: McpServer,
  client: AemClient,
  config: AemConfig
): void {
  // -------------------------------------------------------------------------
  // getExperienceFragment
  // -------------------------------------------------------------------------
  server.registerTool(
    "getExperienceFragment",
    {
      description: "Get an Experience Fragment with its variations",
      inputSchema: {
        path: z.string().describe("Full JCR path to the Experience Fragment (e.g. /content/experience-fragments/site/my-xf)"),
      },
    },
    async ({ path }) => {
      try {
        const pageData = await client.get(`${path}.infinity.json`);
        const jcrContent = pageData["jcr:content"] || {};

        const variations: unknown[] = [];
        for (const [childName, childData] of Object.entries(pageData as Record<string, any>)) {
          if (childName.startsWith("jcr:") || childName.startsWith("rep:") || typeof childData !== "object") continue;
          const childJcr = childData["jcr:content"];
          if (!childJcr) continue;
          const variantType = childJcr["cq:xfVariantType"];
          if (!variantType) continue;
          variations.push({
            name: childName,
            type: variantType,
            path: `${path}/${childName}`,
            title: childJcr["jcr:title"] || childName,
          });
        }

        return ok({
          path,
          title: jcrContent["jcr:title"] || "",
          template: jcrContent["cq:template"] || "",
          description: jcrContent["jcr:description"] || "",
          variations,
          tags: jcrContent["cq:tags"] || [],
          lastModified: jcrContent["cq:lastModified"] || jcrContent["jcr:lastModified"] || "",
          status: jcrContent["cq:lastReplicationAction"] || "not published",
        });
      } catch (e: any) {
        return err(`getExperienceFragment failed: ${e.message}`);
      }
    }
  );

  // -------------------------------------------------------------------------
  // listExperienceFragments
  // -------------------------------------------------------------------------
  server.registerTool(
    "listExperienceFragments",
    {
      description: "List Experience Fragments under a given path",
      inputSchema: {
        path: z.string().default("/content/experience-fragments").describe("Root path to search"),
        template: z.string().optional().describe("Filter by template path"),
        limit: z.number().int().min(1).max(100).default(20).describe("Max results"),
        offset: z.number().int().min(0).default(0).describe("Pagination offset"),
      },
    },
    async ({ path, template, limit, offset }) => {
      try {
        const params: Record<string, any> = {
          type: "cq:Page",
          path,
          property: "jcr:content/sling:resourceType",
          "property.value": "cq/experience-fragments/components/experiencefragment",
          "p.limit": limit,
          "p.offset": offset,
          orderby: "@jcr:content/cq:lastModified",
          "orderby.sort": "desc",
        };
        if (template) {
          params["2_property"] = "jcr:content/cq:template";
          params["2_property.value"] = template;
        }
        const result = await client.get("/bin/querybuilder.json", params);
        const hits = result.hits || [];
        return ok({
          fragments: hits.map((h: any) => ({
            path: h.path,
            title: h["jcr:content"]?.["jcr:title"] || h.name,
            lastModified: h["jcr:content"]?.["cq:lastModified"] || "",
          })),
          totalCount: result.total || hits.length,
          limit,
          offset,
        });
      } catch (e: any) {
        return err(`listExperienceFragments failed: ${e.message}`);
      }
    }
  );

  // -------------------------------------------------------------------------
  // manageExperienceFragment
  // -------------------------------------------------------------------------
  server.registerTool(
    "manageExperienceFragment",
    {
      description: "Create, update, or delete an Experience Fragment",
      inputSchema: {
        action: z.enum(["create", "update", "delete"]).describe("Operation to perform"),
        xfPath: z.string().optional().describe("Path to the XF (required for update/delete)"),
        parentPath: z.string().optional().describe("Parent path (required for create)"),
        name: z.string().optional().describe("Node name (auto-generated if omitted)"),
        title: z.string().optional().describe("XF title (required for create)"),
        template: z.string().optional().describe("Template path (required for create)"),
        description: z.string().optional().describe("XF description"),
        tags: z.array(z.string()).optional().describe("Tag paths"),
        force: z.boolean().optional().default(false).describe("Force delete ignoring references"),
      },
    },
    async ({ action, xfPath, parentPath, name, title, template, description, tags, force }) => {
      if (config.readOnly) return readOnlyErr();
      try {
        if (action === "create") {
          if (!parentPath || !title || !template) {
            return err("create requires parentPath, title, and template");
          }
          const nodeName = name || title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
          const newXfPath = `${parentPath}/${nodeName}`;

          const fd = new URLSearchParams();
          fd.append("./jcr:primaryType", "cq:Page");
          fd.append("./jcr:content/jcr:primaryType", "cq:PageContent");
          fd.append("./jcr:content/jcr:title", title);
          fd.append("./jcr:content/sling:resourceType", "cq/experience-fragments/components/experiencefragment");
          fd.append("./jcr:content/cq:template", template);
          if (description) fd.append("./jcr:content/jcr:description", description);
          if (tags?.length) tags.forEach((t) => fd.append("./jcr:content/cq:tags", t));
          await client.post(newXfPath, fd);

          // Create default "master" variation
          const masterFd = new URLSearchParams();
          masterFd.append("./jcr:primaryType", "cq:Page");
          masterFd.append("./jcr:content/jcr:primaryType", "cq:PageContent");
          masterFd.append("./jcr:content/jcr:title", "Master");
          masterFd.append("./jcr:content/sling:resourceType", "cq/experience-fragments/components/xfpage");
          masterFd.append("./jcr:content/cq:xfVariantType", "web");
          await client.post(`${newXfPath}/master`, masterFd);

          return ok({ action, path: newXfPath, title });
        }

        if (action === "update") {
          if (!xfPath) return err("update requires xfPath");
          const fd = new URLSearchParams();
          if (title) fd.append("./jcr:content/jcr:title", title);
          if (description) fd.append("./jcr:content/jcr:description", description);
          if (tags?.length) tags.forEach((t) => fd.append("./jcr:content/cq:tags", t));
          await client.post(xfPath, fd);
          return ok({ action, path: xfPath });
        }

        if (action === "delete") {
          if (!xfPath) return err("delete requires xfPath");
          if (!force) {
            try {
              const refs = await client.get(`${xfPath}.references.json`);
              const referencing = refs?.pages?.filter((p: any) => p.path !== xfPath) || [];
              if (referencing.length > 0) {
                return err(`Cannot delete: XF is referenced by ${referencing.length} page(s). Use force=true to override.`);
              }
            } catch {}
          }
          const fd = new URLSearchParams();
          fd.append(":operation", "delete");
          await client.post(xfPath, fd);
          return ok({ action, path: xfPath });
        }

        return err(`Unknown action: ${action}`);
      } catch (e: any) {
        return err(`manageExperienceFragment failed: ${e.message}`);
      }
    }
  );

  // -------------------------------------------------------------------------
  // manageExperienceFragmentVariation
  // -------------------------------------------------------------------------
  server.registerTool(
    "manageExperienceFragmentVariation",
    {
      description: "Create, update, or delete an Experience Fragment variation",
      inputSchema: {
        action: z.enum(["create", "update", "delete"]).describe("Operation to perform"),
        xfPath: z.string().describe("Path to the parent Experience Fragment"),
        variationName: z.string().describe("Name of the variation (e.g. 'web', 'email')"),
        variationType: z.string().default("web").describe("XF variant type (web, email, etc.)"),
        title: z.string().optional().describe("Variation title (required for create)"),
        template: z.string().optional().describe("Template path for the variation"),
      },
    },
    async ({ action, xfPath, variationName, variationType, title, template }) => {
      if (config.readOnly) return readOnlyErr();
      const variationPath = `${xfPath}/${variationName}`;
      try {
        if (action === "create") {
          if (!title) return err("create requires title");
          const fd = new URLSearchParams();
          fd.append("./jcr:primaryType", "cq:Page");
          fd.append("./jcr:content/jcr:primaryType", "cq:PageContent");
          fd.append("./jcr:content/jcr:title", title);
          fd.append("./jcr:content/sling:resourceType", "cq/experience-fragments/components/xfpage");
          fd.append("./jcr:content/cq:xfVariantType", variationType);
          if (template) fd.append("./jcr:content/cq:template", template);
          await client.post(variationPath, fd);
          return ok({ action, xfPath, variationName, variationPath, variationType, title });
        }

        if (action === "update") {
          const fd = new URLSearchParams();
          if (title) fd.append("./jcr:content/jcr:title", title);
          if (variationType) fd.append("./jcr:content/cq:xfVariantType", variationType);
          await client.post(variationPath, fd);
          return ok({ action, xfPath, variationName, variationPath });
        }

        if (action === "delete") {
          const fd = new URLSearchParams();
          fd.append(":operation", "delete");
          await client.post(variationPath, fd);
          return ok({ action, xfPath, variationName, variationPath });
        }

        return err(`Unknown action: ${action}`);
      } catch (e: any) {
        return err(`manageExperienceFragmentVariation failed: ${e.message}`);
      }
    }
  );
}
