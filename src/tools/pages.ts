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

export function registerPageTools(
  server: McpServer,
  client: AemClient,
  config: AemConfig
): void {
  // -------------------------------------------------------------------------
  // listPages
  // -------------------------------------------------------------------------
  server.registerTool(
    "listPages",
    {
      description: "List cq:Page nodes under a site root path",
      inputSchema: {
        siteRoot: z.string().describe("Root path to list pages from (e.g. /content/my-site)"),
        depth: z.number().int().min(1).max(5).default(1).describe("Traversal depth"),
        limit: z.number().int().min(1).max(500).default(20).describe("Max number of pages to return"),
      },
    },
    async ({ siteRoot, depth, limit }) => {
      try {
        const data = await client.get(`${siteRoot}.${depth}.json`);
        const pages: unknown[] = [];

        const processNode = (node: any, currentPath: string, currentDepth: number) => {
          if (currentDepth > depth || pages.length >= limit) return;
          for (const [key, value] of Object.entries(node as Record<string, any>)) {
            if (pages.length >= limit) return;
            if (key.startsWith("jcr:") || key.startsWith("sling:") || key.startsWith("cq:") ||
                key.startsWith("rep:") || key.startsWith("oak:")) continue;
            const v = value as any;
            if (v && typeof v === "object") {
              const childPath = `${currentPath}/${key}`;
              if (v["jcr:primaryType"] === "cq:Page") {
                pages.push({
                  name: key,
                  path: childPath,
                  title: v["jcr:content"]?.["jcr:title"] || key,
                  template: v["jcr:content"]?.["cq:template"],
                  lastModified: v["jcr:content"]?.["cq:lastModified"],
                  lastModifiedBy: v["jcr:content"]?.["cq:lastModifiedBy"],
                  resourceType: v["jcr:content"]?.["sling:resourceType"],
                });
              }
              if (currentDepth < depth) processNode(v, childPath, currentDepth + 1);
            }
          }
        };

        processNode(data, siteRoot, 0);
        return ok({ siteRoot, pages, pageCount: pages.length, depth, limit });
      } catch (e: any) {
        // Fallback to QueryBuilder
        try {
          const qb = await client.get("/bin/querybuilder.json", {
            path: siteRoot,
            type: "cq:Page",
            "p.nodedepth": depth.toString(),
            "p.limit": limit.toString(),
            "p.hits": "full",
          });
          const pages = (qb.hits || []).map((h: any) => ({
            name: h.name || h.path?.split("/").pop(),
            path: h.path,
            title: h["jcr:content/jcr:title"] || h.title || h.name,
            template: h["jcr:content/cq:template"],
            lastModified: h["jcr:content/cq:lastModified"],
            lastModifiedBy: h["jcr:content/cq:lastModifiedBy"],
            resourceType: h["jcr:content/sling:resourceType"],
          }));
          return ok({ siteRoot, pages, pageCount: pages.length, depth, limit, fallback: "QueryBuilder" });
        } catch (e2: any) {
          return err(`listPages failed: ${e.message}`);
        }
      }
    }
  );

  // -------------------------------------------------------------------------
  // getPageContent
  // -------------------------------------------------------------------------
  server.registerTool(
    "getPageContent",
    {
      description: "Get full content of an AEM page (infinity JSON)",
      inputSchema: {
        pagePath: z.string().describe("Full JCR path to the page (e.g. /content/site/en/home)"),
      },
    },
    async ({ pagePath }) => {
      try {
        const data = await client.get(`${pagePath}.infinity.json`);
        return ok({ pagePath, content: data });
      } catch (e: any) {
        return err(`getPageContent failed: ${e.message}`);
      }
    }
  );

  // -------------------------------------------------------------------------
  // getPageProperties
  // -------------------------------------------------------------------------
  server.registerTool(
    "getPageProperties",
    {
      description: "Get metadata/properties of an AEM page from its jcr:content node",
      inputSchema: {
        pagePath: z.string().describe("Full JCR path to the page"),
      },
    },
    async ({ pagePath }) => {
      try {
        const data = await client.get(`${pagePath}/jcr:content.json`);
        return ok({
          pagePath,
          properties: {
            title: data["jcr:title"],
            description: data["jcr:description"],
            template: data["cq:template"],
            lastModified: data["cq:lastModified"],
            lastModifiedBy: data["cq:lastModifiedBy"],
            created: data["jcr:created"],
            createdBy: data["jcr:createdBy"],
            primaryType: data["jcr:primaryType"],
            resourceType: data["sling:resourceType"],
            tags: data["cq:tags"] || [],
            raw: data,
          },
        });
      } catch (e: any) {
        return err(`getPageProperties failed: ${e.message}`);
      }
    }
  );

  // -------------------------------------------------------------------------
  // createPage
  // -------------------------------------------------------------------------
  server.registerTool(
    "createPage",
    {
      description: "Create a new AEM page under a parent path",
      inputSchema: {
        parentPath: z.string().describe("Parent JCR path where the page will be created"),
        title: z.string().describe("Page title"),
        name: z.string().optional().describe("Page node name (auto-generated from title if omitted)"),
        template: z.string().optional().describe("Full template path (auto-selected if omitted)"),
        properties: z.record(z.unknown()).optional().describe("Additional jcr:content properties"),
      },
    },
    async ({ parentPath, title, name, template, properties = {} }) => {
      if (config.readOnly) return readOnlyErr();
      try {
        const pageName = name || title.replace(/\s+/g, "-").toLowerCase().replace(/[^a-z0-9-]/g, "");
        const newPagePath = `${parentPath}/${pageName}`;

        // Get template if not provided
        let templatePath = template;
        if (!templatePath) {
          const pathParts = parentPath.split("/");
          const siteName = pathParts[2] || "";
          const confPath = `/conf/${siteName}/settings/wcm/templates`;
          try {
            const tplData = await client.get(`${confPath}.2.json`);
            for (const [k, v] of Object.entries(tplData as Record<string, any>)) {
              if (k.startsWith("jcr:") || k.startsWith("sling:")) continue;
              if (v && typeof v === "object" && v["jcr:content"]) {
                templatePath = `${confPath}/${k}`;
                break;
              }
            }
          } catch {}
        }

        // Create page node
        const fd = new URLSearchParams();
        fd.append("jcr:primaryType", "cq:Page");
        await client.post(newPagePath, fd);

        // Create jcr:content
        const contentFd = new URLSearchParams();
        contentFd.append("jcr:primaryType", "cq:PageContent");
        contentFd.append("jcr:title", title);
        if (templatePath) contentFd.append("cq:template", templatePath);
        for (const [k, v] of Object.entries(properties)) {
          if (v !== null && v !== undefined) {
            contentFd.append(k, String(v));
          }
        }
        await client.post(`${newPagePath}/jcr:content`, contentFd);

        return ok({
          success: true,
          pagePath: newPagePath,
          title,
          templateUsed: templatePath || "none",
          timestamp: new Date().toISOString(),
        });
      } catch (e: any) {
        return err(`createPage failed: ${e.message}`);
      }
    }
  );

  // -------------------------------------------------------------------------
  // deletePage
  // -------------------------------------------------------------------------
  server.registerTool(
    "deletePage",
    {
      description: "Delete an AEM page",
      inputSchema: {
        pagePath: z.string().describe("Full JCR path to the page to delete"),
        force: z.boolean().default(false).describe("Force delete even with references"),
      },
    },
    async ({ pagePath, force }) => {
      if (config.readOnly) return readOnlyErr();
      try {
        const fd = new URLSearchParams();
        fd.append(":operation", "delete");
        await client.post(pagePath, fd);
        return ok({ success: true, deletedPath: pagePath, timestamp: new Date().toISOString() });
      } catch (e1: any) {
        try {
          const fd = new URLSearchParams();
          fd.append("cmd", "deletePage");
          fd.append("path", pagePath);
          fd.append("force", force ? "true" : "false");
          await client.post("/bin/wcmcommand", fd);
          return ok({ success: true, deletedPath: pagePath, fallback: "WCM command", timestamp: new Date().toISOString() });
        } catch (e2: any) {
          return err(`deletePage failed: ${e1.message}`);
        }
      }
    }
  );
}
