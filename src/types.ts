/**
 * AEM-specific TypeScript interfaces for mcp-aem-hiberus.
 */

// Re-export config type for convenience
export type { AemConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Tool result helper
// ---------------------------------------------------------------------------

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

// ---------------------------------------------------------------------------
// AEM domain models
// ---------------------------------------------------------------------------

export interface AemPage {
  name: string;
  path: string;
  title: string;
  template?: string;
  lastModified?: string;
  lastModifiedBy?: string;
  resourceType?: string;
}

export interface AemComponent {
  path: string;
  resourceType: string;
  properties?: Record<string, unknown>;
}

export interface AemSite {
  name: string;
  path: string;
  title: string;
  template?: string;
  lastModified?: string;
}

export interface AemWorkflowModel {
  uri: string;
  modelId: string;
  description: string;
}

export interface AemWorkflowInstance {
  instanceId: string;
  instancePath: string;
  instance: Record<string, unknown>;
}

export interface AemContentFragment {
  path: string;
  title: string;
  model: string;
  description?: string;
  fields: Array<{ name: string; value: unknown; type: string }>;
  variations: Array<{
    name: string;
    title: string;
    fields: Array<{ name: string; value: unknown; type: string }>;
  }>;
}

export interface AemExperienceFragment {
  path: string;
  title: string;
  template: string;
  description: string;
  variations: Array<{ name: string; type: string; path: string; title: string }>;
  tags: string[];
  lastModified: string;
  status: string;
}

export interface AemAsset {
  path: string;
  name: string;
  mimeType?: string;
  title?: string;
}

export interface AemAssetFolder {
  path: string;
  name: string;
  depth: number;
}

export interface AemCloneVerification {
  exists: boolean;
  primaryType?: string;
  resourceType?: string;
  title?: string;
  childNodeCount: number;
}

export interface AemExperienceFragmentDetectedComponent {
  path: string;
  type: string;
  language?: string;
  textKeys: string[];
  urlKeys: string[];
  contentPreview?: string;
  contentLength?: number;
}

export interface AemExperienceFragmentContentSummary {
  variationCount: number;
  componentCount: number;
  resourceTypes: Array<{ resourceType: string; count: number }>;
  textPropertyCount: number;
  urlPropertyCount: number;
}

export interface AemExperienceFragmentAnalysis {
  isEmpty: boolean;
  language?: string;
  detectedLanguages: string[];
  translationRequired: boolean;
  estimatedTranslationKeys: number;
  requiresManualReview: boolean;
  manualReviewReasons: string[];
  components: AemExperienceFragmentDetectedComponent[];
  contentSummary: AemExperienceFragmentContentSummary;
}

export interface AemExperienceFragmentCloneAnalysis {
  hasUntranslatedText: boolean;
  adaptedUrlCount: number;
  requiresManualReview: boolean;
  detectedLanguages: string[];
  estimatedTranslationKeys: number;
  manualReviewReasons: string[];
  contentSummary: AemExperienceFragmentContentSummary;
}

export interface AemExperienceFragmentCloneResult {
  sourcePath: string;
  targetPath: string;
  overwrite: boolean;
  rootTitle?: string;
  variationNames: string[];
  verification: AemCloneVerification;
  contentMetadata?: AemExperienceFragmentCloneAnalysis;
}

export interface AemPageCloneResult {
  sourcePath: string;
  targetPath: string;
  overwrite: boolean;
  pageTitle?: string;
  template?: string;
  verification: AemCloneVerification;
}

export interface AemExperienceFragmentTreeNode {
  name: string;
  path: string;
  nodeType: "folder" | "experience-fragment" | "variation";
  title?: string;
  language?: string;
  lastModified?: string;
  status?: string;
  isEmpty?: boolean;
  category?: string;
  contentSummary?: AemExperienceFragmentContentSummary;
  children: AemExperienceFragmentTreeNode[];
}

export interface AemExperienceFragmentTreeStats {
  fragmentCount: number;
  variationCount: number;
  totalNodeCount: number;
}

export interface AemExperienceFragmentStructureResult {
  xfBasePath: string;
  languageCode: string;
  xfTypes: string[];
  createdPaths: string[];
  ensuredPaths: string[];
  ready: boolean;
}

export interface AemExperienceFragmentAdaptationResult {
  xfPath: string;
  sourceLanguage: string;
  targetLanguage: string;
  adaptedNodes: number;
  adaptedUrls: number;
  requiresManualTranslation: string[];
  requiresManualReview: boolean;
  log: string[];
}

export interface AemExperienceFragmentCompareDifference {
  node: string;
  property: string;
  source?: unknown;
  target?: unknown;
  status: "matching" | "adapted" | "missing" | "manual-review";
}

export interface AemExperienceFragmentCompareResult {
  sourcePath: string;
  targetPath: string;
  matchPercent: number;
  ready: boolean;
  inspectedLeafCount: number;
  differences: AemExperienceFragmentCompareDifference[];
}

export interface AemExperienceFragmentLanguageEntry {
  name: string;
  path: string;
  title?: string;
  isEmpty?: boolean;
  variations?: string[];
  lastModified?: string;
  status?: string;
  contentSummary?: AemExperienceFragmentContentSummary;
}
