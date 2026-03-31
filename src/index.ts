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

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

function buildMcpServer(config: ReturnType<typeof loadConfig>): McpServer {
  const client = new AemClient(config);

  const server = new McpServer({
    name: "mcp-aem-hiberus",
    version: "1.0.0",
    description: "AEM MCP Server — 42 tools covering sites, pages, components, search, templates, publishing, workflows, content fragments, experience fragments, clone operations and tree exploration",
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

  const httpServer = createServer(async (req, res) => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    const server = buildMcpServer(config);
    await server.connect(transport);
    await transport.handleRequest(req, res);
  });

  httpServer.listen(port, () => {
    console.error(
      `[mcp-aem-hiberus] http | port=${port} | aemUrl=${config.aemUrl} | readOnly=${config.readOnly}`
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
