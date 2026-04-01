import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AemClient } from "../client.js";
import type { AemConfig } from "../config.js";
import {
  adaptExperienceFragmentData,
  buildExperienceFragmentTree,
  buildPostCloneAnalysis,
  cloneJcrSubtree,
  compareExperienceFragmentData,
  detectExperienceFragmentCategory,
  ensureFolderPath,
  inspectExperienceFragmentData,
  normalizeJcrPath,
  extractExperienceFragmentVariationNames,
  getParentPath,
  sanitizeJcrSubtree,
} from "../jcr-helpers.js";
import type {
  AemExperienceFragmentAdaptationResult,
  AemExperienceFragmentCloneResult,
  AemExperienceFragmentCompareResult,
  AemExperienceFragmentLanguageEntry,
  AemExperienceFragmentStructureResult,
  AemExperienceFragmentTreeNode,
  AemExperienceFragmentTreeStats,
} from "../types.js";

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}
function err(msg: string) {
  return { content: [{ type: "text" as const, text: msg }], isError: true };
}
function readOnlyErr() {
  return err("Operation blocked: AEM_READ_ONLY=true");
}

const XF_TYPE_SCHEMA = z.enum(["site", "modals"]);

function deriveExperienceFragmentBasePath(path: string): string {
  const segments = normalizeJcrPath(path).split("/").filter(Boolean);
  if (segments[0] === "content" && segments[1] === "experience-fragments" && segments[2]) {
    return `/${segments.slice(0, 3).join("/")}`;
  }
  return "/content/experience-fragments";
}

function toPublishedStatus(rawStatus: string | undefined): string {
  return rawStatus?.toLowerCase() === "activate" ? "published" : "draft";
}

function buildLanguageEntry(
  path: string,
  title: string | undefined,
  includeMetadata: boolean,
  inspection: ReturnType<typeof inspectExperienceFragmentData>
): AemExperienceFragmentLanguageEntry {
  return {
    name: path.split("/").pop() ?? path,
    path,
    title,
    isEmpty: includeMetadata ? inspection.analysis.isEmpty : undefined,
    variations: includeMetadata ? inspection.variationNames : undefined,
    lastModified: includeMetadata ? inspection.lastModified : undefined,
    status: includeMetadata ? inspection.status : undefined,
    contentSummary: includeMetadata ? inspection.analysis.contentSummary : undefined,
  };
}

async function queryExperienceFragments(
  client: AemClient,
  basePath: string
): Promise<Array<{ path: string; title?: string; lastModified?: string; replicationAction?: string }>> {
  const result = await client.get("/bin/querybuilder.json", {
    path: basePath,
    type: "cq:Page",
    property: "jcr:content/sling:resourceType",
    "property.value": "cq/experience-fragments/components/experiencefragment",
    "p.limit": -1,
    "p.hits": "selective",
    "p.properties": "jcr:path jcr:content/jcr:title jcr:content/cq:lastModified jcr:content/jcr:lastModified jcr:content/cq:lastReplicationAction",
    orderby: "jcr:path",
  });

  return (result.hits || []).map((hit: Record<string, unknown>) => ({
    path: String(hit["jcr:path"] ?? hit["path"] ?? ""),
    title: typeof hit["jcr:content/jcr:title"] === "string" ? hit["jcr:content/jcr:title"] : undefined,
    lastModified:
      typeof hit["jcr:content/cq:lastModified"] === "string"
        ? hit["jcr:content/cq:lastModified"]
        : typeof hit["jcr:content/jcr:lastModified"] === "string"
          ? hit["jcr:content/jcr:lastModified"]
          : undefined,
    replicationAction:
      typeof hit["jcr:content/cq:lastReplicationAction"] === "string"
        ? hit["jcr:content/cq:lastReplicationAction"]
        : undefined,
  }));
}

export function registerExperienceFragmentTools(
  server: McpServer,
  client: AemClient,
  config: AemConfig
): void {
  // -------------------------------------------------------------------------
  // getExperienceFragment
  // -------------------------------------------------------------------------
  server.registerTool(
    "getExperienceFragment",
    {
      description: "Get an Experience Fragment with its variations",
      inputSchema: {
        path: z.string().describe("Full JCR path to the Experience Fragment (e.g. /content/experience-fragments/site/my-xf)"),
      },
    },
    async ({ path }) => {
      try {
        const pageData = await client.get(`${path}.infinity.json`);
        const jcrContent = pageData["jcr:content"] || {};

        const variations: unknown[] = [];
        for (const [childName, childData] of Object.entries(pageData as Record<string, unknown>)) {
          if (childName.startsWith("jcr:") || childName.startsWith("rep:") || typeof childData !== "object" || childData === null) continue;
          const childRecord = childData as Record<string, unknown>;
          const childJcr = childRecord["jcr:content"] as Record<string, unknown> | undefined;
          if (!childJcr) continue;
          const variantType = childJcr["cq:xfVariantType"];
          if (!variantType) continue;
          variations.push({
            name: childName,
            type: variantType,
            path: `${path}/${childName}`,
            title: childJcr["jcr:title"] || childName,
          });
        }

        return ok({
          path,
          title: jcrContent["jcr:title"] || "",
          template: jcrContent["cq:template"] || "",
          description: jcrContent["jcr:description"] || "",
          variations,
          tags: jcrContent["cq:tags"] || [],
          lastModified: jcrContent["cq:lastModified"] || jcrContent["jcr:lastModified"] || "",
          status: jcrContent["cq:lastReplicationAction"] || "not published",
        });
      } catch (e: any) {
        return err(`getExperienceFragment failed: ${e.message}`);
      }
    }
  );

  // -------------------------------------------------------------------------
  // createExperienceFragmentStructure
  // -------------------------------------------------------------------------
  server.registerTool(
    "createExperienceFragmentStructure",
    {
      description: "Create missing language-level Experience Fragment folders such as /<lang>/site and /<lang>/modals.",
      inputSchema: {
        xfBasePath: z.string().describe("Base XF portal path, e.g. /content/experience-fragments/caixabank-italia"),
        languageCode: z.string().describe("Language code to create, e.g. it"),
        xfTypes: z.array(XF_TYPE_SCHEMA).default(["site", "modals"]).describe("Folder groups to create under the language root"),
      },
    },
    async ({ xfBasePath, languageCode, xfTypes }) => {
      if (config.readOnly) return readOnlyErr();
      try {
        const basePath = normalizeJcrPath(xfBasePath);
        const normalizedLanguage = languageCode.toLowerCase();
        const languageRootPath = `${basePath}/${normalizedLanguage}`;
        const createdPaths = await ensureFolderPath(client, {
          path: languageRootPath,
          rootPath: basePath,
        });

        const ensuredPaths = [languageRootPath];
        for (const xfType of xfTypes) {
          const ensuredPath = `${languageRootPath}/${xfType}`;
          ensuredPaths.push(ensuredPath);
          createdPaths.push(
            ...await ensureFolderPath(client, {
              path: ensuredPath,
              rootPath: basePath,
            })
          );
        }

        const result: AemExperienceFragmentStructureResult = {
          xfBasePath: basePath,
          languageCode: normalizedLanguage,
          xfTypes,
          createdPaths: [...new Set(createdPaths)],
          ensuredPaths,
          ready: true,
        };

        return ok(result);
      } catch (e: any) {
        return err(`createExperienceFragmentStructure failed: ${e.message}`);
      }
    }
  );

  // -------------------------------------------------------------------------
  // detectXFContent
  // -------------------------------------------------------------------------
  server.registerTool(
    "detectXFContent",
    {
      description: "Inspect an Experience Fragment and summarize authored components, language, emptiness, and manual translation needs.",
      inputSchema: {
        xfPath: z.string().describe("Experience Fragment path to inspect"),
      },
    },
    async ({ xfPath }) => {
      try {
        const basePath = deriveExperienceFragmentBasePath(xfPath);
        const xfData = await client.getJson(xfPath, "infinity");
        const inspection = inspectExperienceFragmentData(xfPath, xfData, basePath);
        return ok({
          xfPath: normalizeJcrPath(xfPath),
          title: inspection.title,
          lastModified: inspection.lastModified,
          status: inspection.status,
          category: inspection.category,
          variationNames: inspection.variationNames,
          ...inspection.analysis,
        });
      } catch (e: any) {
        return err(`detectXFContent failed: ${e.message}`);
      }
    }
  );

  // -------------------------------------------------------------------------
  // adaptXFContent
  // -------------------------------------------------------------------------
  server.registerTool(
    "adaptXFContent",
    {
      description: "Adapt whitelisted URL/path properties inside an Experience Fragment using explicit rewrite rules.",
      inputSchema: {
        xfPath: z.string().describe("Experience Fragment path to adapt"),
        sourceLanguage: z.string().describe("Source language code, e.g. pl"),
        targetLanguage: z.string().describe("Target language code, e.g. it"),
        internalUrlPatternFrom: z.string().optional().describe("Optional explicit string to replace in internal URLs"),
        internalUrlPatternTo: z.string().optional().describe("Replacement value for internalUrlPatternFrom"),
        navigationRootFrom: z.string().optional().describe("Optional explicit source navigation root"),
        navigationRootTo: z.string().optional().describe("Optional explicit target navigation root"),
        customReplacements: z.array(z.object({ from: z.string(), to: z.string(), label: z.string().optional() })).optional().describe("Additional safe string replacements applied only on whitelisted URL/path properties"),
        translateText: z.boolean().default(false).describe("Must remain false in v1; text translation is intentionally not supported"),
      },
    },
    async ({ xfPath, sourceLanguage, targetLanguage, internalUrlPatternFrom, internalUrlPatternTo, navigationRootFrom, navigationRootTo, customReplacements, translateText }) => {
      if (config.readOnly) return readOnlyErr();
      if (translateText) {
        return err("adaptXFContent does not support translateText=true in v1");
      }
      try {
        const xfData = await client.getJson(xfPath, "infinity");
        const { adaptedContent, result } = adaptExperienceFragmentData(xfPath, xfData, {
          sourceLanguage,
          targetLanguage,
          internalUrlPatternFrom,
          internalUrlPatternTo,
          navigationRootFrom,
          navigationRootTo,
          customReplacements,
        });
        const sanitizedContent = sanitizeJcrSubtree(adaptedContent);
        await client.slingImport(xfPath, sanitizedContent as Record<string, unknown>, {
          replace: true,
          replaceProperties: true,
        });

        return ok(result as AemExperienceFragmentAdaptationResult);
      } catch (e: any) {
        return err(`adaptXFContent failed: ${e.message}`);
      }
    }
  );

  // -------------------------------------------------------------------------
  // cloneExperienceFragment
  // -------------------------------------------------------------------------
  server.registerTool(
    "cloneExperienceFragment",
    {
      description: "Clone an Experience Fragment subtree to a new path. Supports optional parent-folder creation and post-clone analysis.",
      inputSchema: {
        sourceXfPath: z.string().describe("Source Experience Fragment path to clone"),
        targetXfPath: z.string().describe("Target Experience Fragment path to create"),
        overwrite: z.boolean().default(false).describe("If true, delete the target subtree before cloning"),
        createParentFolders: z.boolean().default(false).describe("If true, create missing parent folders under the target XF base path before cloning"),
        postCloneAnalysis: z.boolean().default(false).describe("If true, return conservative metadata about untranslated text and manual review needs"),
      },
    },
    async ({ sourceXfPath, targetXfPath, overwrite, createParentFolders, postCloneAnalysis }) => {
      if (config.readOnly) return readOnlyErr();
      try {
        const targetParentPath = getParentPath(targetXfPath);
        const targetBasePath = deriveExperienceFragmentBasePath(targetXfPath);
        if (createParentFolders) {
          await ensureFolderPath(client, {
            path: targetParentPath,
            rootPath: targetBasePath,
          });
        }

        const cloneResult = await cloneJcrSubtree(client, {
          sourcePath: sourceXfPath,
          targetPath: targetXfPath,
          overwrite,
        });

        const variationNames = extractExperienceFragmentVariationNames(cloneResult.sanitizedContent);
        const xfContent = cloneResult.sanitizedContent["jcr:content"] as Record<string, unknown> | undefined;
        const result: AemExperienceFragmentCloneResult = {
          sourcePath: cloneResult.sourcePath,
          targetPath: cloneResult.targetPath,
          overwrite: cloneResult.overwrite,
          rootTitle:
            typeof xfContent?.["jcr:title"] === "string"
              ? xfContent["jcr:title"]
              : cloneResult.verification.title,
          variationNames,
          verification: cloneResult.verification,
        };

        if (postCloneAnalysis) {
          const inspection = inspectExperienceFragmentData(targetXfPath, cloneResult.sanitizedContent, targetBasePath);
          result.contentMetadata = buildPostCloneAnalysis(inspection, 0);
        }

        return ok(result);
      } catch (e: any) {
        return err(`cloneExperienceFragment failed: ${e.message}`);
      }
    }
  );

  // -------------------------------------------------------------------------
  // listExperienceFragments
  // -------------------------------------------------------------------------
  server.registerTool(
    "listExperienceFragments",
    {
      description: "List Experience Fragments under a given path",
      inputSchema: {
        path: z.string().default("/content/experience-fragments").describe("Root path to search"),
        template: z.string().optional().describe("Filter by template path"),
        limit: z.number().int().min(1).max(100).default(20).describe("Max results"),
        offset: z.number().int().min(0).default(0).describe("Pagination offset"),
      },
    },
    async ({ path, template, limit, offset }) => {
      try {
        const params: Record<string, string | number> = {
          type: "cq:Page",
          path,
          property: "jcr:content/sling:resourceType",
          "property.value": "cq/experience-fragments/components/experiencefragment",
          "p.limit": limit,
          "p.offset": offset,
          orderby: "@jcr:content/cq:lastModified",
          "orderby.sort": "desc",
        };
        if (template) {
          params["2_property"] = "jcr:content/cq:template";
          params["2_property.value"] = template;
        }
        const result = await client.get("/bin/querybuilder.json", params);
        const hits = result.hits || [];
        return ok({
          fragments: hits.map((h: Record<string, unknown>) => ({
            path: h.path,
            title: (h["jcr:content"] as Record<string, unknown> | undefined)?.["jcr:title"] || h.name,
            lastModified: (h["jcr:content"] as Record<string, unknown> | undefined)?.["cq:lastModified"] || "",
          })),
          totalCount: result.total || hits.length,
          limit,
          offset,
        });
      } catch (e: any) {
        return err(`listExperienceFragments failed: ${e.message}`);
      }
    }
  );

  // -------------------------------------------------------------------------
  // getExperienceFragmentTree
  // -------------------------------------------------------------------------
  server.registerTool(
    "getExperienceFragmentTree",
    {
      description: "Get a hierarchical tree view of Experience Fragments with optional metadata and filters.",
      inputSchema: {
        basePath: z
          .string()
          .default("/content/experience-fragments")
          .describe("Root path to build the Experience Fragment tree from"),
        filterByLanguage: z.string().optional().describe("Optional language filter, e.g. pl"),
        filterByType: XF_TYPE_SCHEMA.optional().describe("Optional category filter, e.g. site or modals"),
        filterByEmpty: z.boolean().optional().describe("Optional emptiness filter"),
        includeContentSummary: z.boolean().default(false).describe("If true, include per-XF content summaries in the tree metadata"),
      },
    },
    async ({ basePath, filterByLanguage, filterByType, filterByEmpty, includeContentSummary }) => {
      try {
        const fragments = await queryExperienceFragments(client, basePath);
        const fragmentNodes: AemExperienceFragmentTreeNode[] = [];
        const xfTreeNodes: Array<{
          path: string;
          title?: string;
          language?: string;
          lastModified?: string;
          status?: string;
          isEmpty?: boolean;
          category?: string;
          contentSummary?: ReturnType<typeof inspectExperienceFragmentData>["analysis"]["contentSummary"];
        }> = [];
        const variationNodes: Array<{ path: string; title?: string }> = [];

        for (const fragment of fragments) {
          const xfData = await client.getJson(fragment.path, "infinity");
          const inspection = inspectExperienceFragmentData(fragment.path, xfData, basePath);
          const language = inspection.language;
          const category = inspection.category ?? detectExperienceFragmentCategory(fragment.path, basePath, inspection.language);
          if (filterByLanguage && language !== filterByLanguage.toLowerCase()) {
            continue;
          }
          if (filterByType && category !== filterByType) {
            continue;
          }
          if (typeof filterByEmpty === "boolean" && inspection.analysis.isEmpty !== filterByEmpty) {
            continue;
          }

          xfTreeNodes.push({
            path: fragment.path,
            title: inspection.title ?? fragment.title,
            language,
            lastModified: inspection.lastModified ?? fragment.lastModified,
            status: inspection.status ?? toPublishedStatus(fragment.replicationAction),
            isEmpty: inspection.analysis.isEmpty,
            category,
            contentSummary: includeContentSummary ? inspection.analysis.contentSummary : undefined,
          });
          variationNodes.push(...inspection.variationNodes.map((variationNode) => ({ path: variationNode.path, title: variationNode.title })));
        }

        const treeResult = buildExperienceFragmentTree(basePath, xfTreeNodes, variationNodes);
        fragmentNodes.push(...treeResult.root.children);
        return ok({
          basePath: normalizeJcrPath(basePath),
          filters: {
            filterByLanguage: filterByLanguage ?? null,
            filterByType: filterByType ?? null,
            filterByEmpty: typeof filterByEmpty === "boolean" ? filterByEmpty : null,
            includeContentSummary,
          },
          tree: treeResult.tree,
          nodes: fragmentNodes,
          stats: treeResult.stats as AemExperienceFragmentTreeStats,
        });
      } catch (e: any) {
        return err(`getExperienceFragmentTree failed: ${e.message}`);
      }
    }
  );

  // -------------------------------------------------------------------------
  // compareXFStructure
  // -------------------------------------------------------------------------
  server.registerTool(
    "compareXFStructure",
    {
      description: "Compare two Experience Fragments after sanitizing volatile JCR properties and classify their differences.",
      inputSchema: {
        sourcePath: z.string().describe("Source Experience Fragment path"),
        targetPath: z.string().describe("Target Experience Fragment path"),
      },
    },
    async ({ sourcePath, targetPath }) => {
      try {
        const sourceData = await client.getJson(sourcePath, "infinity");
        const targetData = await client.getJson(targetPath, "infinity");
        return ok(compareExperienceFragmentData(sourcePath, sourceData, targetPath, targetData) as AemExperienceFragmentCompareResult);
      } catch (e: any) {
        return err(`compareXFStructure failed: ${e.message}`);
      }
    }
  );

  // -------------------------------------------------------------------------
  // listXFByLanguage
  // -------------------------------------------------------------------------
  server.registerTool(
    "listXFByLanguage",
    {
      description: "Group Experience Fragments by detected language and optionally include metadata about emptiness, variations, and content summary.",
      inputSchema: {
        xfBasePath: z.string().describe("Base Experience Fragment path to group"),
        metadata: z.boolean().default(true).describe("If true, include emptiness, variation names, and content summary metadata"),
      },
    },
    async ({ xfBasePath, metadata }) => {
      try {
        const fragments = await queryExperienceFragments(client, xfBasePath);
        const languages: Record<string, { count: number; xfs: AemExperienceFragmentLanguageEntry[] }> = {};

        for (const fragment of fragments) {
          const xfData = await client.getJson(fragment.path, "infinity");
          const inspection = inspectExperienceFragmentData(fragment.path, xfData, xfBasePath);
          const languageKey = inspection.language ?? "unknown";
          if (!languages[languageKey]) {
            languages[languageKey] = { count: 0, xfs: [] };
          }
          languages[languageKey].xfs.push(
            buildLanguageEntry(fragment.path, inspection.title ?? fragment.title, metadata, inspection)
          );
          languages[languageKey].count += 1;
        }

        return ok({
          xfBasePath: normalizeJcrPath(xfBasePath),
          metadata,
          languages,
        });
      } catch (e: any) {
        return err(`listXFByLanguage failed: ${e.message}`);
      }
    }
  );

  // -------------------------------------------------------------------------
  // manageExperienceFragment
  // -------------------------------------------------------------------------
  server.registerTool(
    "manageExperienceFragment",
    {
      description: "Create, update, or delete an Experience Fragment",
      inputSchema: {
        action: z.enum(["create", "update", "delete"]).describe("Operation to perform"),
        xfPath: z.string().optional().describe("Path to the XF (required for update/delete)"),
        parentPath: z.string().optional().describe("Parent path (required for create)"),
        name: z.string().optional().describe("Node name (auto-generated if omitted)"),
        title: z.string().optional().describe("XF title (required for create)"),
        template: z.string().optional().describe("Template path (required for create)"),
        description: z.string().optional().describe("XF description"),
        tags: z.array(z.string()).optional().describe("Tag paths"),
        force: z.boolean().optional().default(false).describe("Force delete ignoring references"),
      },
    },
    async ({ action, xfPath, parentPath, name, title, template, description, tags, force }) => {
      if (config.readOnly) return readOnlyErr();
      try {
        if (action === "create") {
          if (!parentPath || !title || !template) {
            return err("create requires parentPath, title, and template");
          }
          const nodeName = name || title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
          const newXfPath = `${parentPath}/${nodeName}`;

          const fd = new URLSearchParams();
          fd.append("./jcr:primaryType", "cq:Page");
          fd.append("./jcr:content/jcr:primaryType", "cq:PageContent");
          fd.append("./jcr:content/jcr:title", title);
          fd.append("./jcr:content/sling:resourceType", "cq/experience-fragments/components/experiencefragment");
          fd.append("./jcr:content/cq:template", template);
          if (description) fd.append("./jcr:content/jcr:description", description);
          if (tags?.length) tags.forEach((tag) => fd.append("./jcr:content/cq:tags", tag));
          await client.post(newXfPath, fd);

          const masterFd = new URLSearchParams();
          masterFd.append("./jcr:primaryType", "cq:Page");
          masterFd.append("./jcr:content/jcr:primaryType", "cq:PageContent");
          masterFd.append("./jcr:content/jcr:title", "Master");
          masterFd.append("./jcr:content/sling:resourceType", "cq/experience-fragments/components/xfpage");
          masterFd.append("./jcr:content/cq:xfVariantType", "web");
          await client.post(`${newXfPath}/master`, masterFd);

          return ok({ action, path: newXfPath, title });
        }

        if (action === "update") {
          if (!xfPath) return err("update requires xfPath");
          const fd = new URLSearchParams();
          if (title) fd.append("./jcr:content/jcr:title", title);
          if (description) fd.append("./jcr:content/jcr:description", description);
          if (tags?.length) tags.forEach((tag) => fd.append("./jcr:content/cq:tags", tag));
          await client.post(xfPath, fd);
          return ok({ action, path: xfPath });
        }

        if (action === "delete") {
          if (!xfPath) return err("delete requires xfPath");
          if (!force) {
            try {
              const refs = await client.get(`${xfPath}.references.json`);
              const referencing = refs?.pages?.filter((page: { path: string }) => page.path !== xfPath) || [];
              if (referencing.length > 0) {
                return err(`Cannot delete: XF is referenced by ${referencing.length} page(s). Use force=true to override.`);
              }
            } catch {
              // ignore reference lookup failures and continue to delete path
            }
          }
          const fd = new URLSearchParams();
          fd.append(":operation", "delete");
          await client.post(xfPath, fd);
          return ok({ action, path: xfPath });
        }

        return err(`Unknown action: ${action}`);
      } catch (e: any) {
        return err(`manageExperienceFragment failed: ${e.message}`);
      }
    }
  );

  // -------------------------------------------------------------------------
  // manageExperienceFragmentVariation
  // -------------------------------------------------------------------------
  server.registerTool(
    "manageExperienceFragmentVariation",
    {
      description: "Create, update, or delete an Experience Fragment variation",
      inputSchema: {
        action: z.enum(["create", "update", "delete"]).describe("Operation to perform"),
        xfPath: z.string().describe("Path to the parent Experience Fragment"),
        variationName: z.string().describe("Name of the variation (e.g. 'web', 'email')"),
        variationType: z.string().default("web").describe("XF variant type (web, email, etc.)"),
        title: z.string().optional().describe("Variation title (required for create)"),
        template: z.string().optional().describe("Template path for the variation"),
      },
    },
    async ({ action, xfPath, variationName, variationType, title, template }) => {
      if (config.readOnly) return readOnlyErr();
      const variationPath = `${xfPath}/${variationName}`;
      try {
        if (action === "create") {
          if (!title) return err("create requires title");
          const fd = new URLSearchParams();
          fd.append("./jcr:primaryType", "cq:Page");
          fd.append("./jcr:content/jcr:primaryType", "cq:PageContent");
          fd.append("./jcr:content/jcr:title", title);
          fd.append("./jcr:content/sling:resourceType", "cq/experience-fragments/components/xfpage");
          fd.append("./jcr:content/cq:xfVariantType", variationType);
          if (template) fd.append("./jcr:content/cq:template", template);
          await client.post(variationPath, fd);
          return ok({ action, xfPath, variationName, variationPath, variationType, title });
        }

        if (action === "update") {
          const fd = new URLSearchParams();
          if (title) fd.append("./jcr:content/jcr:title", title);
          if (variationType) fd.append("./jcr:content/cq:xfVariantType", variationType);
          await client.post(variationPath, fd);
          return ok({ action, xfPath, variationName, variationPath });
        }

        if (action === "delete") {
          const fd = new URLSearchParams();
          fd.append(":operation", "delete");
          await client.post(variationPath, fd);
          return ok({ action, xfPath, variationName, variationPath });
        }

        return err(`Unknown action: ${action}`);
      } catch (e: any) {
        return err(`manageExperienceFragmentVariation failed: ${e.message}`);
      }
    }
  );
}
