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

function getTemplatesPaths(sitePath: string): string[] {
  const paths: string[] = [];

  // Primary: strip /content prefix, prepend /conf
  let p = sitePath.trim().replace(/\/+$/, "");
  if (p.startsWith("/content/")) p = p.replace("/content", "");
  if (!p.startsWith("/conf")) p = `/conf/${p.replace(/^\//, "")}`;
  if (!p.endsWith("/settings/wcm/templates")) p += "/settings/wcm/templates";
  paths.push(p);

  // Secondary: /conf/{last-segment}/settings/wcm/templates
  const lastSegment = sitePath.trim().replace(/\/+$/, "").split("/").filter(Boolean).pop() ?? "";
  if (lastSegment) {
    const lastSegPath = `/conf/${lastSegment}/settings/wcm/templates`;
    if (lastSegPath !== p) paths.push(lastSegPath);
  }

  return paths;
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
        confPath: z.string().optional().describe("Direct /conf path to the templates folder (e.g. /conf/my-site/settings/wcm/templates). Takes priority over sitePath if provided."),
      },
    },
    async ({ sitePath, confPath }) => {
      try {
        // Build ordered list of candidate conf paths to attempt
        const candidates: string[] = [];
        if (confPath) {
          let cp = confPath.trim().replace(/\/+$/, "");
          if (!cp.endsWith("/settings/wcm/templates")) cp += "/settings/wcm/templates";
          candidates.push(cp);
        } else if (sitePath) {
          candidates.push(...getTemplatesPaths(sitePath));
        }

        for (const candidatePath of candidates) {
          try {
            const data = await client.get(`${candidatePath}.2.json`);
            const templates: unknown[] = [];
            for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
              if (key.startsWith("jcr:") || key.startsWith("sling:")) continue;
              const v = value as Record<string, unknown>;
              if (v && typeof v === "object" && v["jcr:content"]) {
                const content = v["jcr:content"] as Record<string, unknown>;
                templates.push({
                  name: key,
                  path: `${candidatePath}/${key}`,
                  title: content["jcr:title"] || key,
                  description: content["jcr:description"],
                  allowedPaths: content["allowedPaths"],
                  ranking: content["ranking"] || 0,
                  status: content["status"] || "enabled",
                });
              }
            }
            return ok({
              sitePath: sitePath ?? confPath,
              templates,
              totalCount: templates.length,
              source: "site-specific",
              resolvedPath: candidatePath,
            });
          } catch { /* try next candidate */ }
        }

        if (candidates.length > 0) {
          // All candidates failed — fall through to global
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
            for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
              if (key.startsWith("jcr:") || key.startsWith("sling:")) continue;
              const v = value as Record<string, unknown>;
              if (v && typeof v === "object") {
                const content = (v["jcr:content"] ?? {}) as Record<string, unknown>;
                allTemplates.push({
                  name: key,
                  path: `${tplPath}/${key}`,
                  title: content["jcr:title"] || key,
                  description: content["jcr:description"],
                  allowedPaths: content["allowedPaths"],
                  ranking: content["ranking"] || 0,
                  source: tplPath.includes("/apps/") ? "apps" : "libs",
                });
              }
            }
          } catch {}
        }
        return ok({ sitePath: sitePath ?? confPath ?? "global", templates: allTemplates, totalCount: allTemplates.length, source: "global" });
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
