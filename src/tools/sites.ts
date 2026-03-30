import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AemClient } from "../client.js";
import type { AemConfig } from "../config.js";

function ok(data: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function err(msg: string): { content: Array<{ type: "text"; text: string }>; isError: boolean } {
  return { content: [{ type: "text", text: msg }], isError: true };
}

export function registerSiteTools(
  server: McpServer,
  client: AemClient,
  _config: AemConfig
): void {
  // -------------------------------------------------------------------------
  // fetchSites
  // -------------------------------------------------------------------------
  server.registerTool(
    "fetchSites",
    { description: "List all AEM sites under /content" },
    async () => {
      try {
        const data = await client.get("/content.2.json");
        const sites: unknown[] = [];
        for (const [key, value] of Object.entries(data as Record<string, any>)) {
          if (key.startsWith("jcr:") || key.startsWith("sling:") || key.startsWith("rep:")) continue;
          const v = value as any;
          if (v && typeof v === "object" && v["jcr:content"]) {
            sites.push({
              name: key,
              path: `/content/${key}`,
              title: v["jcr:content"]["jcr:title"] || key,
              template: v["jcr:content"]["cq:template"],
              lastModified: v["jcr:content"]["cq:lastModified"],
            });
          }
        }
        return ok({ sites, totalCount: sites.length });
      } catch (e: any) {
        return err(`fetchSites failed: ${e.message}`);
      }
    }
  );

  // -------------------------------------------------------------------------
  // fetchLanguageMasters
  // -------------------------------------------------------------------------
  server.registerTool(
    "fetchLanguageMasters",
    {
      description: "Get language masters for a given AEM site",
      inputSchema: { site: z.string().describe("Site name under /content (e.g. 'we-retail')") },
    },
    async ({ site }) => {
      try {
        const data = await client.get(`/content/${site}.2.json`);
        const masters: unknown[] = [];
        let masterNode: any = null;
        let masterPath = "";

        for (const [key, value] of Object.entries(data as Record<string, any>)) {
          if ((key === "master" || key === "language-masters") && value && typeof value === "object") {
            masterNode = value;
            masterPath = `/content/${site}/${key}`;
          }
        }

        if (!masterNode) {
          return ok({ site, languageMasters: [], message: "No master or language-masters node found" });
        }

        for (const [key, value] of Object.entries(masterNode as Record<string, any>)) {
          if (key.startsWith("jcr:") || key.startsWith("sling:")) continue;
          const v = value as any;
          if (v && typeof v === "object") {
            masters.push({
              name: key,
              path: `${masterPath}/${key}`,
              title: v["jcr:content"]?.["jcr:title"] || v["jcr:title"] || key,
              language: v["jcr:content"]?.["jcr:language"] || v["jcr:language"] || key,
            });
          }
        }

        return ok({ site, languageMasters: masters });
      } catch (e: any) {
        return err(`fetchLanguageMasters failed: ${e.message}`);
      }
    }
  );

  // -------------------------------------------------------------------------
  // fetchAvailableLocales
  // -------------------------------------------------------------------------
  server.registerTool(
    "fetchAvailableLocales",
    {
      description: "Get available locale paths for a given AEM site",
      inputSchema: { site: z.string().describe("Site name under /content") },
    },
    async ({ site }) => {
      try {
        const data = await client.get(`/content/${site}.4.json`);
        const locales: Record<string, unknown> = {};

        const findLocales = (node: any, currentPath: string, segments: string[] = []) => {
          if (!node || typeof node !== "object") return;
          for (const [key, value] of Object.entries(node as Record<string, any>)) {
            if (
              key.startsWith("jcr:") || key.startsWith("sling:") ||
              key.startsWith("cq:") || key.startsWith("rep:") ||
              key.startsWith("oak:") || key === "jcr:content"
            ) continue;

            const v = value as any;
            if (v && typeof v === "object") {
              const childPath = `${currentPath}/${key}`;
              const newSegments = [...segments, key];
              const jcrContent = v["jcr:content"];
              const hasContent = jcrContent && typeof jcrContent === "object";
              const isLangCode = key.length === 2 || key.length === 3;
              const parentIsCountry =
                segments.length > 0 &&
                (segments[segments.length - 1].length === 2 || segments[segments.length - 1].length === 3);

              if (hasContent && isLangCode && parentIsCountry) {
                const country = segments[segments.length - 1].toUpperCase();
                const lang = key.toLowerCase();
                locales[`${lang}_${country}`] = {
                  path: childPath,
                  title: jcrContent?.["jcr:title"] || key,
                  language: jcrContent?.["jcr:language"] || `${lang}_${country}`,
                  country,
                };
              }
              findLocales(v, childPath, newSegments);
            }
          }
        };

        findLocales(data, `/content/${site}`);
        return ok({ site, locales, totalCount: Object.keys(locales).length });
      } catch (e: any) {
        return err(`fetchAvailableLocales failed: ${e.message}`);
      }
    }
  );
}
