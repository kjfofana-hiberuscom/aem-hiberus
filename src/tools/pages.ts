import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AemClient } from "../client.js";
import type { AemConfig } from "../config.js";
import { cloneJcrSubtree } from "../jcr-helpers.js";
import type { AemPageCloneResult } from "../types.js";

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}
function err(msg: string) {
  return { content: [{ type: "text" as const, text: msg }], isError: true };
}
function readOnlyErr() {
  return err("Operation blocked: AEM_READ_ONLY=true");
}

export function registerPageTools(
  server: McpServer,
  client: AemClient,
  config: AemConfig
): void {
  // -------------------------------------------------------------------------
  // listPages
  // -------------------------------------------------------------------------
  server.registerTool(
    "listPages",
    {
      description: "List cq:Page nodes under a site root path",
      inputSchema: {
        siteRoot: z.string().describe("Root path to list pages from (e.g. /content/my-site)"),
        depth: z.number().int().min(1).max(5).default(1).describe("Traversal depth"),
        limit: z.number().int().min(1).max(500).default(20).describe("Max number of pages to return"),
      },
    },
    async ({ siteRoot, depth, limit }) => {
      try {
        const data = await client.get(`${siteRoot}.${depth}.json`);
        const pages: unknown[] = [];

        const processNode = (node: any, currentPath: string, currentDepth: number) => {
          if (currentDepth > depth || pages.length >= limit) return;
          for (const [key, value] of Object.entries(node as Record<string, any>)) {
            if (pages.length >= limit) return;
            if (key.startsWith("jcr:") || key.startsWith("sling:") || key.startsWith("cq:") ||
                key.startsWith("rep:") || key.startsWith("oak:")) continue;
            const v = value as any;
            if (v && typeof v === "object") {
              const childPath = `${currentPath}/${key}`;
              if (v["jcr:primaryType"] === "cq:Page") {
                pages.push({
                  name: key,
                  path: childPath,
                  title: v["jcr:content"]?.["jcr:title"] || key,
                  template: v["jcr:content"]?.["cq:template"],
                  lastModified: v["jcr:content"]?.["cq:lastModified"],
                  lastModifiedBy: v["jcr:content"]?.["cq:lastModifiedBy"],
                  resourceType: v["jcr:content"]?.["sling:resourceType"],
                });
              }
              if (currentDepth < depth) processNode(v, childPath, currentDepth + 1);
            }
          }
        };

        processNode(data, siteRoot, 0);
        return ok({ siteRoot, pages, pageCount: pages.length, depth, limit });
      } catch (e: any) {
        // Fallback to QueryBuilder
        try {
          const qb = await client.get("/bin/querybuilder.json", {
            path: siteRoot,
            type: "cq:Page",
            "p.nodedepth": depth.toString(),
            "p.limit": limit.toString(),
            "p.hits": "full",
          });
          const pages = (qb.hits || []).map((h: any) => ({
            name: h.name || h.path?.split("/").pop(),
            path: h.path,
            title: h["jcr:content/jcr:title"] || h.title || h.name,
            template: h["jcr:content/cq:template"],
            lastModified: h["jcr:content/cq:lastModified"],
            lastModifiedBy: h["jcr:content/cq:lastModifiedBy"],
            resourceType: h["jcr:content/sling:resourceType"],
          }));
          return ok({ siteRoot, pages, pageCount: pages.length, depth, limit, fallback: "QueryBuilder" });
        } catch (e2: any) {
          return err(`listPages failed: ${e.message}`);
        }
      }
    }
  );

  // -------------------------------------------------------------------------
  // getPageContent
  // -------------------------------------------------------------------------
  server.registerTool(
    "getPageContent",
    {
      description: "Get full content of an AEM page (infinity JSON)",
      inputSchema: {
        pagePath: z.string().describe("Full JCR path to the page (e.g. /content/site/en/home)"),
      },
    },
    async ({ pagePath }) => {
      try {
        const data = await client.get(`${pagePath}.infinity.json`);
        return ok({ pagePath, content: data });
      } catch (e: any) {
        return err(`getPageContent failed: ${e.message}`);
      }
    }
  );

  // -------------------------------------------------------------------------
  // getPageProperties
  // -------------------------------------------------------------------------
  server.registerTool(
    "getPageProperties",
    {
      description: "Get metadata/properties of an AEM page from its jcr:content node",
      inputSchema: {
        pagePath: z.string().describe("Full JCR path to the page"),
      },
    },
    async ({ pagePath }) => {
      try {
        const data = await client.get(`${pagePath}/jcr:content.json`);
        return ok({
          pagePath,
          properties: {
            title: data["jcr:title"],
            description: data["jcr:description"],
            template: data["cq:template"],
            lastModified: data["cq:lastModified"],
            lastModifiedBy: data["cq:lastModifiedBy"],
            created: data["jcr:created"],
            createdBy: data["jcr:createdBy"],
            primaryType: data["jcr:primaryType"],
            resourceType: data["sling:resourceType"],
            tags: data["cq:tags"] || [],
            raw: data,
          },
        });
      } catch (e: any) {
        return err(`getPageProperties failed: ${e.message}`);
      }
    }
  );

  // -------------------------------------------------------------------------
  // createPage
  // -------------------------------------------------------------------------
  server.registerTool(
    "createPage",
    {
      description: "Create a new AEM page under a parent path",
      inputSchema: {
        parentPath: z.string().describe("Parent JCR path where the page will be created"),
        title: z.string().describe("Page title"),
        name: z.string().optional().describe("Page node name (auto-generated from title if omitted)"),
        template: z.string().optional().describe("Full template path (auto-selected if omitted)"),
        properties: z.record(z.unknown()).optional().describe("Additional jcr:content properties"),
      },
    },
    async ({ parentPath, title, name, template, properties = {} }) => {
      if (config.readOnly) return readOnlyErr();
      try {
        const pageName = name || title.replace(/\s+/g, "-").toLowerCase().replace(/[^a-z0-9-]/g, "");
        const newPagePath = `${parentPath}/${pageName}`;

        // Get template if not provided
        let templatePath = template;
        if (!templatePath) {
          const pathParts = parentPath.split("/");
          const siteName = pathParts[2] || "";
          const confPath = `/conf/${siteName}/settings/wcm/templates`;
          try {
            const tplData = await client.get(`${confPath}.2.json`);
            for (const [k, v] of Object.entries(tplData as Record<string, any>)) {
              if (k.startsWith("jcr:") || k.startsWith("sling:")) continue;
              if (v && typeof v === "object" && v["jcr:content"]) {
                templatePath = `${confPath}/${k}`;
                break;
              }
            }
          } catch {}
        }

        // Create page node
        const fd = new URLSearchParams();
        fd.append("jcr:primaryType", "cq:Page");
        await client.post(newPagePath, fd);

        // Create jcr:content
        const contentFd = new URLSearchParams();
        contentFd.append("jcr:primaryType", "cq:PageContent");
        contentFd.append("jcr:title", title);
        if (templatePath) contentFd.append("cq:template", templatePath);
        for (const [k, v] of Object.entries(properties)) {
          if (v !== null && v !== undefined) {
            contentFd.append(k, String(v));
          }
        }
        await client.post(`${newPagePath}/jcr:content`, contentFd);


        return ok({
          success: true,
          pagePath: newPagePath,
          title,
          templateUsed: templatePath || "none",
          timestamp: new Date().toISOString(),
        });
      } catch (e: any) {
        return err(`createPage failed: ${e.message}`);
      }
    }
  );

  // -------------------------------------------------------------------------
  // clonePage
  // -------------------------------------------------------------------------
  server.registerTool(
    "clonePage",
    {
      description: "Clone an AEM page subtree to a new path, preserving its JCR structure. Experimental and not part of the XF-first new-language workflow.",
      inputSchema: {
        sourcePagePath: z.string().describe("Source page path to clone"),
        targetPagePath: z.string().describe("Target page path to create"),
        overwrite: z.boolean().default(false).describe("If true, delete the target subtree before cloning"),
      },
    },
    async ({ sourcePagePath, targetPagePath, overwrite }) => {
      if (config.readOnly) return readOnlyErr();
      try {
        const cloneResult = await cloneJcrSubtree(client, {
          sourcePath: sourcePagePath,
          targetPath: targetPagePath,
          overwrite,
        });

        const pageContent = cloneResult.sanitizedContent["jcr:content"] as Record<string, unknown> | undefined;
        const result: AemPageCloneResult = {
          sourcePath: cloneResult.sourcePath,
          targetPath: cloneResult.targetPath,
          overwrite: cloneResult.overwrite,
          pageTitle:
            typeof pageContent?.["jcr:title"] === "string"
              ? pageContent["jcr:title"]
              : cloneResult.verification.title,
          template: typeof pageContent?.["cq:template"] === "string" ? pageContent["cq:template"] : undefined,
          verification: cloneResult.verification,
        };

        return ok(result);
      } catch (e: any) {
        return err(`clonePage failed: ${e.message}`);
      }
    }
  );

  // -------------------------------------------------------------------------
  // deletePage
  // -------------------------------------------------------------------------
  server.registerTool(
    "deletePage",
    {
      description: "Delete an AEM page",
      inputSchema: {
        pagePath: z.string().describe("Full JCR path to the page to delete"),
        force: z.boolean().default(false).describe("Force delete even with references"),
      },
    },
    async ({ pagePath, force }) => {
      if (config.readOnly) return readOnlyErr();
      try {
        const fd = new URLSearchParams();
        fd.append(":operation", "delete");
        await client.post(pagePath, fd);
        return ok({ success: true, deletedPath: pagePath, timestamp: new Date().toISOString() });
      } catch (e1: any) {
        try {
          const fd = new URLSearchParams();
          fd.append("cmd", "deletePage");
          fd.append("path", pagePath);
          fd.append("force", force ? "true" : "false");
          await client.post("/bin/wcmcommand", fd);
          return ok({ success: true, deletedPath: pagePath, fallback: "WCM command", timestamp: new Date().toISOString() });
        } catch (e2: any) {
          return err(`deletePage failed: ${e1.message}`);
        }
      }
    }
  );

  // -------------------------------------------------------------------------
  // diffPageContent
  // -------------------------------------------------------------------------
  server.registerTool(
    "diffPageContent",
    {
      description:
        "Compare expected content (headings, texts, links, contactData) against what is actually " +
        "stored in an AEM page. Reads the live JCR tree via .infinity.json, extracts all relevant " +
        "strings recursively, and returns only the divergences plus match metrics.",
      inputSchema: {
        pagePath: z.string().describe("Full JCR path to the page (e.g. /content/site/en/home)"),
        expectedContent: z
          .object({
            headings: z
              .array(
                z.object({
                  level: z.number().int().min(1).max(6).describe("Heading level (1–6)"),
                  text: z.string().describe("Expected heading text"),
                })
              )
              .optional()
              .describe("Expected headings with level and normalized text"),
            links: z
              .array(
                z.object({
                  text: z.string().optional().describe("Expected link label (may be unavailable from JCR)"),
                  url: z.string().describe("Expected link URL"),
                })
              )
              .optional()
              .describe("Expected links — compared by URL; text carried through for reporting"),
            texts: z
              .array(z.string())
              .optional()
              .describe("Expected body text strings (text, description, richText …)"),
            contactData: z
              .array(
                z.object({
                  label: z.string().optional().describe("Human-readable label (e.g. 'Phone', 'Email')"),
                  value: z.string().describe("Expected contact value (phone, email, address)"),
                })
              )
              .optional()
              .describe("Expected contact data — compared by value; label carried through for reporting"),
          })
          .describe("Content to verify against the live page"),
      },
    },
    async ({ pagePath, expectedContent }) => {
      try {
        const pageData = await client.get(`${pagePath}.infinity.json`);
        const jcrContent = pageData["jcr:content"] as Record<string, unknown> | undefined;
        if (!jcrContent) {
          return err(`diffPageContent: no jcr:content found at ${pagePath}`);
        }

        // --- Extraction helpers -------------------------------------------

        const HEADING_KEYS = new Set([
          "jcr:title", "title", "heading", "headline", "subtitle", "label",
        ]);
        const TEXT_KEYS = new Set([
          "text", "description", "jcr:description", "richText", "body",
          "content", "summary", "paragraph",
        ]);
        const LINK_KEYS = new Set([
          "linkURL", "link", "href", "fileReference", "ctaLink", "url", "actionLink",
        ]);
        const CONTACT_PATTERNS: RegExp[] = [
          /\+?[\d][\d\s\-().]{5,}/g,         // phone numbers
          /[\w.+\-]+@[\w\-]+\.[a-z]{2,}/gi,  // emails
        ];

        function stripHtml(raw: string): string {
          return raw
            .replace(/<[^>]*>/g, " ")
            .replace(/&nbsp;/g, " ")
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&quot;/g, '"')
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase();
        }

        function extractContactStrings(text: string): string[] {
          const found: string[] = [];
          for (const pattern of CONTACT_PATTERNS) {
            const cloned = new RegExp(pattern.source, pattern.flags);
            const matches = text.match(cloned);
            if (matches) {
              found.push(...matches.map((m) => m.trim()).filter((m) => m.length > 3));
            }
          }
          return found;
        }

        interface Extracted {
          headings: string[];
          texts: string[];
          links: string[];
          contactData: string[];
        }

        function extractFromNode(node: Record<string, unknown>, acc: Extracted): void {
          for (const [key, value] of Object.entries(node)) {
            if (typeof value === "string" && value.trim().length > 0) {
              if (HEADING_KEYS.has(key)) {
                acc.headings.push(stripHtml(value));
              } else if (LINK_KEYS.has(key)) {
                acc.links.push(value.trim());
              } else if (TEXT_KEYS.has(key)) {
                const normalized = stripHtml(value);
                acc.texts.push(normalized);
                acc.contactData.push(...extractContactStrings(normalized));
              }
            } else if (
              value !== null &&
              typeof value === "object" &&
              !Array.isArray(value)
            ) {
              extractFromNode(value as Record<string, unknown>, acc);
            }
          }
        }

        const extracted: Extracted = {
          headings: [],
          texts: [],
          links: [],
          contactData: [],
        };
        extractFromNode(jcrContent, extracted);

        // --- Fuzzy similarity (bigram) ------------------------------------

        function bigramSimilarity(a: string, b: string): number {
          if (a === b) return 1;
          if (a.length === 0 || b.length === 0) return 0;
          if (a.includes(b) || b.includes(a)) return 1;
          const bigrams = (s: string): Map<string, number> => {
            const m = new Map<string, number>();
            for (let i = 0; i < s.length - 1; i++) {
              const bg = s.slice(i, i + 2);
              m.set(bg, (m.get(bg) ?? 0) + 1);
            }
            return m;
          };
          const bA = bigrams(a);
          const bB = bigrams(b);
          let intersection = 0;
          for (const [bg, countA] of bA) {
            const countB = bB.get(bg) ?? 0;
            intersection += Math.min(countA, countB);
          }
          const totalA = [...bA.values()].reduce((s, c) => s + c, 0);
          const totalB = [...bB.values()].reduce((s, c) => s + c, 0);
          return totalA + totalB === 0 ? 0 : (2 * intersection) / (totalA + totalB);
        }

        const FUZZY_THRESHOLD = 0.72;

        type ExpectedHeading = { level: number; text: string };
        type ExpectedLink = { text?: string; url: string };
        type ExpectedContact = { label?: string; value: string };

        interface Divergence {
          type: "heading" | "text" | "link" | "contactData";
          expected: ExpectedHeading | ExpectedLink | ExpectedContact | string;
          bestMatch: string | null;
          score: number;
        }

        interface MissingItem {
          type: "heading" | "text" | "link" | "contactData";
          value: ExpectedHeading | ExpectedLink | ExpectedContact | string;
        }

        function compareTexts(
          expected: string[],
          actual: string[],
          divergences: Divergence[],
          missing: MissingItem[]
        ): { matched: number } {
          let matched = 0;
          for (const exp of expected) {
            const expNorm = stripHtml(exp);
            let bestScore = 0;
            let bestMatch: string | null = null;
            for (const act of actual) {
              const score = bigramSimilarity(expNorm, act);
              if (score > bestScore) { bestScore = score; bestMatch = act; }
            }
            if (bestScore >= FUZZY_THRESHOLD) {
              matched++;
            } else if (bestMatch !== null) {
              divergences.push({ type: "text", expected: exp, bestMatch, score: bestScore });
            } else {
              missing.push({ type: "text", value: exp });
            }
          }
          return { matched };
        }

        function compareHeadings(
          expected: ExpectedHeading[],
          actual: string[],
          divergences: Divergence[],
          missing: MissingItem[]
        ): { matched: number } {
          let matched = 0;
          for (const exp of expected) {
            const expNorm = stripHtml(exp.text);
            let bestScore = 0;
            let bestMatch: string | null = null;
            for (const act of actual) {
              const score = bigramSimilarity(expNorm, act);
              if (score > bestScore) { bestScore = score; bestMatch = act; }
            }
            if (bestScore >= FUZZY_THRESHOLD) {
              matched++;
            } else if (bestMatch !== null) {
              divergences.push({ type: "heading", expected: exp, bestMatch, score: bestScore });
            } else {
              missing.push({ type: "heading", value: exp });
            }
          }
          return { matched };
        }

        function compareLinks(
          expected: ExpectedLink[],
          actual: string[],
          divergences: Divergence[],
          missing: MissingItem[]
        ): { matched: number } {
          let matched = 0;
          for (const exp of expected) {
            const expUrl = exp.url.trim().toLowerCase();
            let bestScore = 0;
            let bestMatch: string | null = null;
            for (const act of actual) {
              const score = bigramSimilarity(expUrl, act.trim().toLowerCase());
              if (score > bestScore) { bestScore = score; bestMatch = act; }
            }
            if (bestScore >= FUZZY_THRESHOLD) {
              matched++;
            } else if (bestMatch !== null) {
              divergences.push({ type: "link", expected: exp, bestMatch, score: bestScore });
            } else {
              missing.push({ type: "link", value: exp });
            }
          }
          return { matched };
        }

        function compareContactData(
          expected: ExpectedContact[],
          actual: string[],
          divergences: Divergence[],
          missing: MissingItem[]
        ): { matched: number } {
          let matched = 0;
          for (const exp of expected) {
            const expNorm = stripHtml(exp.value);
            let bestScore = 0;
            let bestMatch: string | null = null;
            for (const act of actual) {
              const score = bigramSimilarity(expNorm, act);
              if (score > bestScore) { bestScore = score; bestMatch = act; }
            }
            if (bestScore >= FUZZY_THRESHOLD) {
              matched++;
            } else if (bestMatch !== null) {
              divergences.push({ type: "contactData", expected: exp, bestMatch, score: bestScore });
            } else {
              missing.push({ type: "contactData", value: exp });
            }
          }
          return { matched };
        }

        // --- Run comparison -----------------------------------------------

        const divergences: Divergence[] = [];
        const missing: MissingItem[] = [];
        let totalChecks = 0;
        let matchCount = 0;

        if (expectedContent.headings?.length) {
          totalChecks += expectedContent.headings.length;
          const { matched } = compareHeadings(
            expectedContent.headings,
            extracted.headings,
            divergences,
            missing
          );
          matchCount += matched;
        }

        if (expectedContent.texts?.length) {
          totalChecks += expectedContent.texts.length;
          const { matched } = compareTexts(
            expectedContent.texts,
            extracted.texts,
            divergences,
            missing
          );
          matchCount += matched;
        }

        if (expectedContent.links?.length) {
          totalChecks += expectedContent.links.length;
          const { matched } = compareLinks(
            expectedContent.links,
            extracted.links,
            divergences,
            missing
          );
          matchCount += matched;
        }

        if (expectedContent.contactData?.length) {
          totalChecks += expectedContent.contactData.length;
          const { matched } = compareContactData(
            expectedContent.contactData,
            extracted.contactData,
            divergences,
            missing
          );
          matchCount += matched;
        }

        const matchPercentage =
          totalChecks === 0 ? 100 : Math.round((matchCount / totalChecks) * 100);

        return ok({
          pagePath,
          totalChecks,
          matchCount,
          divergenceCount: divergences.length + missing.length,
          divergences,
          missing,
          matchPercentage,
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return err(`diffPageContent failed: ${msg}`);
      }
    }
  );
}
