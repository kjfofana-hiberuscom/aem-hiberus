/**
 * mcp-aem-hiberus — AEM MCP Server
 *
 * Transport selection via MCP_TRANSPORT env var:
 *   MCP_TRANSPORT=stdio  (default)
 *   MCP_TRANSPORT=http   — Streamable HTTP on PORT (default 3000)
 *
 * Required env vars:
 *   AEM_URL      — e.g. http://localhost:4502
 *   AEM_USER     — default: admin
 *   AEM_PASSWORD — default: admin
 *   AEM_READ_ONLY — set to "true" to disable write tools
 */

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { loadConfig } from "./config.js";
import { AemClient } from "./client.js";

import { registerSiteTools } from "./tools/sites.js";
import { registerPageTools } from "./tools/pages.js";
import { registerComponentTools } from "./tools/components.js";
import { registerSearchTools } from "./tools/search.js";
import { registerTemplateTools } from "./tools/templates.js";
import { registerPublishingTools } from "./tools/publishing.js";
import { registerWorkflowTools } from "./tools/workflows.js";
import { registerContentFragmentTools } from "./tools/content-fragments.js";
import { registerExperienceFragmentTools } from "./tools/experience-fragments.js";
import { registerAssetTools } from "./tools/assets.js";
import { registerCrxTools } from "./tools/crx.js";

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

function buildMcpServer(config: ReturnType<typeof loadConfig>): McpServer {
  const client = new AemClient(config);

  const server = new McpServer({
    name: "mcp-aem-hiberus",
    version: "1.0.0",
    description: "AEM MCP Server — 60 tools covering sites, pages, components, search, templates, publishing, workflows, content fragments, assets, and XF-first language automation workflows",
  });

  registerSiteTools(server, client, config);
  registerPageTools(server, client, config);
  registerComponentTools(server, client, config);
  registerSearchTools(server, client, config);
  registerTemplateTools(server, client, config);
  registerPublishingTools(server, client, config);
  registerWorkflowTools(server, client, config);
  registerContentFragmentTools(server, client, config);
  registerExperienceFragmentTools(server, client, config);
  registerAssetTools(server, client, config);
  registerCrxTools(server, client, config);

  return server;
}

// ---------------------------------------------------------------------------
// Transport: stdio (default)
// ---------------------------------------------------------------------------

async function startStdio(): Promise<void> {
  const config = loadConfig();
  const server = buildMcpServer(config); 
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[mcp-aem-hiberus] stdio | aemUrl=${config.aemUrl} | readOnly=${config.readOnly}`
  );
}

// ---------------------------------------------------------------------------
// Transport: Streamable HTTP
// ---------------------------------------------------------------------------

async function startHttp(): Promise<void> {
  const config = loadConfig();
  const port = parseInt(process.env["PORT"] ?? "3000", 10);
  if (Number.isNaN(port)) throw new Error(`Invalid PORT value: "${process.env["PORT"]}"`);

  // Session store: each connected agent gets its own transport instance.
  // Key = Mcp-Session-Id header value assigned on initialize.
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = createServer(async (req, res) => {
    try {
      const rawHeader = req.headers["mcp-session-id"];
      const sessionId = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;

      // Route to existing session
      if (sessionId) {
        const existing = sessions.get(sessionId);
        if (existing) {
          await existing.handleRequest(req, res);
          return;
        }
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Session not found" }, id: null }));
        return;
      }

      // New connection — only POST is valid here (initialize request)
      if (req.method !== "POST") {
        res.writeHead(405, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "New connections must use POST" }, id: null }));
        return;
      }

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          sessions.set(sid, transport);
          transport.onclose = () => {
            sessions.delete(sid);
            console.error(`[mcp-aem-hiberus] session closed | id=${sid} | active=${sessions.size}`);
          };
          console.error(`[mcp-aem-hiberus] session opened | id=${sid} | active=${sessions.size}`);
        },
      });

      const server = buildMcpServer(config);
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      console.error("[mcp-aem-hiberus] request error:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal error" },
          id: null,
        }));
      }
    }
  });

  // Bind to localhost only — no need to expose on all interfaces for local multi-agent use.
  httpServer.listen(port, "127.0.0.1", () => {
    console.error(
      `[mcp-aem-hiberus] http | port=${port} | host=127.0.0.1 | aemUrl=${config.aemUrl} | readOnly=${config.readOnly}`
    );
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const transport = (process.env["MCP_TRANSPORT"] ?? "stdio").toLowerCase();
  if (transport === "http") {
    await startHttp();
  } else {
    await startStdio();
  }
}

main().catch((error: unknown) => {
  console.error("[mcp-aem-hiberus] Fatal startup error:", error);
  process.exit(1);
});
