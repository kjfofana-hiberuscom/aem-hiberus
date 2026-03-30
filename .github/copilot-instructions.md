# Confluence MCP Server — Project Instructions

## Project Overview

MCP (Model Context Protocol) server for Confluence integration, built with TypeScript and the official `@modelcontextprotocol/sdk`.

## Stack

- **Runtime:** Node.js (ES2022)
- **Language:** TypeScript strict mode
- **SDK:** `@modelcontextprotocol/sdk` (v1.24+)
- **Transport:** Stdio (default) — supports SSE/Streamable HTTP for remote
- **Validation:** Zod (bundled with SDK)
- **Module system:** ESM (`"type": "module"` in package.json)

## Architecture

- Entry point: `src/index.ts`
- MCP Server instance via `McpServer` from `@modelcontextprotocol/sdk/server/mcp.js`
- Tools registered with `server.registerTool()` using Zod schemas for input validation
- Resources registered with `server.registerResource()` for read-only data
- Prompts registered with `server.registerPrompt()` for reusable templates
- Transport via `StdioServerTransport` from `@modelcontextprotocol/sdk/server/stdio.js`

## Code Standards

- Use `async/await` consistently — never raw `.then()` chains
- All tool handlers must return `{ content: [{ type: "text", text: string }] }`
- Use Zod schemas (`.describe()`) for all tool input parameters
- Log to `console.error()` only — **never** `console.log()` (corrupts stdio JSON-RPC)
- Handle errors gracefully — return error messages as text content, don't throw unhandled
- Type all interfaces explicitly — no `any`
- Use descriptive `title` and `description` in tool/resource/prompt registration

## MCP Conventions

- One tool = one operation (single responsibility)
- Tools are model-controlled (LLM decides when to use them)
- Resources are application-controlled (read-only data access)
- Prompts are user-controlled (explicit invocation)
- Each resource has a unique URI scheme (e.g., `confluence://pages/{id}`)

## Build & Run

- Build: `npm run build` (runs `tsc`)
- Output: `./build/`
- The server communicates via stdin/stdout JSON-RPC — test with MCP Inspector or Claude Desktop
