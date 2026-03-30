---
applyTo: "src/**/*.ts"
---

# TypeScript MCP Server Rules

## ✅ ALWAYS

- Use `async/await` — never `.then()` chains
- Type all function parameters and return types explicitly
- Use Zod `.describe()` on every tool input field
- Log only via `console.error()` — never `console.log()` (corrupts stdio JSON-RPC)
- Return errors as text content in handlers — don't throw unhandled exceptions
- Use `import`/`export` (ESM) — never `require()`

## ❌ NEVER

- Use `any` type — define explicit interfaces
- Use `console.log()` — it breaks stdio transport
- Mix business logic into tool handler bodies — extract to helper functions
- Use synchronous I/O operations — everything must be async

## Patterns

### Tool handler structure

```typescript
server.registerTool("name", {
  title: "Title",
  description: "Description",
  inputSchema: { param: z.string().describe("desc") },
}, async ({ param }) => {
  const result = await helperFunction(param);
  if (!result) {
    return { content: [{ type: "text", text: "Error message" }] };
  }
  return { content: [{ type: "text", text: formatResult(result) }] };
});
```

### API helper structure

```typescript
async function apiHelper<T>(endpoint: string): Promise<T | null> {
  try {
    const response = await fetch(url, { headers });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()) as T;
  } catch (error) {
    console.error("API error:", error);
    return null;
  }
}
```
