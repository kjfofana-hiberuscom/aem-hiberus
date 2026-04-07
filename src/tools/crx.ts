import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AemClient } from "../client.js";
import type { AemConfig } from "../config.js";

// ---------------------------------------------------------------------------
// ok / err helpers
// ---------------------------------------------------------------------------
function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}
function err(msg: string) {
  return { content: [{ type: "text" as const, text: msg }], isError: true as const };
}

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------
interface SelectOption {
  text: string;
  value: string;
}

interface DialogField {
  name: string;
  label: string;
  type: string;
  required: boolean;
  defaultValue: string | null;
  options?: SelectOption[];
  subFields?: DialogField[];
}

interface DialogTab {
  title: string;
  fields: DialogField[];
}

interface ComponentDefinition {
  resourceType: string;
  path: string;
  title: string;
  componentGroup: string | null;
  isContainer: boolean;
  superTypeChain: string[];
  htlSource: string | null;
  slingModels: string[];
  childTemplates: string[];
  dialog: {
    tabs: DialogTab[];
    totalFields: number;
  };
  rawJcr: unknown;
}

interface ComponentSummary {
  name: string;
  path: string;
  resourceType: string;
  title: string;
  isContainer: boolean;
  superType: string | null;
  hasDialog: boolean;
  componentGroup: string | null;
}

interface DiffEntry {
  path: string;
  type: "MISSING_IN_CURRENT" | "MISSING_IN_REFERENCE" | "VALUE_CHANGED" | "CHILD_NODE_DIFF";
  reference?: unknown;
  current?: unknown;
}

interface SlingModelInfo {
  className: string;
  adaptables: string[];
  adapter: string | null;
  resourceTypeBinding: string | null;
  source: "felix-console" | "htl-extraction";
  note?: string;
}

/** Internal parsed model from Felix console text */
interface ParsedModel {
  className: string;
  adaptables: string[];
  adapter: string | null;
  resourceTypeBinding: string | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const FIELD_TYPE_MAP: Readonly<Record<string, string>> = {
  "granite/ui/components/coral/foundation/form/textfield": "text",
  "granite/ui/components/coral/foundation/form/textarea": "textarea",
  "granite/ui/components/coral/foundation/form/checkbox": "checkbox",
  "granite/ui/components/coral/foundation/form/select": "select",
  "granite/ui/components/coral/foundation/form/pathfield": "pathfield",
  "granite/ui/components/coral/foundation/form/pathbrowser": "pathfield",
  "granite/ui/components/coral/foundation/form/multifield": "multifield",
  "cq/gui/components/authoring/dialog/richtext": "richtext",
  "granite/ui/components/coral/foundation/form/hidden": "hidden",
  "granite/ui/components/coral/foundation/form/numberfield": "number",
  "granite/ui/components/coral/foundation/form/datepicker": "date",
  "granite/ui/components/coral/foundation/form/colorfield": "color",
};

/**
 * Suffix-based fallback: maps the last segment of a custom RT to a logical type.
 * Handles custom wrappers like "myapp/form/richtext" → "richtext".
 */
const FIELD_TYPE_SUFFIX_MAP: Readonly<Record<string, string>> = {
  textfield: "text",
  textarea: "textarea",
  checkbox: "checkbox",
  select: "select",
  pathfield: "pathfield",
  pathbrowser: "pathfield",
  multifield: "multifield",
  richtext: "richtext",
  hidden: "hidden",
  numberfield: "number",
  datepicker: "date",
  colorfield: "color",
  // common aliases found in ACS AEM Commons and custom toolkits
  datefield: "date",
  radiogroup: "select",
  radiobuttons: "select",
  switch: "checkbox",
  togglefield: "checkbox",
  autocomplete: "text",
  drawtool: "image",
  fileupload: "file",
};

/** Suffixes that unambiguously identify a form field even without an exact RT match */
const FORM_FIELD_SUFFIXES = new Set<string>(Object.keys(FIELD_TYPE_SUFFIX_MAP));

const VOLATILE_PROPS = new Set<string>([
  "jcr:uuid",
  "jcr:created",
  "jcr:createdBy",
  "jcr:lastModified",
  "jcr:lastModifiedBy",
  "cq:lastModified",
  "cq:lastModifiedBy",
  "jcr:baseVersion",
  "jcr:versionHistory",
  "jcr:isCheckedOut",
  "jcr:predecessors",
  "jcr:mixinTypes",
]);

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/** Build Basic auth header from config */
function buildAuth(config: AemConfig): string {
  return "Basic " + Buffer.from(`${config.user}:${config.password}`).toString("base64");
}

/** Fetch raw text from AEM without forcing Accept: application/json */
async function fetchRawText(config: AemConfig, path: string): Promise<string | null> {
  const url = path.startsWith("http") ? path : `${config.aemUrl}${path}`;
  try {
    const resp = await fetch(url, { headers: { Authorization: buildAuth(config) } });
    if (!resp.ok) return null;
    return await resp.text();
  } catch {
    return null;
  }
}

/** Map a Granite UI sling:resourceType to a logical field type.
 * Resolution order:
 *   1. Exact match in FIELD_TYPE_MAP (fastest, most specific)
 *   2. Suffix match via FIELD_TYPE_SUFFIX_MAP (tolerates custom/wrapper RTs)
 *   3. Falls back to "unknown:{RT}" so the raw RT is still visible to the agent
 */
function mapFieldType(rt: string): string {
  if (FIELD_TYPE_MAP[rt]) return FIELD_TYPE_MAP[rt];
  const suffix = rt.split("/").pop() ?? "";
  if (FIELD_TYPE_SUFFIX_MAP[suffix]) return FIELD_TYPE_SUFFIX_MAP[suffix];
  return `unknown:${rt}`;
}

/** Return true if the rt identifies a form field (not a layout/container).
 * Checks exact Granite UI prefix first, then suffix-based fallback for custom RTs.
 */
function isFormField(rt: string): boolean {
  if (
    rt.startsWith("granite/ui/components/coral/foundation/form/") ||
    rt === "cq/gui/components/authoring/dialog/richtext"
  ) {
    return true;
  }
  const suffix = rt.split("/").pop() ?? "";
  return FORM_FIELD_SUFFIXES.has(suffix);
}

/** Extract <option> list from a Granite select field's items sub-node */
function extractSelectOptions(node: Record<string, unknown>): SelectOption[] | undefined {
  const itemsNode = node["items"];
  if (!itemsNode || typeof itemsNode !== "object" || Array.isArray(itemsNode)) return undefined;
  const items = itemsNode as Record<string, unknown>;
  const opts: SelectOption[] = [];
  for (const [, v] of Object.entries(items)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const item = v as Record<string, unknown>;
      opts.push({
        text: String(item["text"] ?? item["jcr:title"] ?? ""),
        value: String(item["value"] ?? ""),
      });
    }
  }
  return opts.length > 0 ? opts : undefined;
}

/** Parse a single form-field JCR node into a DialogField */
function parseField(node: Record<string, unknown>): DialogField {
  const rt = String(node["sling:resourceType"] ?? "");
  const type = mapFieldType(rt);

  const field: DialogField = {
    name: String(node["name"] ?? ""),
    label: String(node["fieldLabel"] ?? node["jcr:title"] ?? ""),
    type,
    required: node["required"] === true || node["required"] === "true",
    defaultValue: node["value"] != null ? String(node["value"]) : null,
  };

  if (type === "select") {
    const opts = extractSelectOptions(node);
    if (opts) field.options = opts;
  }

  if (type === "multifield") {
    // Try 'field' sub-node first (AEM Classic multifield pattern)
    const fieldDef = node["field"];
    if (fieldDef && typeof fieldDef === "object" && !Array.isArray(fieldDef)) {
      const subRt = String((fieldDef as Record<string, unknown>)["sling:resourceType"] ?? "");
      if (subRt) field.subFields = [parseField(fieldDef as Record<string, unknown>)];
    }
    // Also check items inside multifield (composite multifield)
    const itemsNode = node["items"];
    if (itemsNode && typeof itemsNode === "object" && !Array.isArray(itemsNode)) {
      const subs: DialogField[] = [];
      for (const [, v] of Object.entries(itemsNode as Record<string, unknown>)) {
        if (v && typeof v === "object" && !Array.isArray(v)) {
          const child = v as Record<string, unknown>;
          const childRt = String(child["sling:resourceType"] ?? "");
          if (isFormField(childRt)) subs.push(parseField(child));
        }
      }
      if (subs.length > 0) field.subFields = subs;
    }
  }

  return field;
}

/**
 * Recursively collect DialogFields from a container node's children.
 * Skips jcr:primaryType and other non-structural keys.
 * Recurses into container sub-nodes (those without a form-field RT).
 */
function collectFields(node: Record<string, unknown>): DialogField[] {
  const fields: DialogField[] = [];
  for (const [key, val] of Object.entries(node)) {
    if (
      key === "jcr:primaryType" ||
      key.startsWith("jcr:") ||
      key.startsWith("sling:") ||
      typeof val !== "object" ||
      val === null ||
      Array.isArray(val)
    ) {
      continue;
    }
    const child = val as Record<string, unknown>;
    const rt = String(child["sling:resourceType"] ?? "");

    if (isFormField(rt)) {
      fields.push(parseField(child));
    } else {
      // Container or layout — recurse into its items sub-node if present
      const itemsNode = child["items"];
      if (itemsNode && typeof itemsNode === "object" && !Array.isArray(itemsNode)) {
        fields.push(...collectFields(itemsNode as Record<string, unknown>));
      }
    }
  }
  return fields;
}

/**
 * Parse a _cq_dialog JCR node into an array of DialogTab.
 * Handles: tabbed dialogs, flat dialogs, nested containers.
 */
function parseDialogFields(dialogNode: Record<string, unknown>): DialogTab[] {
  // Standard AEM dialog structure: content → items → [tabs | fields]
  const contentNode = dialogNode["content"];
  const topItems =
    contentNode && typeof contentNode === "object" && !Array.isArray(contentNode)
      ? ((contentNode as Record<string, unknown>)["items"] as Record<string, unknown> | undefined)
      : (dialogNode["items"] as Record<string, unknown> | undefined);

  if (!topItems || typeof topItems !== "object" || Array.isArray(topItems)) {
    return [];
  }

  // Look for a tabs component in top-level items
  for (const [, val] of Object.entries(topItems)) {
    if (!val || typeof val !== "object" || Array.isArray(val)) continue;
    const container = val as Record<string, unknown>;
    const rt = String(container["sling:resourceType"] ?? "");

    if (rt.endsWith("/tabs") || rt.includes("foundation/tabs")) {
      const tabItemsNode = container["items"];
      if (!tabItemsNode || typeof tabItemsNode !== "object" || Array.isArray(tabItemsNode)) {
        return [];
      }
      const tabs: DialogTab[] = [];
      for (const [, tabVal] of Object.entries(tabItemsNode as Record<string, unknown>)) {
        if (!tabVal || typeof tabVal !== "object" || Array.isArray(tabVal)) continue;
        const tab = tabVal as Record<string, unknown>;
        const title = String(tab["jcr:title"] ?? "Tab");
        const tabItems = tab["items"];
        const fields =
          tabItems && typeof tabItems === "object" && !Array.isArray(tabItems)
            ? collectFields(tabItems as Record<string, unknown>)
            : [];
        tabs.push({ title, fields });
      }
      return tabs;
    }
  }

  // Flat dialog — wrap all collected fields in a single "Properties" tab
  return [{ title: "Properties", fields: collectFields(topItems) }];
}

/**
 * Follow sling:resourceSuperType chain up to maxDepth levels.
 * Stops on circular reference (via visited Set) or missing superType.
 */
async function resolveSuperTypeChain(
  client: AemClient,
  initialSuperType: string,
  maxDepth = 5
): Promise<string[]> {
  const chain: string[] = [];
  const visited = new Set<string>();
  let current = initialSuperType;

  for (let i = 0; i < maxDepth; i++) {
    if (!current || visited.has(current)) break;
    visited.add(current);
    chain.push(current);

    // Try /apps/ first, then /libs/ for core components
    const tryPaths = current.startsWith("/")
      ? [current]
      : [`/apps/${current}`, `/libs/${current}`];

    let nextSuperType: string | null = null;
    for (const tryPath of tryPaths) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const data = (await client.getJson(tryPath, 1)) as Record<string, unknown>;
        const st = data["sling:resourceSuperType"];
        if (typeof st === "string" && st.length > 0) {
          nextSuperType = st;
        }
        break;
      } catch {
        /* try next path */
      }
    }
    if (!nextSuperType) break;
    current = nextSuperType;
  }

  return chain;
}

/**
 * Recursive deep diff of two JCR node objects.
 * Returns flat list of DiffEntry with full JCR-style paths.
 */
function deepDiff(
  reference: Record<string, unknown>,
  current: Record<string, unknown>,
  nodePath: string,
  ignoreSet: Set<string>
): DiffEntry[] {
  const entries: DiffEntry[] = [];

  for (const [key, refVal] of Object.entries(reference)) {
    if (ignoreSet.has(key)) continue;
    const childPath = nodePath ? `${nodePath}/${key}` : `./${key}`;

    if (!(key in current)) {
      entries.push({ path: childPath, type: "MISSING_IN_CURRENT", reference: refVal });
      continue;
    }

    const curVal = current[key];
    const refIsObj = refVal !== null && typeof refVal === "object" && !Array.isArray(refVal);
    const curIsObj = curVal !== null && typeof curVal === "object" && !Array.isArray(curVal);

    if (refIsObj && curIsObj) {
      const subDiffs = deepDiff(
        refVal as Record<string, unknown>,
        curVal as Record<string, unknown>,
        childPath,
        ignoreSet
      );
      if (subDiffs.length > 0) {
        entries.push({ path: childPath, type: "CHILD_NODE_DIFF" });
        entries.push(...subDiffs);
      }
    } else {
      const refStr = JSON.stringify(refVal);
      const curStr = JSON.stringify(curVal);
      if (refStr !== curStr) {
        entries.push({ path: childPath, type: "VALUE_CHANGED", reference: refVal, current: curVal });
      }
    }
  }

  for (const [key, curVal] of Object.entries(current)) {
    if (ignoreSet.has(key)) continue;
    if (!(key in reference)) {
      const childPath = nodePath ? `${nodePath}/${key}` : `./${key}`;
      entries.push({ path: childPath, type: "MISSING_IN_REFERENCE", current: curVal });
    }
  }

  return entries;
}

/** Extract Java class names from data-sly-use attributes in HTL source */
function extractSlyModels(htl: string): string[] {
  const models: string[] = [];
  const re = /data-sly-use\.[a-zA-Z0-9_]+=["']([a-zA-Z][a-zA-Z0-9_.]+\.[A-Z][a-zA-Z0-9_]+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(htl)) !== null) {
    if (!models.includes(m[1])) models.push(m[1]);
  }
  return models;
}

/** Extract HTML template references from data-sly-include attributes */
function extractChildTemplates(htl: string): string[] {
  const templates: string[] = [];
  const re = /data-sly-include=["']([^"']+\.html)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(htl)) !== null) {
    if (!templates.includes(m[1])) templates.push(m[1]);
  }
  return templates;
}

/**
 * Parse the plain-text output of /system/console/status-slingmodels.
 *
 * The actual Felix console format (AEM 6.3+) uses single-line entries in the
 * "Bound to Resource Types" sections:
 *
 *   Sling Models Bound to Resource Types *For Resources*:
 *   com.example.MyModel - myapp/components/content/hero
 *
 * Additional "exports" lines follow some entries:
 *   com.example.MyModel exports 'myapp/.../hero' with selector 'model' ...
 *
 * We parse all sections and build a deduplicated list keyed by className.
 */
function parseSlingModelsText(text: string): ParsedModel[] {
  const byClass = new Map<string, ParsedModel>();

  const lines = text.split("\n");
  let inResourceSection = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    // Section headers
    if (line.startsWith("Sling Models Bound to Resource Types")) {
      inResourceSection = true;
      continue;
    }
    if (line.startsWith("Sling Models ") && !line.startsWith("Sling Models Bound")) {
      inResourceSection = false;
      continue;
    }

    if (inResourceSection) {
      // Format: "com.example.MyModel - my/resource/type"
      // OR:     "com.example.MyModel$InnerClass - my/resource/type"
      const bindingMatch = line.match(
        /^([a-z][a-zA-Z0-9_.]*\.[A-Z][a-zA-Z0-9_$]+)\s+-\s+(.+)$/
      );
      if (bindingMatch) {
        const cls = bindingMatch[1];
        const rt = bindingMatch[2].trim();
        const existing = byClass.get(cls);
        if (existing) {
          if (!existing.resourceTypeBinding) existing.resourceTypeBinding = rt;
        } else {
          byClass.set(cls, {
            className: cls,
            adaptables: [],
            adapter: null,
            resourceTypeBinding: rt,
          });
        }
        continue;
      }

      // Format: "com.example.MyModel exports 'my/resource/type' with selector ..."
      const exportMatch = line.match(
        /^([a-z][a-zA-Z0-9_.]*\.[A-Z][a-zA-Z0-9_$]+)\s+exports\s+'([^']+)'/
      );
      if (exportMatch) {
        const cls = exportMatch[1];
        const rt = exportMatch[2].trim();
        if (!byClass.has(cls)) {
          byClass.set(cls, {
            className: cls,
            adaptables: [],
            adapter: null,
            resourceTypeBinding: rt,
          });
        }
      }
    }
  }

  return Array.from(byClass.values());
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------
export function registerCrxTools(
  server: McpServer,
  client: AemClient,
  config: AemConfig
): void {
  // -------------------------------------------------------------------------
  // getComponentDefinition
  // -------------------------------------------------------------------------
  server.registerTool(
    "getComponentDefinition",
    {
      title: "Get Component Definition",
      description:
        "Get the full definition of an AEM component in one call: JCR metadata, dialog fields parsed by tab, HTL source, detected Sling Models, and child templates. Reads from /apps/. Resolves superType chain up to 5 levels.",
      inputSchema: {
        resourceType: z
          .string()
          .describe(
            'Component resource type (e.g. "caixa-international/components/content/hero-carousel") or path with /apps/ prefix'
          ),
      },
    },
    async ({ resourceType }) => {
      try {
        // PASO 1: Normalize path
        const componentPath = resourceType.startsWith("/apps/")
          ? resourceType
          : resourceType.startsWith("/")
            ? resourceType
            : `/apps/${resourceType}`;
        const normalizedRt = componentPath.startsWith("/apps/")
          ? componentPath.slice("/apps/".length)
          : componentPath.replace(/^\//, "");

        // PASO 2: Fetch full JCR via infinity.json
        const jcr = (await client.getJson(componentPath, "infinity")) as Record<string, unknown>;

        const title = String(jcr["jcr:title"] ?? normalizedRt.split("/").pop() ?? "");
        const componentGroup =
          jcr["componentGroup"] != null ? String(jcr["componentGroup"]) : null;
        const isContainer =
          jcr["cq:isContainer"] === true || jcr["cq:isContainer"] === "true";
        const rawSuperType = jcr["sling:resourceSuperType"];
        const superType = typeof rawSuperType === "string" && rawSuperType ? rawSuperType : null;

        // Resolve superType chain (max 5, circular-safe)
        const superTypeChain = superType
          ? await resolveSuperTypeChain(client, superType)
          : [];

        // PASO 3: Fetch HTL source (bypass Accept: application/json)
        const lastSegment = componentPath.split("/").pop() ?? "";
        const htlPath = `${componentPath}/${lastSegment}.html`;
        const htlSource = await fetchRawText(config, htlPath);

        const slingModels = htlSource ? extractSlyModels(htlSource) : [];
        const childTemplates = htlSource ? extractChildTemplates(htlSource) : [];

        // PASO 4: Parse dialog
        // AEM serializes _cq_dialog as either "_cq_dialog" (literal node name) or
        // "cq:dialog" (namespace-qualified). We try both to handle both AEM versions.
        const dialogRaw = jcr["_cq_dialog"] ?? jcr["cq:dialog"];
        const dialogNode =
          dialogRaw && typeof dialogRaw === "object" && !Array.isArray(dialogRaw)
            ? (dialogRaw as Record<string, unknown>)
            : null;
        const tabs = dialogNode ? parseDialogFields(dialogNode) : [];
        const totalFields = tabs.reduce((sum, tab) => sum + tab.fields.length, 0);

        const result: ComponentDefinition = {
          resourceType: normalizedRt,
          path: componentPath,
          title,
          componentGroup,
          isContainer,
          superTypeChain,
          htlSource,
          slingModels,
          childTemplates,
          dialog: { tabs, totalFields },
          rawJcr: jcr,
        };

        return ok(result);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return err(`getComponentDefinition failed: ${msg}`);
      }
    }
  );

  // -------------------------------------------------------------------------
  // listAppComponents
  // -------------------------------------------------------------------------
  server.registerTool(
    "listAppComponents",
    {
      title: "List App Components",
      description:
        "List all cq:Component nodes under /apps/{appName}/components using QueryBuilder (p.limit=500). Returns components grouped by componentGroup with hasDialog flag.",
      inputSchema: {
        appName: z
          .string()
          .describe('Application name under /apps/ (e.g. "caixa-international")'),
        group: z
          .string()
          .optional()
          .describe("Filter by componentGroup. Omit to return all groups."),
      },
    },
    async ({ appName, group }) => {
      try {
        const basePath = `/apps/${appName}/components`;

        // Query 1: all cq:Component nodes
        const compData = (await client.get("/bin/querybuilder.json", {
          type: "cq:Component",
          path: basePath,
          "p.limit": 500,
          "p.hits": "full",
        })) as Record<string, unknown>;

        const hits = ((compData["hits"] as Record<string, unknown>[] | undefined) ?? []);

        // Query 2: find dialog nodes to determine hasDialog.
        // AEM can store the touch-UI dialog as either '_cq_dialog' (literal node name)
        // or 'cq:dialog' (namespace-qualified). We run two queries and merge.
        const [dialogData1, dialogData2] = await Promise.all([
          client
            .get("/bin/querybuilder.json", {
              nodename: "_cq_dialog",
              path: basePath,
              "p.limit": 500,
              "p.hits": "full",
            })
            .catch(() => ({ hits: [] })) as Promise<Record<string, unknown>>,
          client
            .get("/bin/querybuilder.json", {
              nodename: "cq:dialog",
              path: basePath,
              "p.limit": 500,
              "p.hits": "full",
            })
            .catch(() => ({ hits: [] })) as Promise<Record<string, unknown>>,
        ]);

        const allDialogHits = [
          ...((dialogData1["hits"] as Record<string, unknown>[] | undefined) ?? []),
          ...((dialogData2["hits"] as Record<string, unknown>[] | undefined) ?? []),
        ];
        const dialogParents = new Set<string>(
          allDialogHits.map((h) => {
            const p = String(h["jcr:path"] ?? h["@path"] ?? "");
            return p.replace(/\/_cq_dialog$/, "").replace(/\/cq:dialog$/, "");
          }).filter((p) => p.length > 0)
        );

        const components: ComponentSummary[] = hits.map((hit) => {
          const hitPath = String(hit["jcr:path"] ?? hit["@path"] ?? "");
          const name = hitPath.split("/").pop() ?? "";
          const rt = hitPath.startsWith("/apps/") ? hitPath.slice("/apps/".length) : hitPath;
          return {
            name,
            path: hitPath,
            resourceType: rt,
            title: String(hit["jcr:title"] ?? name),
            isContainer:
              hit["cq:isContainer"] === true || hit["cq:isContainer"] === "true",
            superType:
              hit["sling:resourceSuperType"] != null
                ? String(hit["sling:resourceSuperType"])
                : null,
            hasDialog: dialogParents.has(hitPath),
            componentGroup:
              hit["componentGroup"] != null ? String(hit["componentGroup"]) : null,
          };
        });

        // Optional group filter
        const filtered = group
          ? components.filter((c) => c.componentGroup === group)
          : components;

        // Group by componentGroup
        const groups: Record<string, ComponentSummary[]> = {};
        for (const comp of filtered) {
          const g = comp.componentGroup ?? "(ungrouped)";
          if (!groups[g]) groups[g] = [];
          groups[g].push(comp);
        }

        return ok({ appName, groups, totalComponents: filtered.length });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return err(`listAppComponents failed: ${msg}`);
      }
    }
  );

  // -------------------------------------------------------------------------
  // compareComponentInstances
  // -------------------------------------------------------------------------
  server.registerTool(
    "compareComponentInstances",
    {
      title: "Compare Component Instances",
      description:
        "Deep diff two AEM component JCR instances, ignoring volatile/system properties (jcr:uuid, jcr:created, etc.). Useful for validating migration correctness. Limits diff output to 100 entries.",
      inputSchema: {
        referencePath: z
          .string()
          .describe("JCR path of the reference component instance"),
        currentPath: z
          .string()
          .describe("JCR path of the component instance to compare against reference"),
        depth: z
          .number()
          .int()
          .min(1)
          .max(10)
          .default(5)
          .describe("JCR fetch depth for both instances (default 5)"),
        ignoreProperties: z
          .array(z.string())
          .optional()
          .describe(
            "Additional property names to ignore in the diff (on top of default volatile props)"
          ),
      },
    },
    async ({ referencePath, currentPath, depth, ignoreProperties }) => {
      try {
        const [refRaw, curRaw] = await Promise.all([
          client.getJson(referencePath, depth),
          client.getJson(currentPath, depth),
        ]);

        const refJcr = refRaw as Record<string, unknown>;
        const curJcr = curRaw as Record<string, unknown>;

        const ignoreSet = new Set<string>([
          ...VOLATILE_PROPS,
          ...(ignoreProperties ?? []),
        ]);

        const allDiffs = deepDiff(refJcr, curJcr, "", ignoreSet);

        const truncated = allDiffs.length > 100;
        const differences = allDiffs.slice(0, 100);

        const summary = {
          missingInCurrent: allDiffs.filter((d) => d.type === "MISSING_IN_CURRENT").length,
          missingInReference: allDiffs.filter((d) => d.type === "MISSING_IN_REFERENCE").length,
          valueChanged: allDiffs.filter((d) => d.type === "VALUE_CHANGED").length,
          childNodeDiffs: allDiffs.filter((d) => d.type === "CHILD_NODE_DIFF").length,
        };

        const match = allDiffs.length === 0;

        return ok({
          match,
          summary,
          differences,
          truncated,
          referenceResourceType: String(refJcr["sling:resourceType"] ?? ""),
          currentResourceType: String(curJcr["sling:resourceType"] ?? ""),
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return err(`compareComponentInstances failed: ${msg}`);
      }
    }
  );

  // -------------------------------------------------------------------------
  // getSlingModelInfo
  // -------------------------------------------------------------------------
  server.registerTool(
    "getSlingModelInfo",
    {
      title: "Get Sling Model Info",
      description:
        "Look up Sling Model metadata from the Felix console (/system/console/status-slingmodels). Returns adaptables, adapter interface, and resourceType binding. Falls back to HTL data-sly-use extraction if Felix console is unavailable or returns 403.",
      inputSchema: {
        resourceType: z
          .string()
          .optional()
          .describe(
            "Component resource type to search for (e.g. 'myapp/components/content/hero')"
          ),
        className: z
          .string()
          .optional()
          .describe("Fully-qualified Java class name of the Sling Model"),
      },
    },
    async ({ resourceType, className }) => {
      if (!resourceType && !className) {
        return err("At least one of resourceType or className is required");
      }

      // PASO 1–3: Attempt Felix console
      let consoleText: string | null = null;
      try {
        consoleText = await fetchRawText(config, "/system/console/status-slingmodels.txt");
      } catch {
        /* Felix console unavailable — fall through */
      }

      if (consoleText && consoleText.length > 0) {
        const models = parseSlingModelsText(consoleText);

        let found: ParsedModel | undefined;
        if (resourceType) {
          found = models.find((m) => m.resourceTypeBinding === resourceType);
        }
        if (!found && className) {
          found = models.find(
            (m) =>
              m.className === className ||
              m.className.endsWith(`.${className}`)
          );
        }

        if (found) {
          const result: SlingModelInfo = {
            className: found.className,
            adaptables: found.adaptables,
            adapter: found.adapter,
            resourceTypeBinding: found.resourceTypeBinding,
            source: "felix-console",
          };
          return ok(result);
        }

        if (models.length > 0) {
          // Felix console reachable but model not found by resourceType/className binding.
          // Fall through to HTL-extraction fallback below (do not return early).
        }
      }

      // PASO 4: Fallback — extract from HTL data-sly-use attributes
      if (resourceType) {
        const componentPath = resourceType.startsWith("/apps/")
          ? resourceType
          : `/apps/${resourceType}`;
        const lastSegment = componentPath.split("/").pop() ?? "";
        const htlPath = `${componentPath}/${lastSegment}.html`;
        const htlSource = await fetchRawText(config, htlPath);

        if (htlSource) {
          const extracted = extractSlyModels(htlSource);
          if (extracted.length > 0) {
            const result: SlingModelInfo = {
              className: extracted[0],
              adaptables: [],
              adapter: null,
              resourceTypeBinding: resourceType,
              source: "htl-extraction",
              note: "Felix console unavailable or model not found; class extracted from HTL data-sly-use attributes",
            };
            return ok(result);
          }
        }
      }

      return err(
        `getSlingModelInfo: no model info found for ${resourceType ?? className}. Felix console may be unavailable and HTL extraction found no data-sly-use attributes.`
      );
    }
  );
}
