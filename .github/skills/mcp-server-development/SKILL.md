---
name: mcp-server-development
description: "MCP server development with TypeScript and @modelcontextprotocol/sdk. Use when creating tools, resources, prompts, configuring transport, handling errors, or following MCP protocol patterns for building model context protocol servers."
metadata:
  author: "mcp-skeleton"
  version: "2.0"
  sdk-version: "1.24+"
  source: "https://modelcontextprotocol.io + https://ts.sdk.modelcontextprotocol.io"
---

# MCP Server Development Skill

> Based on the official MCP specification and TypeScript SDK documentation.
> Source: https://modelcontextprotocol.io · https://ts.sdk.modelcontextprotocol.io

---

## 1. MCP Core Concepts

MCP servers expose three types of capabilities to clients:

| Primitive      | Controlled by | Purpose                                                        | Protocol methods                                   |
| -------------- | ------------- | -------------------------------------------------------------- | -------------------------------------------------- |
| **Tools**      | Model (LLM)   | Functions the LLM can invoke (computation, APIs, side effects) | `tools/list`, `tools/call`                         |
| **Resources**  | Application    | Read-only data access (files, configs, APIs, databases)        | `resources/list`, `resources/read`, `resources/subscribe` |
| **Prompts**    | User           | Reusable templates for consistent interactions                 | `prompts/list`, `prompts/get`                      |

### How it works (message flow)

```
User → Client → LLM analyzes available tools
                 LLM decides which tool(s) to use
Client → MCP Server (tools/call)
MCP Server → executes operation → returns result
Client → LLM → formulates natural language response → User
```

---

## 2. SDK Setup (TypeScript)

### Installation

```bash
npm install @modelcontextprotocol/sdk zod
npm install -D @types/node typescript
```

> The SDK has a **required peer dependency on `zod`** for schema validation.

### Required imports

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
```

### Server instantiation

```typescript
const server = new McpServer({
  name: "server-name",     // unique server identifier
  version: "1.0.0",        // semver
});
```

### Transport & startup (stdio)

```typescript
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
```

### TypeScript project configuration

**package.json essentials:**

```json
{
  "type": "module",
  "scripts": {
    "build": "tsc"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.24.3"
  },
  "devDependencies": {
    "@types/node": "^22.x",
    "typescript": "^5.x"
  }
}
```

**tsconfig.json essentials:**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "./build",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules"]
}
```

---

## 3. Tools — Complete Reference

Tools let LLMs ask your server to take actions. They are the primary way models call into your application.

### 3.1 Basic registration

```typescript
server.registerTool(
  "tool-name",           // unique identifier (kebab-case)
  {
    title: "Human Readable Title",
    description: "Clear description of what it does and when to use it",
    inputSchema: {
      paramName: z.string().describe("What this parameter is"),
      optionalParam: z.number().optional().describe("Optional numeric param"),
    },
  },
  async ({ paramName, optionalParam }) => {
    const result = await someOperation(paramName);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },
);
```

### 3.2 Structured output with `outputSchema`

Tools can define an output schema for typed, validated results. When `outputSchema` is defined, the handler **must** return `structuredContent` AND a serialized text fallback for backwards compatibility:

```typescript
server.registerTool(
  "calculate-bmi",
  {
    title: "BMI Calculator",
    description: "Calculate Body Mass Index",
    inputSchema: {
      weightKg: z.number().describe("Weight in kilograms"),
      heightM: z.number().describe("Height in meters"),
    },
    outputSchema: {
      bmi: z.number().describe("Calculated BMI value"),
    },
  },
  async ({ weightKg, heightM }) => {
    const output = { bmi: weightKg / (heightM * heightM) };
    return {
      content: [{ type: "text", text: JSON.stringify(output) }],
      structuredContent: output,
    };
  },
);
```

### 3.3 Error handling with `isError`

Two error mechanisms exist:
1. **Protocol errors** — JSON-RPC errors (unknown tool, invalid arguments)
2. **Tool execution errors** — returned in result with `isError: true`

```typescript
server.registerTool(
  "risky-operation",
  {
    description: "An operation that might fail",
    inputSchema: { input: z.string().describe("Input data") },
  },
  async ({ input }) => {
    try {
      const result = await doSomething(input);
      return { content: [{ type: "text", text: result }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);
```

### 3.4 Content types in tool results

Tools can return multiple content types in the `content` array:

#### Text content (most common)

```typescript
{ type: "text", text: "Result text here" }
```

#### Image content

```typescript
{
  type: "image",
  data: "base64-encoded-png-data",
  mimeType: "image/png",
}
```

#### Audio content

```typescript
{
  type: "audio",
  data: "base64-encoded-audio-data",
  mimeType: "audio/wav",
}
```

#### Embedded resource content

```typescript
{
  type: "resource",
  resource: {
    uri: "data://result",
    mimeType: "application/json",
    text: JSON.stringify({ key: "value" }),
  },
}
```

#### Resource link content (reference without embedding)

```typescript
{
  type: "resource_link",
  uri: "file:///project/src/main.ts",
  name: "main.ts",
  description: "Primary entry point",
  mimeType: "text/typescript",
}
```

### 3.5 Content annotations

All content types support optional annotations for metadata:

```typescript
{
  type: "text",
  text: "Result for the user",
  annotations: {
    audience: ["user"],        // "user" | "assistant" | both
    priority: 0.9,             // 0.0 to 1.0
  },
}
```

### 3.6 Tool change notifications

When tools are added/removed/updated at runtime, the server auto-notifies clients. You can also trigger manually:

```typescript
server.sendToolListChanged();
```

### 3.7 Tool definition fields (spec)

| Field           | Required | Description                                           |
| --------------- | -------- | ----------------------------------------------------- |
| `name`          | Yes      | Unique kebab-case identifier                          |
| `title`         | No       | Human-readable display name                           |
| `description`   | No       | What the tool does (LLM reads this to decide usage)   |
| `inputSchema`   | Yes      | Zod schema defining expected parameters               |
| `outputSchema`  | No       | Zod schema defining structured output                 |
| `annotations`   | No       | Metadata about tool behavior                          |

### 3.8 Rules

- **One tool = one operation** (single responsibility)
- Use `.describe()` on every Zod field — the LLM reads these to decide when to use the tool
- Tool names: kebab-case, descriptive (`get-page`, `search-spaces`, `create-page`)
- Handle errors in the handler — return error text with `isError: true`, don't throw unhandled
- Return `structuredContent` + text fallback when using `outputSchema`

---

## 4. Resources — Complete Reference

Resources expose read-only data to clients. They should not perform heavy computation or side-effects. Ideal for configuration, documents, or reference data.

### 4.1 Direct resource (fixed URI)

```typescript
server.registerResource(
  "resource-name",
  "scheme://path/to/resource",
  {
    title: "Resource Title",
    description: "What data this resource exposes",
    mimeType: "application/json",
  },
  async (uri) => ({
    contents: [{
      uri: uri.href,
      text: JSON.stringify(data),
    }],
  }),
);
```

### 4.2 Resource templates (dynamic URIs)

Dynamic resources use `ResourceTemplate` to match URI patterns. Parameters are passed to the callback:

```typescript
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";

server.registerResourceTemplate(
  "template-name",
  new ResourceTemplate("myserver://pages/{pageId}", { list: undefined }),
  {
    title: "Page Content",
    description: "Retrieve a page by its ID",
    mimeType: "text/plain",
  },
  async (uri, { pageId }) => ({
    contents: [{
      uri: uri.href,
      text: await fetchPageContent(pageId as string),
    }],
  }),
);
```

### 4.3 Binary resources

Resources can return binary data using `blob` (base64-encoded) instead of `text`:

```typescript
server.registerResource(
  "logo",
  "images://logo.png",
  { title: "Logo", mimeType: "image/png" },
  async (uri) => ({
    contents: [{ uri: uri.href, blob: logoPngBase64 }],
  }),
);
```

### 4.4 Resource subscriptions

Clients can subscribe to resource changes. Notify when a resource changes:

```typescript
import { SubscribeRequestSchema, UnsubscribeRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const subscriptions = new Set<string>();

server.server.setRequestHandler(SubscribeRequestSchema, async (request) => {
  subscriptions.add(request.params.uri);
  return {};
});

server.server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
  subscriptions.delete(request.params.uri);
  return {};
});

// When a resource changes:
if (subscriptions.has(resourceUri)) {
  await server.server.sendResourceUpdated({ uri: resourceUri });
}
```

### 4.5 Resource list change notifications

```typescript
server.sendResourceListChanged();
```

### 4.6 URI scheme conventions

- Use a descriptive scheme: `myserver://pages/{id}`, `myserver://spaces/{key}`
- Direct resources: fixed URIs for specific, known data
- Templates: dynamic URIs with `{param}` placeholders for discoverable data

---

## 5. Prompts — Complete Reference

Prompts are reusable templates that help users (or client UIs) talk to models consistently. They are declared on the server and listed through MCP.

### 5.1 Basic prompt

```typescript
server.registerPrompt(
  "review-code",
  {
    title: "Code Review",
    description: "Review code for best practices and potential issues",
    argsSchema: {
      code: z.string().describe("The code to review"),
    },
  },
  ({ code }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `Please review this code:\n\n${code}`,
        },
      },
    ],
  }),
);
```

### 5.2 Multi-message prompts

```typescript
server.registerPrompt(
  "debug-error",
  {
    title: "Debug Error",
    description: "Help debug an error with context",
    argsSchema: {
      error: z.string().describe("The error message"),
      context: z.string().optional().describe("Additional context"),
    },
  },
  ({ error, context }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `I'm getting this error: ${error}${context ? `\n\nContext: ${context}` : ""}`,
        },
      },
    ],
  }),
);
```

### 5.3 Prompts with image content

```typescript
server.registerPrompt(
  "analyze-image",
  {
    title: "Analyze Image",
    description: "Analyze an image",
    argsSchema: { imageBase64: z.string().describe("Base64-encoded image data") },
  },
  ({ imageBase64 }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "image",
          data: imageBase64,
          mimeType: "image/png",
        },
      },
    ],
  }),
);
```

### 5.4 Prompts with embedded resources

```typescript
server.registerPrompt(
  "summarize-doc",
  {
    title: "Summarize Document",
    description: "Summarize a document resource",
  },
  () => ({
    messages: [
      {
        role: "user",
        content: {
          type: "resource",
          resource: {
            uri: "docs://readme",
            mimeType: "text/plain",
            text: "Document content here...",
          },
        },
      },
    ],
  }),
);
```

### 5.5 Prompt change notifications

```typescript
server.sendPromptListChanged();
```

---

## 6. Completions (Autocomplete)

Both prompts and resources support argument completions using the `completable` wrapper. This lets clients offer autocomplete suggestions as users type.

```typescript
import { completable } from "@modelcontextprotocol/sdk/server/completable.js";

server.registerPrompt(
  "greet",
  {
    title: "Greeting",
    description: "Generate a greeting",
    argsSchema: {
      name: completable(z.string(), (value) => {
        const names = ["Alice", "Bob", "Charlie"];
        return names.filter((n) => n.toLowerCase().startsWith(value.toLowerCase()));
      }),
    },
  },
  ({ name }) => ({
    messages: [{ role: "user", content: { type: "text", text: `Hello, ${name}!` } }],
  }),
);
```

Resource templates also support completions on their path parameters via `completable`.

---

## 7. Logging

The server can send structured log messages to the client via `server.sendLoggingMessage()`. Clients can request a minimum log level via `logging/setLevel` — messages below the level are suppressed automatically.

```typescript
// Enable logging capability
const server = new McpServer(
  { name: "my-server", version: "1.0.0" },
  { capabilities: { logging: {} } },
);

// Send log messages from tool handlers
server.registerTool(
  "process-data",
  {
    description: "Process some data",
    inputSchema: { data: z.string().describe("Data to process") },
  },
  async ({ data }, extra) => {
    await server.sendLoggingMessage(
      { level: "info", data: `Processing: ${data}` },
      extra.sessionId,
    );
    // ... do work ...
    return { content: [{ type: "text", text: "Done" }] };
  },
);
```

**Log levels** (in order): `debug` → `info` → `notice` → `warning` → `error` → `critical` → `alert` → `emergency`

---

## 8. Transport Options

| Transport              | Use case                          | Status                        |
| ---------------------- | --------------------------------- | ----------------------------- |
| **Stdio**              | Local/desktop, process-spawned    | ✅ Recommended for local      |
| **Streamable HTTP**    | Remote servers                    | ✅ Recommended for remote     |
| **HTTP + SSE**         | Remote (legacy)                   | ⚠️ Deprecated — backwards compat only |

### 8.1 Stdio (local servers)

Communication over stdin/stdout using JSON-RPC. Simplest transport — no HTTP setup required.

```typescript
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const transport = new StdioServerTransport();
await server.connect(transport);
```

### 8.2 Streamable HTTP (remote servers)

Modern, fully-featured transport supporting:
- Request/response over HTTP POST
- Server-to-client notifications over SSE
- Optional JSON-only response mode (no SSE)
- Session management and resumability
- Stateless or stateful modes

```typescript
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
```

### 8.3 Client configuration (Claude Desktop example)

```json
{
  "mcpServers": {
    "my-server": {
      "command": "node",
      "args": ["C:\\absolute\\path\\to\\build\\index.js"]
    }
  }
}
```

> On Windows, use double backslashes (`\\`) or forward slashes (`/`) in paths.

### 8.4 VS Code MCP configuration

```json
{
  "mcp": {
    "servers": {
      "my-server": {
        "type": "stdio",
        "command": "node",
        "args": ["${workspaceFolder}/build/index.js"]
      }
    }
  }
}
```

---

## 9. Logging Rules (CRITICAL for Stdio)

For **stdio-based servers**, stdout is reserved for JSON-RPC messages. Writing anything else to stdout **corrupts the transport**.

```typescript
// ❌ BAD — corrupts stdio JSON-RPC transport
console.log("Processing request");
print("anything");

// ✅ GOOD — writes to stderr, invisible to transport
console.error("Processing request");
```

> This is the **#1 cause of broken MCP servers**. For HTTP-based servers, standard output is fine.

---

## 10. Error Handling Patterns

### 10.1 API helper with typed error handling

```typescript
interface ApiConfig {
  baseUrl: string;
  headers: Record<string, string>;
}

async function apiRequest<T>(config: ApiConfig, endpoint: string): Promise<T | null> {
  try {
    const response = await fetch(`${config.baseUrl}${endpoint}`, {
      headers: config.headers,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    return (await response.json()) as T;
  } catch (error) {
    console.error(`API error (${endpoint}):`, error);
    return null;
  }
}
```

### 10.2 Tool handler error pattern

```typescript
async ({ param }) => {
  const data = await apiRequest<MyType>(config, `/endpoint/${param}`);
  if (!data) {
    return {
      content: [{ type: "text", text: `Failed to retrieve data for: ${param}` }],
      isError: true,
    };
  }
  return {
    content: [{ type: "text", text: formatResult(data) }],
  };
}
```

### 10.3 Main entry error handling

```typescript
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
```

---

## 11. Security Considerations (from MCP spec)

### Servers MUST:

- Validate all tool inputs (Zod handles this automatically)
- Implement proper access controls
- Rate limit tool invocations where appropriate
- Sanitize tool outputs

### Clients SHOULD:

- Prompt for user confirmation on sensitive operations
- Show tool inputs to user before calling server
- Validate tool results before passing to LLM
- Implement timeouts for tool calls
- Log tool usage for audit purposes

---

## 12. Complete Server Skeleton

Copy this as a starting point for any new MCP server:

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// ============================================================
// Server Configuration
// ============================================================

const SERVER_NAME = "my-mcp-server";
const SERVER_VERSION = "1.0.0";

const server = new McpServer({
  name: SERVER_NAME,
  version: SERVER_VERSION,
});

// ============================================================
// Types & Interfaces
// ============================================================

interface ExampleApiResponse {
  id: string;
  title: string;
  content: string;
}

// ============================================================
// API Helpers
// ============================================================

const API_BASE = "https://api.example.com";

async function apiRequest<T>(endpoint: string): Promise<T | null> {
  try {
    const response = await fetch(`${API_BASE}${endpoint}`, {
      headers: {
        Accept: "application/json",
        // Authorization: `Bearer ${process.env.API_TOKEN}`,
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    return (await response.json()) as T;
  } catch (error) {
    console.error(`API error (${endpoint}):`, error);
    return null;
  }
}

// ============================================================
// Tools
// ============================================================

server.registerTool(
  "get-item",
  {
    title: "Get Item",
    description: "Retrieve an item by its ID",
    inputSchema: {
      id: z.string().describe("The unique ID of the item"),
    },
  },
  async ({ id }) => {
    const data = await apiRequest<ExampleApiResponse>(`/items/${encodeURIComponent(id)}`);
    if (!data) {
      return {
        content: [{ type: "text", text: `Failed to retrieve item: ${id}` }],
        isError: true,
      };
    }
    return {
      content: [
        {
          type: "text",
          text: [
            `Title: ${data.title}`,
            `Content: ${data.content}`,
          ].join("\n"),
        },
      ],
    };
  },
);

server.registerTool(
  "search-items",
  {
    title: "Search Items",
    description: "Search for items by query string",
    inputSchema: {
      query: z.string().describe("Search query"),
      limit: z.number().min(1).max(50).optional().describe("Max results (default 10)"),
    },
  },
  async ({ query, limit }) => {
    const maxResults = limit ?? 10;
    const data = await apiRequest<ExampleApiResponse[]>(
      `/items/search?q=${encodeURIComponent(query)}&limit=${maxResults}`,
    );
    if (!data) {
      return {
        content: [{ type: "text", text: `Search failed for: ${query}` }],
        isError: true,
      };
    }
    if (data.length === 0) {
      return {
        content: [{ type: "text", text: `No results found for: ${query}` }],
      };
    }
    const formatted = data.map((item) => `- [${item.id}] ${item.title}`).join("\n");
    return {
      content: [{ type: "text", text: `Found ${data.length} results:\n\n${formatted}` }],
    };
  },
);

// ============================================================
// Resources
// ============================================================

// Direct resource (fixed URI)
server.registerResource(
  "server-status",
  "myserver://status",
  {
    title: "Server Status",
    description: "Current server status and configuration",
    mimeType: "application/json",
  },
  async (uri) => ({
    contents: [
      {
        uri: uri.href,
        text: JSON.stringify({
          name: SERVER_NAME,
          version: SERVER_VERSION,
          status: "running",
        }),
      },
    ],
  }),
);

// Resource template (dynamic URI)
server.registerResourceTemplate(
  "item-resource",
  new ResourceTemplate("myserver://items/{itemId}", { list: undefined }),
  {
    title: "Item Detail",
    description: "Get full detail of an item by ID",
    mimeType: "application/json",
  },
  async (uri, { itemId }) => {
    const data = await apiRequest<ExampleApiResponse>(
      `/items/${encodeURIComponent(itemId as string)}`,
    );
    return {
      contents: [
        {
          uri: uri.href,
          text: data ? JSON.stringify(data, null, 2) : `Item not found: ${itemId}`,
        },
      ],
    };
  },
);

// ============================================================
// Prompts
// ============================================================

server.registerPrompt(
  "summarize-item",
  {
    title: "Summarize Item",
    description: "Generate a summary of an item",
    argsSchema: {
      itemId: z.string().describe("ID of the item to summarize"),
    },
  },
  async ({ itemId }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `Please summarize the following item (ID: ${itemId}). Focus on the key points and keep it concise.`,
        },
      },
    ],
  }),
);

// ============================================================
// Server Startup
// ============================================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`${SERVER_NAME} v${SERVER_VERSION} running on stdio`);
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
```

---

## 13. New Server Quickstart Checklist

### Project setup

- [ ] `npm init -y` and set `"type": "module"` in package.json
- [ ] `npm install @modelcontextprotocol/sdk zod`
- [ ] `npm install -D @types/node typescript`
- [ ] Create `tsconfig.json` with `ES2022` target, `Node16` module, `strict: true`
- [ ] Create `src/index.ts` as entry point
- [ ] Add `"build": "tsc"` to scripts
- [ ] Add shebang `#!/usr/bin/env node` to index.ts if creating CLI binary

### Implementation

- [ ] Instantiate `McpServer` with name and version
- [ ] Define TypeScript interfaces for all API responses
- [ ] Create API helper function(s) with error handling
- [ ] Register tools with Zod schemas (`.describe()` on every field)
- [ ] Register resources for read-only data access
- [ ] Register prompts for common workflows
- [ ] Error handling returns text with `isError: true` — never throws
- [ ] No `console.log()` anywhere — only `console.error()`
- [ ] No `any` types — explicit interfaces everywhere
- [ ] Connect transport and start in `main()`

### Validation

- [ ] `npm run build` passes with zero errors
- [ ] Test with MCP Inspector or Claude Desktop
- [ ] Tool names are kebab-case and descriptive
- [ ] Resource URIs follow `scheme://type/identifier` pattern
- [ ] All Zod fields have `.describe()` for LLM discoverability

### Client configuration

- [ ] Add server config to Claude Desktop (`claude_desktop_config.json`)
- [ ] Or add to VS Code settings (`mcp.servers` in settings.json)
- [ ] Verify tools appear in client's tool list

---

## 14. Reference Links

- MCP Specification: https://modelcontextprotocol.io/specification
- TypeScript SDK Docs: https://ts.sdk.modelcontextprotocol.io
- Server Guide: https://ts.sdk.modelcontextprotocol.io/documents/server.html
- Build Server Tutorial: https://modelcontextprotocol.io/docs/develop/build-server
- Example Servers: https://github.com/modelcontextprotocol/servers
- SDK Repository: https://github.com/modelcontextprotocol/typescript-sdk
