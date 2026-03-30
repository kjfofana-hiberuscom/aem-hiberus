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
