import type { AemClient } from "./client.js";
import type {
  AemCloneVerification,
  AemExperienceFragmentTreeNode,
  AemExperienceFragmentTreeStats,
} from "./types.js";

export interface CloneJcrSubtreeOptions {
  sourcePath: string;
  targetPath: string;
  overwrite?: boolean;
}

export interface CloneJcrSubtreeResult {
  sourcePath: string;
  targetPath: string;
  overwrite: boolean;
  sanitizedContent: Record<string, unknown>;
  verification: AemCloneVerification;
}

export interface TreeSourceNode {
  path: string;
  title?: string;
}

const VOLATILE_PROPERTY_PATTERNS: RegExp[] = [
  /^jcr:uuid$/,
  /^jcr:(created|createdBy|lastModified|lastModifiedBy|baseVersion|predecessors|versionHistory|isCheckedOut|mergeFailed|activity|configuration)$/,
  /^cq:(lastModified|lastModifiedBy|lastReplicated|lastReplicatedBy|lastReplicationAction|lastRolledout|lastRolledoutBy)$/,
  /^rep:/,
  /^oak:/,
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shouldDropProperty(key: string): boolean {
  return VOLATILE_PROPERTY_PATTERNS.some((pattern) => pattern.test(key));
}

export function normalizeJcrPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return "/";
  if (trimmed === "/") return "/";
  return trimmed.replace(/\/+$/, "");
}

export function getParentPath(path: string): string {
  const normalized = normalizeJcrPath(path);
  if (normalized === "/") return "/";
  const lastSlash = normalized.lastIndexOf("/");
  return lastSlash <= 0 ? "/" : normalized.slice(0, lastSlash);
}

export function hasOverlappingPaths(sourcePath: string, targetPath: string): boolean {
  const source = normalizeJcrPath(sourcePath);
  const target = normalizeJcrPath(targetPath);
  return source === target || source.startsWith(`${target}/`) || target.startsWith(`${source}/`);
}

export function sanitizeJcrSubtree(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => sanitizeJcrSubtree(item));
  }

  if (!isPlainObject(node)) {
    return node;
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (shouldDropProperty(key)) {
      continue;
    }
    sanitized[key] = sanitizeJcrSubtree(value);
  }

  return sanitized;
}

function countVisibleChildren(node: Record<string, unknown>): number {
  return Object.keys(node).filter((key) => !key.startsWith("jcr:") && !key.startsWith("sling:") && !key.startsWith("cq:") && !key.startsWith("rep:") && !key.startsWith("oak:")).length;
}

function buildVerification(node: Record<string, unknown>): AemCloneVerification {
  const jcrContent = isPlainObject(node["jcr:content"]) ? node["jcr:content"] : undefined;

  return {
    exists: true,
    primaryType: typeof node["jcr:primaryType"] === "string" ? node["jcr:primaryType"] : undefined,
    resourceType:
      typeof node["sling:resourceType"] === "string"
        ? node["sling:resourceType"]
        : typeof jcrContent?.["sling:resourceType"] === "string"
          ? jcrContent["sling:resourceType"]
          : undefined,
    title:
      typeof node["jcr:title"] === "string"
        ? node["jcr:title"]
        : typeof jcrContent?.["jcr:title"] === "string"
          ? jcrContent["jcr:title"]
          : undefined,
    childNodeCount: countVisibleChildren(node),
  };
}

export function extractExperienceFragmentVariationNames(node: Record<string, unknown>): string[] {
  const names: string[] = [];

  for (const [childName, childValue] of Object.entries(node)) {
    if (!isPlainObject(childValue)) continue;
    const childContent = isPlainObject(childValue["jcr:content"]) ? childValue["jcr:content"] : undefined;
    if (typeof childContent?.["cq:xfVariantType"] === "string") {
      names.push(childName);
    }
  }

  return names.sort((left, right) => left.localeCompare(right));
}

export async function cloneJcrSubtree(
  client: AemClient,
  options: CloneJcrSubtreeOptions
): Promise<CloneJcrSubtreeResult> {
  const sourcePath = normalizeJcrPath(options.sourcePath);
  const targetPath = normalizeJcrPath(options.targetPath);
  const overwrite = options.overwrite ?? false;

  if (hasOverlappingPaths(sourcePath, targetPath)) {
    throw new Error("Source and target paths cannot overlap");
  }

  if (!(await client.exists(sourcePath))) {
    throw new Error(`Source path not found: ${sourcePath}`);
  }

  const targetParentPath = getParentPath(targetPath);
  if (!(await client.exists(targetParentPath))) {
    throw new Error(`Target parent path not found: ${targetParentPath}`);
  }

  const targetExists = await client.exists(targetPath);
  if (targetExists && !overwrite) {
    throw new Error(`Target path already exists: ${targetPath}`);
  }

  if (targetExists && overwrite) {
    await client.slingDelete(targetPath);
  }

  const sourceContent = await client.getJson(sourcePath, "infinity");
  if (!isPlainObject(sourceContent)) {
    throw new Error(`Source subtree is not a valid JCR object: ${sourcePath}`);
  }

  const sanitizedContent = sanitizeJcrSubtree(sourceContent);
  if (!isPlainObject(sanitizedContent)) {
    throw new Error(`Sanitized subtree is not a valid JCR object: ${sourcePath}`);
  }

  await client.slingImport(targetPath, sanitizedContent, {
    replace: true,
    replaceProperties: true,
  });

  const verificationNode = await client.getJson(targetPath, 1);
  if (!isPlainObject(verificationNode)) {
    throw new Error(`Verification failed for target path: ${targetPath}`);
  }

  return {
    sourcePath,
    targetPath,
    overwrite,
    sanitizedContent,
    verification: buildVerification(verificationNode),
  };
}

function createTreeNode(
  name: string,
  path: string,
  nodeType: AemExperienceFragmentTreeNode["nodeType"],
  title?: string
): AemExperienceFragmentTreeNode {
  return {
    name,
    path,
    nodeType,
    title,
    children: [],
  };
}

function getNodeSortWeight(node: AemExperienceFragmentTreeNode): number {
  if (node.nodeType === "folder") return 0;
  if (node.nodeType === "experience-fragment") return 1;
  return 2;
}

function sortTree(node: AemExperienceFragmentTreeNode): void {
  node.children.sort((left, right) => {
    const weightDelta = getNodeSortWeight(left) - getNodeSortWeight(right);
    if (weightDelta !== 0) return weightDelta;
    return left.name.localeCompare(right.name);
  });

  for (const child of node.children) {
    sortTree(child);
  }
}

function renderNodeLabel(node: AemExperienceFragmentTreeNode): string {
  return node.nodeType === "variation" ? node.name : `${node.name}/`;
}

function renderTreeLines(root: AemExperienceFragmentTreeNode): string[] {
  const lines = [`${root.path}/`];

  const visit = (
    node: AemExperienceFragmentTreeNode,
    prefix: string,
    isLast: boolean
  ): void => {
    lines.push(`${prefix}${isLast ? "└── " : "├── "}${renderNodeLabel(node)}`);
    const childPrefix = `${prefix}${isLast ? "    " : "│   "}`;
    node.children.forEach((child, index) => {
      visit(child, childPrefix, index === node.children.length - 1);
    });
  };

  root.children.forEach((child, index) => {
    visit(child, "", index === root.children.length - 1);
  });

  return lines;
}

function computeTreeStats(root: AemExperienceFragmentTreeNode): AemExperienceFragmentTreeStats {
  let fragmentCount = 0;
  let variationCount = 0;
  let totalNodeCount = 0;

  const visit = (node: AemExperienceFragmentTreeNode): void => {
    totalNodeCount += 1;
    if (node.nodeType === "experience-fragment") fragmentCount += 1;
    if (node.nodeType === "variation") variationCount += 1;
    for (const child of node.children) {
      visit(child);
    }
  };

  visit(root);

  return {
    fragmentCount,
    variationCount,
    totalNodeCount,
  };
}

function upsertNode(
  root: AemExperienceFragmentTreeNode,
  index: Map<string, AemExperienceFragmentTreeNode>,
  basePath: string,
  fullPath: string,
  finalNodeType: AemExperienceFragmentTreeNode["nodeType"],
  title?: string
): void {
  const normalizedFullPath = normalizeJcrPath(fullPath);
  if (normalizedFullPath === basePath) return;
  if (!normalizedFullPath.startsWith(`${basePath}/`)) return;

  const relativePath = normalizedFullPath.slice(basePath.length + 1);
  const segments = relativePath.split("/").filter(Boolean);
  let currentPath = basePath;
  let parentNode = root;

  segments.forEach((segment, indexInPath) => {
    currentPath = `${currentPath}/${segment}`;
    let currentNode = index.get(currentPath);
    if (!currentNode) {
      currentNode = createTreeNode(
        segment,
        currentPath,
        indexInPath === segments.length - 1 ? finalNodeType : "folder"
      );
      parentNode.children.push(currentNode);
      index.set(currentPath, currentNode);
    }

    if (indexInPath === segments.length - 1) {
      currentNode.nodeType = finalNodeType;
      if (title) {
        currentNode.title = title;
      }
    }

    parentNode = currentNode;
  });
}

export function buildExperienceFragmentTree(
  basePath: string,
  fragmentNodes: TreeSourceNode[],
  variationNodes: TreeSourceNode[]
): {
  root: AemExperienceFragmentTreeNode;
  tree: string;
  stats: AemExperienceFragmentTreeStats;
} {
  const normalizedBasePath = normalizeJcrPath(basePath);
  const root = createTreeNode(
    normalizedBasePath === "/" ? "/" : normalizedBasePath.split("/").pop() || normalizedBasePath,
    normalizedBasePath,
    "folder"
  );

  const index = new Map<string, AemExperienceFragmentTreeNode>([[normalizedBasePath, root]]);

  const sortedFragments = [...fragmentNodes].sort((left, right) => left.path.localeCompare(right.path));
  const sortedVariations = [...variationNodes].sort((left, right) => left.path.localeCompare(right.path));

  for (const fragmentNode of sortedFragments) {
    upsertNode(root, index, normalizedBasePath, fragmentNode.path, "experience-fragment", fragmentNode.title);
  }

  for (const variationNode of sortedVariations) {
    upsertNode(root, index, normalizedBasePath, variationNode.path, "variation", variationNode.title);
  }

  sortTree(root);

  return {
    root,
    tree: renderTreeLines(root).join("\n"),
    stats: computeTreeStats(root),
  };
}
