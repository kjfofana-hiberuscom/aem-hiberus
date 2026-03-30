---
name: context7-docs
description: 'Use Context7 to look up live, up-to-date documentation and code examples for any library, framework, or package in any language or ecosystem. Trigger this skill ONLY when the user explicitly asks to use Context7, or asks to look up docs/examples for a specific library (e.g. "use context7 to check how X works", "look up the docs for Y", "find examples for Z using context7"). Do NOT trigger automatically — wait for an explicit user request. Works for any ecosystem: JavaScript/TypeScript (npm), Python (PyPI), Dart/Flutter (pub.dev), Rust (crates.io), Go modules, Java/Kotlin, and more.'
license: "MIT"
metadata:
  author: "generic"
  version: "2.0"
  lastReviewed: "2026-03-15"
---

# Context7 Docs — How to Use It

Context7 provides live documentation and code examples pulled directly from real library repositories. Use it when the user explicitly asks, to avoid relying on potentially stale training data — especially useful for rapidly evolving libraries.

---

## The Two-Step Flow

Context7 always works in two steps — you can't skip the first one.

### Step 1 — Resolve the library ID

Call `mcp__context7__resolve-library-id` with:

- `libraryName`: the package or library name (e.g. `"react"`, `"fastapi"`, `"prisma"`, `"zod"`)
- `query`: what you're trying to do (e.g. `"how to define a schema with optional fields"`)

The response gives you quality metadata for each match:

- **Source Reputation**: `High` | `Medium` | `Low` | `Unknown`
- **Benchmark Score**: 0–100 (higher = better documentation quality)
- **Code Snippets**: number of available examples
- **Library ID**: format `/org/project` (e.g. `/colinhacks/zod`)

### Step 2 — Query the docs

Call `mcp__context7__query-docs` with:

- `libraryId`: the ID obtained from step 1
- `query`: your specific question (be concrete, not vague)

---

## Quality Filter — The Most Important Rule

**Before using any documentation, evaluate the repo's quality. If it doesn't pass the filter, do not use it — it's better to have no external reference than to introduce incorrect patterns.**

### Acceptance thresholds

| Criteria          | Accept | Caution  | Reject             |
| ----------------- | ------ | -------- | ------------------ |
| Source Reputation | `High` | `Medium` | `Low` or `Unknown` |
| Benchmark Score   | ≥ 70   | 40–69    | < 40               |
| Code Snippets     | > 20   | 5–20     | < 5                |

### Decision logic

- **All criteria green** → use freely
- **Reputation `Medium` or score 40–69** → use with caution; cross-check with existing knowledge; note the uncertainty to the user
- **Reputation `Low`/`Unknown` OR score < 40** → reject entirely; tell the user the source wasn't reliable enough and fall back to training knowledge or ask them to provide the docs manually
- **Multiple results returned** → always prefer the official maintainer's repo over mirrors or forks

---

## Selecting the Right Repo

When `resolve-library-id` returns multiple matches:

1. **Prefer the official maintainer's org** — the org that publishes the package on its official registry
2. **Check the name match** — exact package name > partial match > vague match
3. **Never use forks or mirrors** unless explicitly requested by the user
4. **Versions**: if the project uses a specific version (e.g. `"zod": "^3.22.0"`), prefer `/org/project/v3.22.0` if available — version-specific docs are more accurate than HEAD

---

## Query Best Practices

A good query gets relevant snippets. A bad query gets noise.

**Good queries** (specific and actionable):

- `"How to define a recursive schema in Zod"`
- `"FastAPI dependency injection with async database session"`
- `"React useEffect cleanup function for subscriptions"`
- `"Prisma upsert with nested relation create"`

**Bad queries** (too vague):

- `"zod"`, `"how to use fastapi"`, `"react hooks"`

Be specific about what you're trying to accomplish, not just what package you're using.

---

## When to Use Context7

Only use this skill when the user explicitly asks for it. Examples of valid triggers:

- "Use Context7 to check how X works"
- "Look up the docs for Y with Context7"
- "Find examples of Z, use context7"
- "Check context7 for the latest API of [library]"

Do NOT trigger this skill automatically without user request.

## When NOT to Use Context7

- When the user has not asked for it
- For project-internal architecture or business logic questions
- When the user explicitly provides the docs or a URL to reference
- When querying returns `Low`/`Unknown` reputation — do not proceed with those results

---

## Limits

- Max **3 calls** to `resolve-library-id` per question
- Max **3 calls** to `query-docs` per question
- If you can't find reliable docs within those calls, say so clearly and fall back to training knowledge, noting the limitation

---

## Example Workflow

```
User: "Use Context7 to find how to implement optimistic updates in React Query"

1. resolve-library-id("react-query", "optimistic updates mutation")
   → Result: /tanstack/query, Reputation: High, Score: 92, Snippets: 410 ✅ Accept

2. query-docs("/tanstack/query", "how to implement optimistic updates with useMutation")
   → Returns code examples for onMutate / onError / onSettled pattern

3. Present the examples to the user and implement the feature following
   the pattern found in the docs.
```

If at step 1 the result had been `Reputation: Unknown, Score: 18` — stop there, do not call `query-docs`, and tell the user: "Context7 doesn't have a reliable source for this package. I'll use my training knowledge, but recommend verifying against the official docs."
