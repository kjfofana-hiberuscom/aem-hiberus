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

// ---------------------------------------------------------------------------
// SubNode recursive types & schema
// ---------------------------------------------------------------------------

interface SubNodeDef extends Record<string, unknown> {
  subNodes?: SubNodeTree;
}
interface SubNodeTree {
  [key: string]: SubNodeDef;
}

// Recursive Zod schema — each sub-node is an object with optional nested subNodes
const subNodeSchema: z.ZodType<SubNodeTree> = z.lazy(() =>
  z.record(
    z.object({ subNodes: subNodeSchema.optional() }).catchall(z.unknown())
  )
);

/**
 * Flatten a recursive SubNodeTree into a nested JSON object for Sling import.
 * { hero: { props, subNodes: { title: { ... } } } }
 * → { hero: { jcr:primaryType, ...props, title: { jcr:primaryType, ... } } }
 */
function flattenSubNodes(tree: SubNodeTree): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [name, rawNode] of Object.entries(tree)) {
    const { subNodes, ...nodeProps } = rawNode as SubNodeDef;
    result[name] = {
      "jcr:primaryType": "nt:unstructured",
      ...nodeProps,
      ...(subNodes ? flattenSubNodes(subNodes) : {}),
    };
  }
  return result;
}

/**
 * Append a recursive SubNodeTree as path-based Sling POST parameters.
 * Allows creating deeply nested nodes in a single URLSearchParams POST.
 * e.g. ./hero/title/jcr:title=PSD2 creates hero/title node with jcr:title prop.
 * Returns list of relative node paths created.
 */
function appendSubNodesToFormData(
  tree: SubNodeTree,
  fd: URLSearchParams,
  pathPrefix: string = ""
): string[] {
  const created: string[] = [];
  for (const [name, rawNode] of Object.entries(tree)) {
    const { subNodes, ...nodeProps } = rawNode as SubNodeDef;
    const relPath = pathPrefix ? `${pathPrefix}/${name}` : name;
    created.push(relPath);

    fd.append(`./${relPath}/jcr:primaryType`, "nt:unstructured");

    for (const [k, v] of Object.entries(nodeProps as Record<string, unknown>)) {
      if (v === null || v === undefined) continue;
      if (Array.isArray(v)) {
        (v as unknown[]).forEach((item) => fd.append(`./${relPath}/${k}`, String(item)));
      } else {
        fd.append(`./${relPath}/${k}`, String(v));
      }
    }

    if (subNodes && Object.keys(subNodes).length > 0) {
      appendSubNodesToFormData(subNodes, fd, relPath);
    }
  }
  return created;
}

// ---------------------------------------------------------------------------
// Shared helpers: container resolution & creation
// ---------------------------------------------------------------------------

async function resolveContainerPath(
  client: AemClient,
  pagePath: string,
  containerPath?: string
): Promise<string> {
  if (containerPath) {
    if (containerPath.startsWith("/")) return containerPath;
    if (containerPath.includes("jcr:content")) return `${pagePath}/${containerPath}`;
    return `${pagePath}/jcr:content/${containerPath}`;
  }
  try {
    const jcrContent = await client.get(`${pagePath}/jcr:content.5.json`);
    if (jcrContent?.root?.container) return `${pagePath}/jcr:content/root/container`;
    if (jcrContent?.root) return `${pagePath}/jcr:content/root`;
    return `${pagePath}/jcr:content/root/container`;
  } catch {
    return `${pagePath}/jcr:content/root/container`;
  }
}

async function ensureContainerExists(
  client: AemClient,
  pagePath: string,
  targetContainer: string
): Promise<void> {
  try {
    await client.get(`${targetContainer}.json`);
  } catch {
    const rootPath = `${pagePath}/jcr:content/root`;
    const cPath = `${rootPath}/container`;
    const rootFd = new URLSearchParams();
    rootFd.append("jcr:primaryType", "nt:unstructured");
    await client.post(rootPath, rootFd).catch(() => {});
    const cFd = new URLSearchParams();
    cFd.append("jcr:primaryType", "nt:unstructured");
    await client.post(cPath, cFd).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// JCR system properties to filter out
// ---------------------------------------------------------------------------

/** Recursively collect components with sling:resourceType from a JCR tree */
function extractComponents(node: any, nodePath: string, components: any[]): void {
  if (!node || typeof node !== "object") return;
  if (node["sling:resourceType"]) {
    components.push({
      path: nodePath,
      resourceType: node["sling:resourceType"],
      properties: filterProps(node),
    });
  }
  for (const [key, value] of Object.entries(node)) {
    if (typeof value === "object" && value !== null && !key.startsWith("rep:") && !key.startsWith("oak:")) {
      extractComponents(value, nodePath ? `${nodePath}/${key}` : key, components);
    }
  }
}

/** Remove JCR system and noisy properties from a component node */
function filterProps(node: any): Record<string, unknown> {
  const skip = new Set(["jcr:created", "jcr:createdBy", "jcr:lastModified", "jcr:lastModifiedBy",
    "jcr:uuid", "jcr:mixinTypes", "jcr:baseVersion", "jcr:predecessors", "jcr:versionHistory",
    "cq:lastModified", "cq:lastModifiedBy", "cq:lastReplicationAction", "cq:lastReplicatedBy",
    "cq:lastReplicated"]);
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (!skip.has(k) && !k.startsWith("rep:") && !k.startsWith("oak:")) {
      result[k] = v;
    }
  }
  return result;
}

export function registerComponentTools(
  server: McpServer,
  client: AemClient,
  config: AemConfig
): void {
  // -------------------------------------------------------------------------
  // scanPageComponents
  // -------------------------------------------------------------------------
  server.registerTool(
    "scanPageComponents",
    {
      description: "Discover all components and their resource types on an AEM page",
      inputSchema: {
        pagePath: z.string().describe("Full JCR path to the page"),
      },
    },
    async ({ pagePath }) => {
      try {
        const data = await client.get(`${pagePath}.infinity.json`);
        const components: any[] = [];
        const jcrContent = data["jcr:content"];
        if (jcrContent) {
          extractComponents(jcrContent, "jcr:content", components);
        } else {
          extractComponents(data, pagePath, components);
        }
        return ok({ pagePath, components, totalComponents: components.length });
      } catch (e: any) {
        return err(`scanPageComponents failed: ${e.message}`);
      }
    }
  );

  // -------------------------------------------------------------------------
  // addComponent
  // -------------------------------------------------------------------------
  server.registerTool(
    "addComponent",
    {
      description: "Add a new component to an AEM page container",
      inputSchema: {
        pagePath: z.string().describe("Full JCR path to the page"),
        resourceType: z.string().describe("Sling resource type of the component to add"),
        containerPath: z.string().optional().describe("Container path relative to page (e.g. 'jcr:content/root/container'). Auto-detected if omitted."),
        name: z.string().optional().describe("Component node name (auto-generated if omitted)"),
        properties: z.record(z.unknown()).optional().describe("Component properties to set"),
        typeHints: z.record(z.string()).optional().describe(
          "Explicit Sling type hints per property. Key = property name, value = JCR type (e.g. { autoplay: 'Boolean', count: 'Long', date: 'Date' })"
        ),
        subNodes: subNodeSchema.optional().describe(
          "Recursive child JCR sub-nodes. Key = node name, value = node properties + optional nested 'subNodes'. e.g. { hero: { 'sling:resourceType': '...', subNodes: { title: { 'jcr:title': 'Hello' } } } }"
        ),
      },
    },
    async ({ pagePath, resourceType, containerPath, name, properties = {}, typeHints, subNodes }) => {
      if (config.readOnly) return readOnlyErr();
      try {
        const targetContainer = await resolveContainerPath(client, pagePath, containerPath);
        await ensureContainerExists(client, pagePath, targetContainer);

        const componentName = name || `component_${Date.now()}`;
        const componentNodePath = `${targetContainer}/${componentName}`;

        // Build form data: component props + typeHints + recursive subNodes as path-based params
        const fd = new URLSearchParams();
        fd.append("jcr:primaryType", "nt:unstructured");
        fd.append("sling:resourceType", resourceType);

        for (const [k, v] of Object.entries(properties)) {
          if (v === null || v === undefined) continue;
          if (Array.isArray(v)) {
            (v as unknown[]).forEach((item) => fd.append(k, String(item)));
          } else {
            fd.append(k, String(v));
          }
        }

        // Explicit type hints
        fd.append("jcr:lastModified", new Date().toISOString());
        fd.append("jcr:lastModified@TypeHint", "Date");
        fd.append("jcr:lastModifiedBy", "admin");
        if (typeHints) {
          for (const [prop, hint] of Object.entries(typeHints)) {
            fd.append(`${prop}@TypeHint`, hint);
          }
        }

        // Recursive subNodes as path-based Sling POST parameters (single request)
        const createdSubNodes: string[] = [];
        if (subNodes && Object.keys(subNodes).length > 0) {
          const relativePaths = appendSubNodesToFormData(subNodes, fd);
          createdSubNodes.push(...relativePaths.map((p) => `${componentNodePath}/${p}`));
        }

        await client.post(componentNodePath, fd);

        const verification = await client.get(`${componentNodePath}.json`);
        return ok({
          success: true,
          pagePath,
          componentPath: componentNodePath,
          resourceType,
          containerPath: targetContainer,
          componentName,
          properties,
          subNodes: createdSubNodes.length > 0 ? createdSubNodes : undefined,
          verification,
          timestamp: new Date().toISOString(),
        });
      } catch (e: any) {
        return err(`addComponent failed: ${e.message}`);
      }
    }
  );

  // -------------------------------------------------------------------------
  // updateComponent
  // -------------------------------------------------------------------------
  server.registerTool(
    "updateComponent",
    {
      description: "Update properties of an existing AEM component",
      inputSchema: {
        componentPath: z.string().describe("Full JCR path to the component node"),
        properties: z.record(z.unknown()).describe("Properties to update (set null to delete a property)"),
      },
    },
    async ({ componentPath, properties }) => {
      if (config.readOnly) return readOnlyErr();
      try {
        // Check component exists
        const existing = await client.get(`${componentPath}.json`);
        if (!existing || Object.keys(existing).length === 0) {
          return err(`Component not found at: ${componentPath}`);
        }

        const fd = new URLSearchParams();
        const resourceType = existing["sling:resourceType"];
        if (resourceType) fd.append("sling:resourceType", resourceType);

        for (const [k, v] of Object.entries(properties)) {
          if (v === null || v === undefined) {
            fd.append(`${k}@Delete`, "");
          } else if (Array.isArray(v)) {
            (v as unknown[]).forEach((item) => fd.append(k, String(item)));
          } else if (typeof v === "object") {
            fd.append(k, JSON.stringify(v));
          } else {
            fd.append(k, String(v));
          }
        }

        await client.post(componentPath, fd);

        const updated = await client.get(`${componentPath}.json`);
        return ok({
          message: "Component updated successfully",
          path: componentPath,
          properties,
          updatedProperties: updated,
          timestamp: new Date().toISOString(),
        });
      } catch (e: any) {
        return err(`updateComponent failed: ${e.message}`);
      }
    }
  );

  // -------------------------------------------------------------------------
  // deleteComponent
  // -------------------------------------------------------------------------
  server.registerTool(
    "deleteComponent",
    {
      description: "Delete an AEM component node",
      inputSchema: {
        componentPath: z.string().describe("Full JCR path to the component node to delete"),
      },
    },
    async ({ componentPath }) => {
      if (config.readOnly) return readOnlyErr();
      try {
        await client.slingDelete(componentPath);
        return ok({ success: true, deletedPath: componentPath, timestamp: new Date().toISOString() });
      } catch (e1: any) {
        // Fallback: HTTP DELETE
        try {
          await client.delete(componentPath);
          return ok({ success: true, deletedPath: componentPath, fallback: "HTTP DELETE", timestamp: new Date().toISOString() });
        } catch {
          return err(`deleteComponent failed: ${e1.message}`);
        }
      }
    }
  );

  // -------------------------------------------------------------------------
  // createComponent
  // -------------------------------------------------------------------------
  server.registerTool(
    "createComponent",
    {
      description: "Create a component node at a specific JCR path using Sling import",
      inputSchema: {
        pagePath: z.string().describe("Page path (used for path validation)"),
        componentPath: z.string().optional().describe("Full target JCR path for the new node. If omitted, derived from pagePath+name."),
        resourceType: z.string().describe("Sling resource type (no whitelist restriction)"),
        name: z.string().optional().describe("Component node name"),
        properties: z.record(z.unknown()).optional().describe("Flat properties to set on the component node"),
        subNodes: subNodeSchema.optional().describe(
          "Recursive child JCR sub-nodes. Key = node name, value = node properties + optional nested 'subNodes'."
        ),
      },
    },
    async ({ pagePath, componentPath, resourceType, name, properties = {}, subNodes }) => {
      if (config.readOnly) return readOnlyErr();
      try {
        const componentName = name || `${resourceType.split("/").pop()}_${Date.now()}`;
        const targetPath = componentPath || `${pagePath}/jcr:content/${componentName}`;

        // Build JSON content — recursive subNodes are embedded as a nested tree for Sling import
        const content: Record<string, unknown> = {
          "jcr:primaryType": "nt:unstructured",
          "sling:resourceType": resourceType,
          ...properties,
          ...(subNodes ? flattenSubNodes(subNodes) : {}),
        };

        await client.slingImport(targetPath, content);

        const allSubNodePaths = subNodes
          ? collectSubNodePaths(subNodes, targetPath)
          : undefined;

        return ok({
          success: true,
          componentPath: targetPath,
          resourceType,
          properties,
          subNodes: allSubNodePaths,
          timestamp: new Date().toISOString(),
        });
      } catch (e: any) {
        return err(`createComponent failed: ${e.message}`);
      }
    }
  );

  // -------------------------------------------------------------------------
  // bulkUpdateComponents
  // -------------------------------------------------------------------------
  server.registerTool(
    "bulkUpdateComponents",
    {
      description: "Update multiple AEM components in a single call",
      inputSchema: {
        updates: z
          .array(
            z.object({
              componentPath: z.string().describe("Full JCR path to the component"),
              properties: z.record(z.unknown()).describe("Properties to update"),
            })
          )
          .min(1)
          .describe("Array of component update requests"),
        continueOnError: z
          .boolean()
          .default(false)
          .describe("If true, continue with remaining updates even if one fails"),
      },
    },
    async ({ updates, continueOnError }) => {
      if (config.readOnly) return readOnlyErr();
      const results: unknown[] = [];
      let successCount = 0;

      for (const update of updates) {
        try {
          // Validate component exists
          const existing = await client.get(`${update.componentPath}.json`);
          if (!existing || Object.keys(existing).length === 0) {
            throw new Error(`Component not found: ${update.componentPath}`);
          }

          const fd = new URLSearchParams();
          const resourceType = existing["sling:resourceType"];
          if (resourceType) fd.append("sling:resourceType", resourceType);

          for (const [k, v] of Object.entries(update.properties)) {
            if (v === null || v === undefined) {
              fd.append(`${k}@Delete`, "");
            } else if (Array.isArray(v)) {
              (v as unknown[]).forEach((item) => fd.append(k, String(item)));
            } else if (typeof v === "object") {
              fd.append(k, JSON.stringify(v));
            } else {
              fd.append(k, String(v));
            }
          }

          await client.post(update.componentPath, fd);
          results.push({ componentPath: update.componentPath, success: true });
          successCount++;
        } catch (e: any) {
          results.push({ componentPath: update.componentPath, success: false, error: e.message });
          if (!continueOnError) break;
        }
      }

      return ok({
        success: successCount === updates.length,
        message: `${successCount}/${updates.length} components updated`,
        results,
        totalUpdates: updates.length,
        successfulUpdates: successCount,
        failedUpdates: updates.length - successCount,
      });
    }
  );

  // -------------------------------------------------------------------------
  // bulkAddComponents
  // -------------------------------------------------------------------------
  server.registerTool(
    "bulkAddComponents",
    {
      description: "Add multiple components to an AEM page container in a single call",
      inputSchema: {
        pagePath: z.string().describe("Full JCR path to the page"),
        containerPath: z.string().optional().describe("Container path relative to page. Auto-detected if omitted."),
        components: z
          .array(
            z.object({
              name: z.string().optional().describe("Component node name (auto-generated if omitted)"),
              resourceType: z.string().describe("Sling resource type"),
              properties: z.record(z.unknown()).optional().describe("Component properties"),
              typeHints: z.record(z.string()).optional().describe("Explicit Sling type hints per property"),
              subNodes: subNodeSchema.optional().describe("Recursive child JCR sub-nodes"),
            })
          )
          .min(1)
          .describe("Array of components to create"),
        continueOnError: z
          .boolean()
          .default(false)
          .describe("If true, continue creating remaining components even if one fails"),
      },
    },
    async ({ pagePath, containerPath, components, continueOnError }) => {
      if (config.readOnly) return readOnlyErr();
      try {
        const targetContainer = await resolveContainerPath(client, pagePath, containerPath);
        await ensureContainerExists(client, pagePath, targetContainer);

        const results: unknown[] = [];
        let successCount = 0;

        for (const comp of components) {
          const componentName = comp.name || `component_${Date.now()}_${successCount}`;
          const componentNodePath = `${targetContainer}/${componentName}`;
          try {
            const fd = new URLSearchParams();
            fd.append("jcr:primaryType", "nt:unstructured");
            fd.append("sling:resourceType", comp.resourceType);

            for (const [k, v] of Object.entries(comp.properties ?? {})) {
              if (v === null || v === undefined) continue;
              if (Array.isArray(v)) {
                (v as unknown[]).forEach((item) => fd.append(k, String(item)));
              } else {
                fd.append(k, String(v));
              }
            }

            fd.append("jcr:lastModified", new Date().toISOString());
            fd.append("jcr:lastModified@TypeHint", "Date");
            fd.append("jcr:lastModifiedBy", "admin");
            if (comp.typeHints) {
              for (const [prop, hint] of Object.entries(comp.typeHints)) {
                fd.append(`${prop}@TypeHint`, hint);
              }
            }

            const createdSubNodes: string[] = [];
            if (comp.subNodes && Object.keys(comp.subNodes).length > 0) {
              const relativePaths = appendSubNodesToFormData(comp.subNodes, fd);
              createdSubNodes.push(...relativePaths.map((p) => `${componentNodePath}/${p}`));
            }

            await client.post(componentNodePath, fd);
            successCount++;
            results.push({
              componentPath: componentNodePath,
              resourceType: comp.resourceType,
              subNodes: createdSubNodes.length > 0 ? createdSubNodes : undefined,
              success: true,
            });
          } catch (e: any) {
            results.push({ componentPath: componentNodePath, success: false, error: e.message });
            if (!continueOnError) break;
          }
        }

        return ok({
          success: successCount === components.length,
          message: `${successCount}/${components.length} components created`,
          pagePath,
          containerPath: targetContainer,
          results,
          totalComponents: components.length,
          successfulCreations: successCount,
          failedCreations: components.length - successCount,
          timestamp: new Date().toISOString(),
        });
      } catch (e: any) {
        return err(`bulkAddComponents failed: ${e.message}`);
      }
    }
  );

  // -------------------------------------------------------------------------
  // createPageStructure
  // -------------------------------------------------------------------------
  server.registerTool(
    "createPageStructure",
    {
      description:
        "Write an entire AEM page component structure in a single JCR import operation. Accepts a full recursive component tree and sends it as one POST, reducing multiple addComponent calls to one.",
      inputSchema: {
        pagePath: z.string().describe("Full JCR path to the page"),
        containerPath: z.string().optional().describe("Container path relative to page. Auto-detected if omitted."),
        structure: z.record(z.unknown()).describe(
          "Full component tree. Each top-level key = component node name, value = its properties plus optional nested 'subNodes' for child nodes. e.g. { hero_carousel: { 'sling:resourceType': '...', autoplay: true, subNodes: { hero: { subNodes: { title: { 'jcr:title': 'Hello' } } } } } }"
        ),
        mergeMode: z
          .enum(["replace", "merge"])
          .default("merge")
          .describe("'replace' overwrites existing nodes; 'merge' adds/updates without deleting existing siblings"),
      },
    },
    async ({ pagePath, containerPath, structure, mergeMode }) => {
      if (config.readOnly) return readOnlyErr();
      try {
        const targetContainer = await resolveContainerPath(client, pagePath, containerPath);
        await ensureContainerExists(client, pagePath, targetContainer);

        // Flatten the full recursive structure into a nested JSON tree for Sling import
        const flatTree = flattenSubNodes(structure as SubNodeTree);
        const componentNames = Object.keys(flatTree);

        // Use slingImport with :replace flag based on mergeMode
        const fd = new URLSearchParams();
        fd.append(":operation", "import");
        fd.append(":contentType", "json");
        fd.append(":replace", mergeMode === "replace" ? "true" : "false");
        fd.append(":replaceProperties", mergeMode === "replace" ? "true" : "false");
        fd.append(":content", JSON.stringify(flatTree));

        await client.post(targetContainer, fd);

        const verification = await client.get(`${targetContainer}.2.json`);
        return ok({
          success: true,
          pagePath,
          containerPath: targetContainer,
          mergeMode,
          componentsCreated: componentNames,
          totalComponents: componentNames.length,
          verification,
          timestamp: new Date().toISOString(),
        });
      } catch (e: any) {
        return err(`createPageStructure failed: ${e.message}`);
      }
    }
  );
}

// ---------------------------------------------------------------------------
// Internal helper: collect all sub-node absolute paths from a SubNodeTree
// ---------------------------------------------------------------------------
function collectSubNodePaths(tree: SubNodeTree, parentPath: string): string[] {
  const paths: string[] = [];
  for (const [name, rawNode] of Object.entries(tree)) {
    const nodePath = `${parentPath}/${name}`;
    paths.push(nodePath);
    const { subNodes } = rawNode as SubNodeDef;
    if (subNodes) {
      paths.push(...collectSubNodePaths(subNodes, nodePath));
    }
  }
  return paths;
}
