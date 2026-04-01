import type { AemClient } from "./client.js";
import type {
  AemCloneVerification,
  AemExperienceFragmentAdaptationResult,
  AemExperienceFragmentAnalysis,
  AemExperienceFragmentCompareDifference,
  AemExperienceFragmentCompareResult,
  AemExperienceFragmentContentSummary,
  AemExperienceFragmentDetectedComponent,
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
  language?: string;
  lastModified?: string;
  status?: string;
  isEmpty?: boolean;
  category?: string;
  contentSummary?: AemExperienceFragmentContentSummary;
}

export interface EnsureFolderPathOptions {
  path: string;
  rootPath: string;
}

export interface AdaptExperienceFragmentOptions {
  sourceLanguage: string;
  targetLanguage: string;
  internalUrlPatternFrom?: string;
  internalUrlPatternTo?: string;
  navigationRootFrom?: string;
  navigationRootTo?: string;
  customReplacements?: Array<{ from: string; to: string; label?: string }>;
}

export interface ExperienceFragmentInspection {
  path: string;
  title?: string;
  lastModified?: string;
  status?: string;
  language?: string;
  detectedLanguages: string[];
  category?: string;
  variationNames: string[];
  variationNodes: TreeSourceNode[];
  manualReviewFields: string[];
  analysis: AemExperienceFragmentAnalysis;
}

interface RewriteRule {
  from: string;
  to: string;
  label: string;
}

interface InspectionAccumulator {
  components: AemExperienceFragmentDetectedComponent[];
  resourceTypeCounts: Map<string, number>;
  textPropertyCount: number;
  urlPropertyCount: number;
  detectedLanguages: Set<string>;
  manualReviewReasons: Set<string>;
  manualReviewFields: Set<string>;
}

const VOLATILE_PROPERTY_PATTERNS: RegExp[] = [
  /^jcr:uuid$/,
  /^jcr:(created|createdBy|lastModified|lastModifiedBy|baseVersion|predecessors|versionHistory|isCheckedOut|mergeFailed|activity|configuration)$/,
  /^cq:(lastModified|lastModifiedBy|lastReplicated|lastReplicatedBy|lastReplicationAction|lastRolledout|lastRolledoutBy)$/,
  /^rep:/,
  /^oak:/,
];

const STRUCTURAL_RESOURCE_TYPES = new Set<string>([
  "cq/experience-fragments/components/experiencefragment",
  "cq/experience-fragments/components/xfpage",
  "wcm/foundation/components/responsivegrid",
  "core/wcm/components/container/v1/container",
  "core/wcm/components/container/v1/container/responsivegrid",
]);

const LANGUAGE_SEGMENT_PATTERN = /^[a-z]{2}(?:[-_][A-Za-z]{2})?$/;
const TEXT_PROPERTY_PATTERN = /(text|title|label|alt|description|caption|message|subtitle|eyebrow|copy|placeholder|name)$/i;
const URL_PROPERTY_PATTERN = /(url|href|link|path|navigationroot|filereference|fragmentpath)$/i;

const KNOWN_LANGUAGE_KEYS = new Set<string>(["language", "locale", "jcr:language", "cq:language"]);
const KNOWN_NON_TEXT_KEYS = new Set<string>([
  "sling:resourceType",
  "jcr:primaryType",
  "cq:xfVariantType",
  "target",
  "id",
  "name",
  "type",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPrimitive(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function getStringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function normalizeLanguageCode(language: string | undefined): string | undefined {
  if (!language) return undefined;
  const normalized = language.trim();
  if (!normalized) return undefined;
  return normalized.split(/[-_]/)[0]?.toLowerCase();
}

function isSystemProperty(key: string): boolean {
  return key.startsWith("jcr:") || key.startsWith("rep:") || key.startsWith("oak:");
}

function isUrlPropertyName(key: string): boolean {
  return URL_PROPERTY_PATTERN.test(key);
}

function isTextPropertyName(key: string): boolean {
  if (KNOWN_NON_TEXT_KEYS.has(key)) return false;
  if (isUrlPropertyName(key)) return false;
  return TEXT_PROPERTY_PATTERN.test(key);
}

function shouldDropProperty(key: string): boolean {
  return VOLATILE_PROPERTY_PATTERNS.some((pattern) => pattern.test(key));
}

function detectLanguageFromNode(node: Record<string, unknown>): string | undefined {
  for (const key of KNOWN_LANGUAGE_KEYS) {
    const detected = normalizeLanguageCode(getStringValue(node[key]));
    if (detected) return detected;
  }
  return undefined;
}

function buildContentSummary(accumulator: InspectionAccumulator, variationCount: number): AemExperienceFragmentContentSummary {
  return {
    variationCount,
    componentCount: accumulator.components.length,
    resourceTypes: [...accumulator.resourceTypeCounts.entries()]
      .map(([resourceType, count]) => ({ resourceType, count }))
      .sort((left, right) => left.resourceType.localeCompare(right.resourceType)),
    textPropertyCount: accumulator.textPropertyCount,
    urlPropertyCount: accumulator.urlPropertyCount,
  };
}

function collectPrimitivePropertyKeys(node: Record<string, unknown>): Array<[string, string]> {
  const result: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(node)) {
    if (isSystemProperty(key)) continue;
    if (typeof value === "string" && value.trim() !== "") {
      result.push([key, value]);
      continue;
    }
    if (Array.isArray(value)) {
      const joined = value.filter((item): item is string => typeof item === "string" && item.trim() !== "").join(" ");
      if (joined) {
        result.push([key, joined]);
      }
    }
  }
  return result;
}

function scanVariationNode(
  node: Record<string, unknown>,
  nodePath: string,
  inheritedLanguage: string | undefined,
  accumulator: InspectionAccumulator
): void {
  const nodeLanguage = detectLanguageFromNode(node) ?? inheritedLanguage;
  if (nodeLanguage) {
    accumulator.detectedLanguages.add(nodeLanguage);
  }

  const resourceType = getStringValue(node["sling:resourceType"]);
  if (resourceType && !STRUCTURAL_RESOURCE_TYPES.has(resourceType)) {
    const primitiveProperties = collectPrimitivePropertyKeys(node);
    const textEntries = primitiveProperties.filter(([key]) => isTextPropertyName(key));
    const urlEntries = primitiveProperties.filter(([key]) => isUrlPropertyName(key));
    const textPreview = textEntries[0]?.[1];
    const contentLength = textEntries.reduce((sum, [, value]) => sum + value.length, 0);

    accumulator.components.push({
      path: nodePath,
      type: resourceType,
      language: nodeLanguage,
      textKeys: textEntries.map(([key]) => key),
      urlKeys: urlEntries.map(([key]) => key),
      contentPreview: textPreview ? textPreview.slice(0, 120) : undefined,
      contentLength: contentLength > 0 ? contentLength : undefined,
    });

    accumulator.resourceTypeCounts.set(resourceType, (accumulator.resourceTypeCounts.get(resourceType) ?? 0) + 1);
    accumulator.textPropertyCount += textEntries.length;
    accumulator.urlPropertyCount += urlEntries.length;

    if (textEntries.length > 0) {
      accumulator.manualReviewReasons.add("Detected text-bearing properties that require manual translation review");
      for (const [key] of textEntries) {
        accumulator.manualReviewFields.add(`${nodePath}/${key}`);
      }
    }
  }

  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith("rep:") || key.startsWith("oak:")) continue;
    if (isPlainObject(value)) {
      scanVariationNode(value, `${nodePath}/${key}`, nodeLanguage, accumulator);
      continue;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        if (isPlainObject(item)) {
          scanVariationNode(item, `${nodePath}/${key}[${index}]`, nodeLanguage, accumulator);
        }
      });
    }
  }
}

function getVariationEntries(
  xfPath: string,
  xfData: Record<string, unknown>
): Array<{ name: string; title?: string; path: string; data: Record<string, unknown> }> {
  const variations: Array<{ name: string; title?: string; path: string; data: Record<string, unknown> }> = [];

  for (const [childName, childValue] of Object.entries(xfData)) {
    if (!isPlainObject(childValue)) continue;
    const childContent = isPlainObject(childValue["jcr:content"]) ? childValue["jcr:content"] : undefined;
    if (!childContent) continue;
    if (!getStringValue(childContent["cq:xfVariantType"])) continue;
    variations.push({
      name: childName,
      title: getStringValue(childContent["jcr:title"]),
      path: `${normalizeJcrPath(xfPath)}/${childName}`,
      data: childValue,
    });
  }

  return variations.sort((left, right) => left.name.localeCompare(right.name));
}

function applyTreeNodeMetadata(
  node: AemExperienceFragmentTreeNode,
  metadata: TreeSourceNode
): void {
  node.title = metadata.title;
  node.language = metadata.language;
  node.lastModified = metadata.lastModified;
  node.status = metadata.status;
  node.isEmpty = metadata.isEmpty;
  node.category = metadata.category;
  node.contentSummary = metadata.contentSummary;
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

export function detectLanguageFromPath(path: string, basePath?: string): string | undefined {
  const normalizedPath = normalizeJcrPath(path);
  const normalizedBase = basePath ? normalizeJcrPath(basePath) : undefined;
  const relativePath = normalizedBase && normalizedPath.startsWith(`${normalizedBase}/`)
    ? normalizedPath.slice(normalizedBase.length + 1)
    : normalizedPath.replace(/^\//, "");

  const segments = relativePath.split("/").filter(Boolean);
  for (const segment of segments) {
    if (!LANGUAGE_SEGMENT_PATTERN.test(segment)) continue;
    const detected = normalizeLanguageCode(segment);
    if (detected) return detected;
  }

  return undefined;
}

export function detectExperienceFragmentCategory(
  path: string,
  basePath?: string,
  language?: string
): string | undefined {
  const normalizedPath = normalizeJcrPath(path);
  const normalizedBase = basePath ? normalizeJcrPath(basePath) : undefined;
  const relativePath = normalizedBase && normalizedPath.startsWith(`${normalizedBase}/`)
    ? normalizedPath.slice(normalizedBase.length + 1)
    : normalizedPath.replace(/^\//, "");

  const segments = relativePath.split("/").filter(Boolean);
  if (segments.length === 0) return undefined;
  const languageCode = normalizeLanguageCode(language);
  const candidateIndex = languageCode && normalizeLanguageCode(segments[0]) === languageCode ? 1 : 0;
  return segments[candidateIndex];
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
    primaryType: getStringValue(node["jcr:primaryType"]),
    resourceType: getStringValue(node["sling:resourceType"]) ?? getStringValue(jcrContent?.["sling:resourceType"]),
    title: getStringValue(node["jcr:title"]) ?? getStringValue(jcrContent?.["jcr:title"]),
    childNodeCount: countVisibleChildren(node),
  };
}

export function extractExperienceFragmentVariationNames(node: Record<string, unknown>): string[] {
  return getVariationEntries("/ignored", node).map((variation) => variation.name);
}

export async function ensureFolderPath(
  client: AemClient,
  options: EnsureFolderPathOptions
): Promise<string[]> {
  const targetPath = normalizeJcrPath(options.path);
  const rootPath = normalizeJcrPath(options.rootPath);

  if (!(await client.exists(rootPath))) {
    throw new Error(`Folder root path not found: ${rootPath}`);
  }

  if (targetPath === rootPath) {
    return [];
  }

  if (!targetPath.startsWith(`${rootPath}/`)) {
    throw new Error(`Target folder path must be inside root path: ${targetPath}`);
  }

  const relativeSegments = targetPath.slice(rootPath.length + 1).split("/").filter(Boolean);
  const createdPaths: string[] = [];
  let currentPath = rootPath;

  for (const segment of relativeSegments) {
    currentPath = `${currentPath}/${segment}`;
    if (await client.exists(currentPath)) {
      continue;
    }
    const formData = new URLSearchParams();
    formData.append("jcr:primaryType", "sling:OrderedFolder");
    await client.post(currentPath, formData);
    createdPaths.push(currentPath);
  }

  return createdPaths;
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

export function inspectExperienceFragmentData(
  xfPath: string,
  xfData: Record<string, unknown>,
  basePath?: string
): ExperienceFragmentInspection {
  const rootContent = isPlainObject(xfData["jcr:content"]) ? xfData["jcr:content"] : {};
  const pathLanguage = detectLanguageFromPath(xfPath, basePath);
  const accumulator: InspectionAccumulator = {
    components: [],
    resourceTypeCounts: new Map<string, number>(),
    textPropertyCount: 0,
    urlPropertyCount: 0,
    detectedLanguages: new Set<string>(pathLanguage ? [pathLanguage] : []),
    manualReviewReasons: new Set<string>(),
    manualReviewFields: new Set<string>(),
  };

  const variations = getVariationEntries(xfPath, xfData);
  for (const variation of variations) {
    const variationContent = isPlainObject(variation.data["jcr:content"]) ? variation.data["jcr:content"] : variation.data;
    scanVariationNode(variationContent, `${variation.path}/jcr:content`, pathLanguage, accumulator);
  }

  const detectedLanguageFromContent = detectLanguageFromNode(rootContent);
  if (detectedLanguageFromContent) {
    accumulator.detectedLanguages.add(detectedLanguageFromContent);
  }

  const contentSummary = buildContentSummary(accumulator, variations.length);
  const detectedLanguages = [...accumulator.detectedLanguages].sort((left, right) => left.localeCompare(right));
  const language = pathLanguage ?? detectedLanguages[0];
  const translationRequired = accumulator.textPropertyCount > 0;
  const isEmpty = accumulator.components.length === 0 && accumulator.textPropertyCount === 0 && accumulator.urlPropertyCount === 0;

  if (!language) {
    accumulator.manualReviewReasons.add("Unable to detect language from path or XF content metadata");
  }

  const manualReviewReasons = [...accumulator.manualReviewReasons].sort((left, right) => left.localeCompare(right));
  const analysis: AemExperienceFragmentAnalysis = {
    isEmpty,
    language,
    detectedLanguages,
    translationRequired,
    estimatedTranslationKeys: accumulator.textPropertyCount,
    requiresManualReview: manualReviewReasons.length > 0,
    manualReviewReasons,
    components: accumulator.components,
    contentSummary,
  };

  return {
    path: normalizeJcrPath(xfPath),
    title: getStringValue(rootContent["jcr:title"]),
    lastModified: getStringValue(rootContent["cq:lastModified"]) ?? getStringValue(rootContent["jcr:lastModified"]),
    status: getStringValue(rootContent["cq:lastReplicationAction"])?.toLowerCase() === "activate" ? "published" : "draft",
    language,
    detectedLanguages,
    category: detectExperienceFragmentCategory(xfPath, basePath, language),
    variationNames: variations.map((variation) => variation.name),
    variationNodes: variations.map((variation) => ({ path: variation.path, title: variation.title })),
    manualReviewFields: [...accumulator.manualReviewFields].sort((left, right) => left.localeCompare(right)),
    analysis,
  };
}

export function buildPostCloneAnalysis(
  inspection: ExperienceFragmentInspection,
  adaptedUrlCount: number
): {
  hasUntranslatedText: boolean;
  adaptedUrlCount: number;
  requiresManualReview: boolean;
  detectedLanguages: string[];
  estimatedTranslationKeys: number;
  manualReviewReasons: string[];
  contentSummary: AemExperienceFragmentContentSummary;
} {
  return {
    hasUntranslatedText: inspection.analysis.translationRequired,
    adaptedUrlCount,
    requiresManualReview: inspection.analysis.requiresManualReview,
    detectedLanguages: inspection.detectedLanguages,
    estimatedTranslationKeys: inspection.analysis.estimatedTranslationKeys,
    manualReviewReasons: inspection.analysis.manualReviewReasons,
    contentSummary: inspection.analysis.contentSummary,
  };
}

function buildRewriteRules(options: AdaptExperienceFragmentOptions): RewriteRule[] {
  const rules: RewriteRule[] = [];
  const sourceSegment = `/${options.sourceLanguage}/`;
  const targetSegment = `/${options.targetLanguage}/`;

  rules.push({
    from: options.internalUrlPatternFrom ?? sourceSegment,
    to: options.internalUrlPatternTo ?? targetSegment,
    label: "internal-language-segment",
  });

  if (options.navigationRootFrom && options.navigationRootTo) {
    rules.push({
      from: options.navigationRootFrom,
      to: options.navigationRootTo,
      label: "navigation-root",
    });
  }

  for (const replacement of options.customReplacements ?? []) {
    rules.push({
      from: replacement.from,
      to: replacement.to,
      label: replacement.label ?? "custom-replacement",
    });
  }

  return rules.filter((rule) => rule.from !== rule.to && rule.from !== "");
}

function applyStringReplacements(value: string, rules: RewriteRule[]): { value: string; appliedRuleLabels: string[] } {
  let nextValue = value;
  const appliedRuleLabels: string[] = [];

  for (const rule of rules) {
    if (!nextValue.includes(rule.from)) continue;
    nextValue = nextValue.split(rule.from).join(rule.to);
    appliedRuleLabels.push(rule.label);
  }

  return {
    value: nextValue,
    appliedRuleLabels,
  };
}

function rewriteWhitelistedProperties(
  node: unknown,
  nodePath: string,
  rules: RewriteRule[],
  adaptationLog: string[],
  adaptedNodes: Set<string>
): { value: unknown; adaptedUrls: number } {
  if (Array.isArray(node)) {
    let adaptedUrls = 0;
    const nextArray = node.map((item, index) => {
      const rewritten = rewriteWhitelistedProperties(item, `${nodePath}[${index}]`, rules, adaptationLog, adaptedNodes);
      adaptedUrls += rewritten.adaptedUrls;
      return rewritten.value;
    });
    return { value: nextArray, adaptedUrls };
  }

  if (!isPlainObject(node)) {
    return { value: node, adaptedUrls: 0 };
  }

  let adaptedUrls = 0;
  const rewrittenNode: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(node)) {
    if (typeof value === "string" && isUrlPropertyName(key)) {
      const rewrittenValue = applyStringReplacements(value, rules);
      rewrittenNode[key] = rewrittenValue.value;
      if (rewrittenValue.value !== value) {
        adaptedUrls += 1;
        adaptedNodes.add(nodePath);
        adaptationLog.push(`Updated ${nodePath}/${key} using ${rewrittenValue.appliedRuleLabels.join(", ")}`);
      }
      continue;
    }

    if (Array.isArray(value) && isUrlPropertyName(key)) {
      let propertyChanged = false;
      const nextArray = value.map((item) => {
        if (typeof item !== "string") return item;
        const rewrittenValue = applyStringReplacements(item, rules);
        if (rewrittenValue.value !== item) {
          propertyChanged = true;
          adaptedUrls += 1;
        }
        return rewrittenValue.value;
      });
      rewrittenNode[key] = nextArray;
      if (propertyChanged) {
        adaptedNodes.add(nodePath);
        adaptationLog.push(`Updated ${nodePath}/${key} using array URL replacements`);
      }
      continue;
    }

    const rewrittenChild = rewriteWhitelistedProperties(value, `${nodePath}/${key}`, rules, adaptationLog, adaptedNodes);
    adaptedUrls += rewrittenChild.adaptedUrls;
    rewrittenNode[key] = rewrittenChild.value;
  }

  return { value: rewrittenNode, adaptedUrls };
}

export function adaptExperienceFragmentData(
  xfPath: string,
  xfData: Record<string, unknown>,
  options: AdaptExperienceFragmentOptions
): {
  adaptedContent: Record<string, unknown>;
  result: AemExperienceFragmentAdaptationResult;
} {
  const rules = buildRewriteRules(options);
  const adaptationLog: string[] = [];
  const adaptedNodes = new Set<string>();
  const rewritten = rewriteWhitelistedProperties(xfData, normalizeJcrPath(xfPath), rules, adaptationLog, adaptedNodes);
  const adaptedContent = isPlainObject(rewritten.value) ? rewritten.value : xfData;
  const inspection = inspectExperienceFragmentData(xfPath, adaptedContent);

  return {
    adaptedContent,
    result: {
      xfPath: normalizeJcrPath(xfPath),
      sourceLanguage: options.sourceLanguage,
      targetLanguage: options.targetLanguage,
      adaptedNodes: adaptedNodes.size,
      adaptedUrls: rewritten.adaptedUrls,
      requiresManualTranslation: inspection.manualReviewFields,
      requiresManualReview: inspection.analysis.requiresManualReview,
      log: adaptationLog,
    },
  };
}

interface FlattenedLeaf {
  property: string;
  value: unknown;
}

function flattenComparableLeaves(
  node: unknown,
  currentPath: string,
  leaves: Map<string, FlattenedLeaf>
): void {
  if (Array.isArray(node)) {
    node.forEach((item, index) => flattenComparableLeaves(item, `${currentPath}[${index}]`, leaves));
    return;
  }

  if (!isPlainObject(node)) {
    if (currentPath) {
      const property = currentPath.split("/").pop() ?? currentPath;
      leaves.set(currentPath, { property, value: node });
    }
    return;
  }

  for (const [key, value] of Object.entries(node)) {
    const nextPath = currentPath ? `${currentPath}/${key}` : key;
    if (isPrimitive(value)) {
      leaves.set(nextPath, { property: key, value });
      continue;
    }
    flattenComparableLeaves(value, nextPath, leaves);
  }
}

export function compareExperienceFragmentData(
  sourcePath: string,
  sourceData: Record<string, unknown>,
  targetPath: string,
  targetData: Record<string, unknown>
): AemExperienceFragmentCompareResult {
  const sourceSanitized = sanitizeJcrSubtree(sourceData);
  const targetSanitized = sanitizeJcrSubtree(targetData);

  const sourceLeaves = new Map<string, FlattenedLeaf>();
  const targetLeaves = new Map<string, FlattenedLeaf>();
  flattenComparableLeaves(sourceSanitized, "", sourceLeaves);
  flattenComparableLeaves(targetSanitized, "", targetLeaves);

  const allLeafPaths = [...new Set([...sourceLeaves.keys(), ...targetLeaves.keys()])].sort((left, right) => left.localeCompare(right));
  const differences: AemExperienceFragmentCompareDifference[] = [];
  let matchingLeafCount = 0;

  for (const leafPath of allLeafPaths) {
    const sourceLeaf = sourceLeaves.get(leafPath);
    const targetLeaf = targetLeaves.get(leafPath);

    if (sourceLeaf && targetLeaf && JSON.stringify(sourceLeaf.value) === JSON.stringify(targetLeaf.value)) {
      matchingLeafCount += 1;
      continue;
    }

    let status: AemExperienceFragmentCompareDifference["status"] = "manual-review";
    if (!sourceLeaf || !targetLeaf) {
      status = "missing";
    } else if (isUrlPropertyName(sourceLeaf.property)) {
      status = "adapted";
    }

    differences.push({
      node: leafPath || normalizeJcrPath(sourcePath),
      property: sourceLeaf?.property ?? targetLeaf?.property ?? "unknown",
      source: sourceLeaf?.value,
      target: targetLeaf?.value,
      status,
    });
  }

  const inspectedLeafCount = allLeafPaths.length;
  const matchPercent = inspectedLeafCount === 0
    ? 100
    : Math.round((matchingLeafCount / inspectedLeafCount) * 100);
  const ready = differences.every((difference) => difference.status === "adapted");

  return {
    sourcePath: normalizeJcrPath(sourcePath),
    targetPath: normalizeJcrPath(targetPath),
    matchPercent,
    ready,
    inspectedLeafCount,
    differences,
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
  metadata: TreeSourceNode,
  finalNodeType: AemExperienceFragmentTreeNode["nodeType"]
): void {
  const normalizedFullPath = normalizeJcrPath(metadata.path);
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
      applyTreeNodeMetadata(currentNode, metadata);
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

  [...fragmentNodes]
    .sort((left, right) => left.path.localeCompare(right.path))
    .forEach((fragmentNode) => upsertNode(root, index, normalizedBasePath, fragmentNode, "experience-fragment"));

  [...variationNodes]
    .sort((left, right) => left.path.localeCompare(right.path))
    .forEach((variationNode) => upsertNode(root, index, normalizedBasePath, variationNode, "variation"));

  sortTree(root);

  return {
    root,
    tree: renderTreeLines(root).join("\n"),
    stats: computeTreeStats(root),
  };
}
