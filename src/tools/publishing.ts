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

export function registerPublishingTools(
  server: McpServer,
  client: AemClient,
  config: AemConfig
): void {
  // -------------------------------------------------------------------------
  // activatePage
  // -------------------------------------------------------------------------
  server.registerTool(
    "activatePage",
    {
      description: "Publish (activate) an AEM page to the publish tier",
      inputSchema: {
        pagePath: z.string().describe("Full JCR path of the page to publish"),
        activateTree: z.boolean().default(false).describe("If true, activate the full page tree"),
      },
    },
    async ({ pagePath, activateTree }) => {
      if (config.readOnly) return readOnlyErr();
      try {
        const fd = new URLSearchParams();
        fd.append("cmd", "Activate");
        fd.append("path", pagePath);

        if (activateTree) {
          fd.append("ignoredeactivated", "false");
          fd.append("onlymodified", "false");
          fd.append("deep", "true");
          await client.post("/libs/replication/treeactivation.html", fd);
        } else {
          await client.post("/bin/replicate.json", fd);
        }

        return ok({ success: true, activatedPath: pagePath, activateTree, timestamp: new Date().toISOString() });
      } catch (e1: any) {
        try {
          const fd2 = new URLSearchParams();
          fd2.append("cmd", "activate");
          fd2.append("path", pagePath);
          await client.post("/bin/wcmcommand", fd2);
          return ok({ success: true, activatedPath: pagePath, activateTree, fallback: "WCM command", timestamp: new Date().toISOString() });
        } catch {
          return err(`activatePage failed: ${e1.message}`);
        }
      }
    }
  );

  // -------------------------------------------------------------------------
  // deactivatePage
  // -------------------------------------------------------------------------
  server.registerTool(
    "deactivatePage",
    {
      description: "Unpublish (deactivate) an AEM page from the publish tier",
      inputSchema: {
        pagePath: z.string().describe("Full JCR path of the page to unpublish"),
        deactivateTree: z.boolean().default(false).describe("If true, deactivate the full page tree"),
      },
    },
    async ({ pagePath, deactivateTree }) => {
      if (config.readOnly) return readOnlyErr();
      try {
        const fd = new URLSearchParams();
        fd.append("cmd", "Deactivate");
        fd.append("path", pagePath);
        fd.append("ignoredeactivated", "false");
        fd.append("onlymodified", "false");
        if (deactivateTree) fd.append("deep", "true");
        await client.post("/bin/replicate.json", fd);

        return ok({ success: true, deactivatedPath: pagePath, deactivateTree, timestamp: new Date().toISOString() });
      } catch (e1: any) {
        try {
          const fd2 = new URLSearchParams();
          fd2.append("cmd", "deactivate");
          fd2.append("path", pagePath);
          await client.post("/bin/wcmcommand", fd2);
          return ok({ success: true, deactivatedPath: pagePath, deactivateTree, fallback: "WCM command", timestamp: new Date().toISOString() });
        } catch {
          return err(`deactivatePage failed: ${e1.message}`);
        }
      }
    }
  );

  // -------------------------------------------------------------------------
  // unpublishContent
  // -------------------------------------------------------------------------
  server.registerTool(
    "unpublishContent",
    {
      description: "Unpublish multiple content paths at once",
      inputSchema: {
        contentPaths: z.array(z.string()).min(1).describe("Array of JCR paths to unpublish"),
        unpublishTree: z.boolean().default(false).describe("If true, unpublish each path's full tree"),
      },
    },
    async ({ contentPaths, unpublishTree }) => {
      if (config.readOnly) return readOnlyErr();
      const results: unknown[] = [];
      for (const path of contentPaths) {
        try {
          const fd = new URLSearchParams();
          fd.append("cmd", "Deactivate");
          fd.append("path", path);
          fd.append("ignoredeactivated", "false");
          fd.append("onlymodified", "false");
          if (unpublishTree) fd.append("deep", "true");
          const data = await client.post("/bin/replicate.json", fd);
          results.push({ path, success: true, response: data });
        } catch (e: any) {
          results.push({ path, success: false, error: e.message });
        }
      }
      const allOk = results.every((r: any) => r.success);
      return ok({ success: allOk, results, unpublishedPaths: contentPaths, unpublishTree, timestamp: new Date().toISOString() });
    }
  );
}
