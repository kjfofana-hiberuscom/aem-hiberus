import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import type { AemClient } from "../client.js";
import type { AemConfig } from "../config.js";

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}
function err(msg: string) {
  return { content: [{ type: "text" as const, text: msg }], isError: true };
}

const MIME_MAP: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
  ".zip": "application/zip",
  ".json": "application/json",
};

function detectMime(filePath: string): string {
  return MIME_MAP[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

/** Convert /content/dam/foo/bar  →  /foo/bar
 *  If already without /content/dam prefix, prepend / if needed. */
function toApiPath(damFolderPath: string): string {
  const normalized = damFolderPath.replace(/\/+$/, "");
  if (normalized.startsWith("/content/dam")) {
    return normalized.slice("/content/dam".length) || "/";
  }
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

export function registerAssetTools(
  server: McpServer,
  client: AemClient,
  config: AemConfig
): void {
  // -------------------------------------------------------------------------
  // listAssets
  // -------------------------------------------------------------------------
  server.registerTool(
    "listAssets",
    {
      description:
        "List DAM assets in a folder using AEM Query Builder. Supports pagination and optional MIME type filter.",
      inputSchema: {
        folderPath: z
          .string()
          .default("/content/dam")
          .describe("DAM folder path to list assets from"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .default(50)
          .describe("Max number of assets to return"),
        offset: z.number().int().min(0).default(0).describe("Pagination offset"),
        mimeTypeFilter: z
          .string()
          .optional()
          .describe("Filter by MIME type, e.g. image/png or application/pdf"),
      },
    },
    async ({ folderPath, limit, offset, mimeTypeFilter }) => {
      try {
        const params: Record<string, any> = {
          path: folderPath,
          type: "dam:Asset",
          "p.limit": limit,
          "p.offset": offset,
          "p.hits": "selective",
          "p.properties": "jcr:path jcr:content/metadata/dam:mimeType jcr:content/metadata/dc:title",
          orderby: "jcr:path",
        };
        if (mimeTypeFilter) {
          params["mimetype.property"] = "jcr:content/metadata/dam:mimeType";
          params["mimetype.value"] = mimeTypeFilter;
        }
        const data = await client.get("/bin/querybuilder.json", params);
        const hits = (data.hits ?? []) as Record<string, unknown>[];
        const assets = hits.map((h) => ({
          path: h["jcr:path"],
          name: String(h["jcr:path"] ?? "").split("/").pop(),
          mimeType: h["jcr:content/metadata/dam:mimeType"] ?? null,
          title: h["jcr:content/metadata/dc:title"] ?? null,
        }));
        return ok({ total: data.total ?? assets.length, limit, offset, assets });
      } catch (e: unknown) {
        return err(`listAssets failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  );

  // -------------------------------------------------------------------------
  // getAssetFolderTree
  // -------------------------------------------------------------------------
  server.registerTool(
    "getAssetFolderTree",
    {
      description:
        "Get the DAM folder tree structure as an indented text tree. Useful for exploring the full DAM hierarchy.",
      inputSchema: {
        folderPath: z
          .string()
          .default("/content/dam")
          .describe("Root DAM folder to start the tree from"),
      },
    },
    async ({ folderPath }) => {
      try {
        const data = await client.get("/bin/querybuilder.json", {
          path: folderPath,
          type: "sling:Folder",
          "p.limit": -1,
          "p.hits": "selective",
          "p.properties": "jcr:path",
          orderby: "jcr:path",
        });
        const hits = (data.hits ?? []) as Record<string, unknown>[];
        const folders: string[] = hits.map((h) => String(h["jcr:path"] ?? ""));

        // Build indented tree from sorted paths
        const rootDepth = folderPath.split("/").filter(Boolean).length;
        const lines: string[] = [`📁 ${folderPath}/`];
        for (const p of folders) {
          const depth = p.split("/").filter(Boolean).length - rootDepth;
          const indent = "  ".repeat(depth);
          const name = p.split("/").pop();
          lines.push(`${indent}└─ 📁 ${name}/`);
        }

        return ok({
          total: folders.length,
          tree: lines.join("\n"),
          folders,
        });
      } catch (e: unknown) {
        return err(`getAssetFolderTree failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  );

  // -------------------------------------------------------------------------
  // uploadAsset
  // -------------------------------------------------------------------------
  server.registerTool(
    "uploadAsset",
    {
      description:
        "Upload a local file to AEM DAM. Reads the file from the local filesystem (absolute path) and uploads it via the Assets HTTP API.",
      inputSchema: {
        localFilePath: z
          .string()
          .describe("Absolute path to the local file to upload"),
        damFolderPath: z
          .string()
          .describe(
            "Target DAM folder path, e.g. /content/dam/myapp/images"
          ),
        fileName: z
          .string()
          .optional()
          .describe("File name in DAM (defaults to the local file's basename)"),
        mimeType: z
          .string()
          .optional()
          .describe("MIME type (auto-detected from extension if omitted)"),
      },
    },
    async ({ localFilePath, damFolderPath, fileName, mimeType }) => {
      if (config.readOnly) {
        return err("AEM is configured as read-only. uploadAsset is disabled.");
      }
      try {
        statSync(localFilePath); // throws if not found
      } catch {
        return err(`Local file not found: ${localFilePath}`);
      }
      try {
        const resolvedName = fileName ?? basename(localFilePath);
        const resolvedMime = mimeType ?? detectMime(localFilePath);
        const apiPath = toApiPath(damFolderPath);
        const uploadPath = `/api/assets${apiPath}/${resolvedName}`;

        const buffer = readFileSync(localFilePath);
        const result = await client.postBinary(uploadPath, buffer, resolvedMime);

        const status =
          (result?.properties?.["status.code"] ?? result?.properties?.isCreate)
            ? result.properties.isCreate
              ? "created"
              : "updated"
            : "uploaded";

        return ok({
          damPath: `/content/dam${apiPath}/${resolvedName}`,
          fileName: resolvedName,
          mimeType: resolvedMime,
          status,
          apiResponse: result,
        });
      } catch (e: unknown) {
        return err(`uploadAsset failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  );

  // -------------------------------------------------------------------------
  // getAssetMetadata
  // -------------------------------------------------------------------------
  server.registerTool(
    "getAssetMetadata",
    {
      description:
        "Get JCR metadata for a specific DAM asset, including dc:title, dc:description, dam:mimeType, dam:size, and custom properties.",
      inputSchema: {
        assetPath: z
          .string()
          .describe("Full DAM asset path, e.g. /content/dam/myapp/images/hero.png"),
      },
    },
    async ({ assetPath }) => {
      try {
        const data = await client.get(`${assetPath}.json`);
        const jcrContent = data["jcr:content"];
        const metadata =
          jcrContent && typeof jcrContent === "object" && !Array.isArray(jcrContent)
            ? ((jcrContent as Record<string, unknown>)["metadata"] ?? {})
            : {};
        return ok({
          assetPath,
          name: assetPath.split("/").pop(),
          metadata,
        });
      } catch (e: unknown) {
        return err(`getAssetMetadata failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  );

  // -------------------------------------------------------------------------
  // deleteAsset
  // -------------------------------------------------------------------------
  server.registerTool(
    "deleteAsset",
    {
      description: "Delete an asset from AEM DAM using the Sling :operation=delete.",
      inputSchema: {
        assetPath: z
          .string()
          .describe("Full DAM asset path to delete, e.g. /content/dam/myapp/images/hero.png"),
      },
    },
    async ({ assetPath }) => {
      if (config.readOnly) {
        return err("AEM is configured as read-only. deleteAsset is disabled.");
      }
      try {
        await client.slingDelete(assetPath);
        return ok({
          assetPath,
          deleted: true,
          timestamp: new Date().toISOString(),
        });
      } catch (e: unknown) {
        return err(`deleteAsset failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  );
}
