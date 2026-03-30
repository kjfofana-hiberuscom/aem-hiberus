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

function getTemplatesPath(sitePath: string): string {
  let p = sitePath.trim().replace(/\/+$/, "");
  if (p.startsWith("/content/")) p = p.replace("/content", "");
  if (!p.startsWith("/conf")) p = `/conf/${p.replace(/^\//, "")}`;
  if (!p.endsWith("/settings/wcm/templates")) p += "/settings/wcm/templates";
  return p;
}

export function registerTemplateTools(
  server: McpServer,
  client: AemClient,
  _config: AemConfig
): void {
  // -------------------------------------------------------------------------
  // getTemplates
  // -------------------------------------------------------------------------
  server.registerTool(
    "getTemplates",
    {
      description: "List AEM editable templates for a site or globally",
      inputSchema: {
        sitePath: z.string().optional().describe("Site path (e.g. /content/my-site or my-site). Omit for global templates."),
      },
    },
    async ({ sitePath }) => {
      try {
        if (sitePath) {
          const confPath = getTemplatesPath(sitePath);
          try {
            const data = await client.get(`${confPath}.2.json`);
            const templates: unknown[] = [];
            for (const [key, value] of Object.entries(data as Record<string, any>)) {
              if (key.startsWith("jcr:") || key.startsWith("sling:")) continue;
              const v = value as any;
              if (v && typeof v === "object" && v["jcr:content"]) {
                templates.push({
                  name: key,
                  path: `${confPath}/${key}`,
                  title: v["jcr:content"]["jcr:title"] || key,
                  description: v["jcr:content"]["jcr:description"],
                  allowedPaths: v["jcr:content"]["allowedPaths"],
                  ranking: v["jcr:content"]["ranking"] || 0,
                  status: v["jcr:content"]["status"] || "enabled",
                });
              }
            }
            return ok({ sitePath, templates, totalCount: templates.length, source: "site-specific" });
          } catch {}
        }

        // Fallback: global paths
        const globalPaths = [
          "/apps/wcm/core/content/sites/templates",
          "/libs/wcm/core/content/sites/templates",
        ];
        const allTemplates: unknown[] = [];
        for (const tplPath of globalPaths) {
          try {
            const data = await client.get(`${tplPath}.json`, { ":depth": "2" });
            for (const [key, value] of Object.entries(data as Record<string, any>)) {
              if (key.startsWith("jcr:") || key.startsWith("sling:")) continue;
              const v = value as any;
              if (v && typeof v === "object") {
                allTemplates.push({
                  name: key,
                  path: `${tplPath}/${key}`,
                  title: v["jcr:content"]?.["jcr:title"] || key,
                  description: v["jcr:content"]?.["jcr:description"],
                  allowedPaths: v["jcr:content"]?.["allowedPaths"],
                  ranking: v["jcr:content"]?.["ranking"] || 0,
                  source: tplPath.includes("/apps/") ? "apps" : "libs",
                });
              }
            }
          } catch {}
        }
        return ok({ sitePath: sitePath || "global", templates: allTemplates, totalCount: allTemplates.length, source: "global" });
      } catch (e: any) {
        return err(`getTemplates failed: ${e.message}`);
      }
    }
  );

  // -------------------------------------------------------------------------
  // getTemplateStructure
  // -------------------------------------------------------------------------
  server.registerTool(
    "getTemplateStructure",
    {
      description: "Get the detailed structure of an AEM editable template",
      inputSchema: {
        templatePath: z.string().describe("Full path to the template (e.g. /conf/my-site/settings/wcm/templates/content-page)"),
      },
    },
    async ({ templatePath }) => {
      try {
        const response = await client.get(`${templatePath}.infinity.json`);
        const jcrContent = response["jcr:content"] || {};

        const allowedComponents: string[] = [];
        const extractComponents = (node: any): void => {
          if (!node || typeof node !== "object") return;
          if (node["components"]) {
            allowedComponents.push(...Object.keys(node["components"]));
          }
          for (const [key, value] of Object.entries(node)) {
            if (typeof value === "object" && value !== null && !key.startsWith("jcr:")) {
              extractComponents(value);
            }
          }
        };
        extractComponents(jcrContent["policies"] || {});

        return ok({
          templatePath,
          structure: {
            path: templatePath,
            title: jcrContent["jcr:title"] || "",
            description: jcrContent["jcr:description"] || "",
            allowedPaths: jcrContent["allowedPaths"] || [],
            allowedComponents: [...new Set(allowedComponents)],
            policies: jcrContent["policies"] || {},
            structure: jcrContent["structure"] || {},
            initialContent: jcrContent["initial"] || {},
          },
          fullData: response,
        });
      } catch (e: any) {
        return err(`getTemplateStructure failed: ${e.message}`);
      }
    }
  );
}
