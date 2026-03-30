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

export function registerSearchTools(
  server: McpServer,
  client: AemClient,
  _config: AemConfig
): void {
  // -------------------------------------------------------------------------
  // searchContent
  // -------------------------------------------------------------------------
  server.registerTool(
    "searchContent",
    {
      description: "Search AEM content using QueryBuilder API with arbitrary parameters",
      inputSchema: {
        path: z.string().default("/content").describe("Root path to search under"),
        type: z.string().default("cq:Page").describe("JCR node type to filter"),
        fulltext: z.string().optional().describe("Fulltext search term"),
        property: z.string().optional().describe("Property name for property predicate"),
        propertyValue: z.string().optional().describe("Value for the property predicate"),
        limit: z.number().int().min(1).max(200).default(20).describe("Max results"),
        offset: z.number().int().min(0).default(0).describe("Offset for pagination"),
      },
    },
    async ({ path, type, fulltext, property, propertyValue, limit, offset }) => {
      try {
        const params: Record<string, any> = {
          path,
          type,
          "p.limit": limit,
          "p.offset": offset,
          "p.hits": "full",
          orderby: "@jcr:content/cq:lastModified",
          "orderby.sort": "desc",
        };
        if (fulltext) params["fulltext"] = fulltext;
        if (property && propertyValue) {
          params["property"] = property;
          params["property.value"] = propertyValue;
        }
        const data = await client.get("/bin/querybuilder.json", params);
        return ok({ results: data.hits || [], total: data.total || 0, limit, offset });
      } catch (e: any) {
        return err(`searchContent failed: ${e.message}`);
      }
    }
  );

  // -------------------------------------------------------------------------
  // enhancedPageSearch
  // -------------------------------------------------------------------------
  server.registerTool(
    "enhancedPageSearch",
    {
      description: "Intelligent page search with multiple fallback strategies",
      inputSchema: {
        query: z.string().describe("Search term or page title fragment"),
        rootPath: z.string().default("/content").describe("Root path to search under"),
        limit: z.number().int().min(1).max(100).default(20).describe("Max results"),
      },
    },
    async ({ query, rootPath, limit }) => {
      const strategies: Array<{ name: string; params: Record<string, any> }> = [
        {
          name: "fulltext",
          params: { path: rootPath, type: "cq:Page", fulltext: query, "p.limit": limit, "p.hits": "full" },
        },
        {
          name: "title-match",
          params: {
            path: rootPath,
            type: "cq:Page",
            property: "jcr:content/jcr:title",
            "property.operation": "like",
            "property.value": `%${query}%`,
            "p.limit": limit,
            "p.hits": "full",
          },
        },
        {
          name: "path-contains",
          params: {
            path: `${rootPath}/${query}`,
            type: "cq:Page",
            "p.limit": limit,
            "p.hits": "full",
          },
        },
      ];

      for (const strategy of strategies) {
        try {
          const data = await client.get("/bin/querybuilder.json", strategy.params);
          const hits = data.hits || [];
          if (hits.length > 0) {
            return ok({ query, strategy: strategy.name, results: hits, total: data.total || hits.length, limit });
          }
        } catch {}
      }

      return ok({ query, strategy: "none", results: [], total: 0, message: "No results found" });
    }
  );

  // -------------------------------------------------------------------------
  // executeJCRQuery
  // -------------------------------------------------------------------------
  server.registerTool(
    "executeJCRQuery",
    {
      description: "Execute a fulltext search on cq:Page nodes via QueryBuilder",
      inputSchema: {
        query: z.string().min(1).describe("Fulltext search term"),
        path: z.string().default("/content").describe("JCR path to search under"),
        limit: z.number().int().min(1).max(200).default(20).describe("Max results"),
      },
    },
    async ({ query, path, limit }) => {
      try {
        if (/drop\s+table|exec\s*\(|<script/i.test(query) || query.length > 1000) {
          return err("Query contains unsafe patterns or is too long");
        }
        const data = await client.get("/bin/querybuilder.json", {
          path,
          type: "cq:Page",
          fulltext: query,
          "p.limit": limit,
          "p.hits": "full",
        });
        return ok({ query, results: data.hits || [], total: data.total || 0, limit });
      } catch (e: any) {
        return err(`executeJCRQuery failed: ${e.message}`);
      }
    }
  );

  // -------------------------------------------------------------------------
  // getNodeContent
  // -------------------------------------------------------------------------
  server.registerTool(
    "getNodeContent",
    {
      description: "Get raw JCR node content as JSON",
      inputSchema: {
        path: z.string().describe("JCR node path (e.g. /content/site/en/home/jcr:content)"),
        depth: z.number().int().min(1).max(10).default(1).describe("JSON depth"),
      },
    },
    async ({ path, depth }) => {
      try {
        const data = await client.get(`${path}.${depth}.json`);
        return ok({ path, depth, content: data, timestamp: new Date().toISOString() });
      } catch (e: any) {
        return err(`getNodeContent failed: ${e.message}`);
      }
    }
  );
}
