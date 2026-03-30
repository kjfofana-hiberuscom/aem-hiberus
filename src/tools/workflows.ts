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

const COMMON_WORKFLOWS: Record<string, string> = {
  request_for_activation: "Publish/activate pages",
  request_for_deactivation: "Unpublish/deactivate pages",
  request_for_deletion: "Delete pages",
  "dam/update_asset": "Update DAM assets",
  "wcm-translation/translate-language-copy": "Translate language copies",
  activationmodel: "Activation workflow",
  scheduled_activation: "Scheduled activation",
  scheduled_deactivation: "Scheduled deactivation",
};

export function registerWorkflowTools(
  server: McpServer,
  client: AemClient,
  config: AemConfig
): void {
  // -------------------------------------------------------------------------
  // listWorkflowModels
  // -------------------------------------------------------------------------
  server.registerTool(
    "listWorkflowModels",
    { description: "List all available AEM workflow models with their IDs" },
    async () => {
      try {
        const data = await client.get("/etc/workflow/models.json");
        const models = Array.isArray(data) ? data : [];

        const enriched = models.map((m: any) => {
          const uri = m.uri || "";
          const modelId = uri.replace("/var/workflow/models/", "");
          return {
            uri,
            modelId,
            description: COMMON_WORKFLOWS[modelId] || "Custom workflow model",
            ...m,
          };
        });

        return ok({
          models: enriched,
          totalCount: enriched.length,
          commonWorkflows: Object.entries(COMMON_WORKFLOWS).map(([id, desc]) => ({
            modelId: id,
            uri: `/var/workflow/models/${id}`,
            description: desc,
          })),
        });
      } catch (e: any) {
        return err(`listWorkflowModels failed: ${e.message}`);
      }
    }
  );

  // -------------------------------------------------------------------------
  // startWorkflow
  // -------------------------------------------------------------------------
  server.registerTool(
    "startWorkflow",
    {
      description: "Start an AEM workflow instance for a given payload path",
      inputSchema: {
        modelId: z.string().describe("Workflow model ID (e.g. 'request_for_activation') or full URI"),
        payload: z.string().describe("JCR payload path (e.g. /content/site/en/home)"),
        payloadType: z.string().default("JCR_PATH").describe("Payload type (JCR_PATH or URL)"),
      },
    },
    async ({ modelId, payload, payloadType }) => {
      if (config.readOnly) return readOnlyErr();
      try {
        const modelUri = modelId.startsWith("/var/workflow/models/")
          ? modelId
          : `/var/workflow/models/${modelId}`;

        const fd = new URLSearchParams();
        fd.append("model", modelUri);
        fd.append("payloadType", payloadType);
        fd.append("payload", payload);

        const response = await client.postRaw("/etc/workflow/instances", fd);

        let instancePath: string | null = null;
        let instanceId: string | null = null;
        const location = response.headers.get("Location");
        if (location) {
          instancePath = location.startsWith("http") ? new URL(location).pathname : location;
          const parts = instancePath.split("/").filter(Boolean);
          if (parts.length > 0) instanceId = parts[parts.length - 1];
        }

        return ok({
          modelId,
          modelUri,
          payload,
          payloadType,
          instanceId,
          instancePath,
          status: response.status,
          message: "Workflow instance started successfully",
        });
      } catch (e: any) {
        return err(`startWorkflow failed: ${e.message}`);
      }
    }
  );

  // -------------------------------------------------------------------------
  // listWorkflowInstances
  // -------------------------------------------------------------------------
  server.registerTool(
    "listWorkflowInstances",
    {
      description: "List AEM workflow instances, optionally filtered by state",
      inputSchema: {
        state: z
          .enum(["RUNNING", "SUSPENDED", "ABORTED", "COMPLETED"])
          .optional()
          .describe("Filter by state. Omit for all."),
      },
    },
    async ({ state }) => {
      try {
        const url = state
          ? `/etc/workflow/instances.${state}.json`
          : "/etc/workflow/instances.json";
        const data = await client.get(url);
        const instances = Array.isArray(data) ? data : (data?.instances || []);
        return ok({ instances, totalCount: instances.length, state: state || "all", timestamp: new Date().toISOString() });
      } catch (e: any) {
        return err(`listWorkflowInstances failed: ${e.message}`);
      }
    }
  );

  // -------------------------------------------------------------------------
  // getWorkflowInstance
  // -------------------------------------------------------------------------
  server.registerTool(
    "getWorkflowInstance",
    {
      description: "Get details of a specific AEM workflow instance",
      inputSchema: {
        instanceId: z.string().describe("Workflow instance ID or full path"),
      },
    },
    async ({ instanceId }) => {
      try {
        const instancePath = instanceId.startsWith("/var/workflow/instances/")
          ? instanceId
          : `/var/workflow/instances/${instanceId}`;
        const data = await client.get(`${instancePath}.json`);
        return ok({ instanceId, instancePath, instance: data, timestamp: new Date().toISOString() });
      } catch (e: any) {
        return err(`getWorkflowInstance failed: ${e.message}`);
      }
    }
  );

  // -------------------------------------------------------------------------
  // getInboxItems
  // -------------------------------------------------------------------------
  server.registerTool(
    "getInboxItems",
    { description: "Get workflow inbox items assigned to the current AEM user" },
    async () => {
      try {
        const data = await client.get("/bin/workflow/inbox.json");
        const items = data?.items || data || [];
        return ok({ items, totalCount: Array.isArray(items) ? items.length : 0, timestamp: new Date().toISOString() });
      } catch (e: any) {
        return err(`getInboxItems failed: ${e.message}`);
      }
    }
  );

  // -------------------------------------------------------------------------
  // completeWorkItem
  // -------------------------------------------------------------------------
  server.registerTool(
    "completeWorkItem",
    {
      description: "Complete or advance a workflow work item to the next step",
      inputSchema: {
        workItemPath: z.string().describe("Full path to the work item in the inbox"),
        routeId: z.string().optional().describe("Route ID to advance to. Auto-selected if omitted."),
        comment: z.string().optional().describe("Optional comment"),
      },
    },
    async ({ workItemPath, routeId, comment }) => {
      if (config.readOnly) return readOnlyErr();
      try {
        let selectedRouteId = routeId;
        if (!selectedRouteId) {
          const routesData = await client.get(`${workItemPath}.routes.json`);
          const routes = routesData?.routes || [];
          if (routes.length === 0) return err("No routes available for this work item");
          selectedRouteId = routes[0]?.rid;
          if (!selectedRouteId) return err("No valid route ID found");
        }

        const fd = new URLSearchParams();
        fd.append("item", workItemPath);
        fd.append("route", selectedRouteId);
        if (comment) fd.append("comment", comment);

        const response = await client.post("/bin/workflow/inbox", fd);
        return ok({ workItemPath, routeId: selectedRouteId, comment, response, message: "Work item completed successfully" });
      } catch (e: any) {
        return err(`completeWorkItem failed: ${e.message}`);
      }
    }
  );

  // -------------------------------------------------------------------------
  // delegateWorkItem
  // -------------------------------------------------------------------------
  server.registerTool(
    "delegateWorkItem",
    {
      description: "Delegate a workflow work item to another AEM user or group",
      inputSchema: {
        workItemPath: z.string().describe("Full path to the work item"),
        delegatee: z.string().describe("AEM user ID or group to delegate to"),
      },
    },
    async ({ workItemPath, delegatee }) => {
      if (config.readOnly) return readOnlyErr();
      try {
        const fd = new URLSearchParams();
        fd.append("item", workItemPath);
        fd.append("delegatee", delegatee);
        const response = await client.post("/bin/workflow/inbox", fd);
        return ok({ workItemPath, delegatee, response, message: `Work item delegated to ${delegatee}` });
      } catch (e: any) {
        return err(`delegateWorkItem failed: ${e.message}`);
      }
    }
  );

  // -------------------------------------------------------------------------
  // getWorkItemRoutes
  // -------------------------------------------------------------------------
  server.registerTool(
    "getWorkItemRoutes",
    {
      description: "Get available routes for a workflow work item",
      inputSchema: {
        workItemPath: z.string().describe("Full path to the work item"),
      },
    },
    async ({ workItemPath }) => {
      try {
        const data = await client.get(`${workItemPath}.routes.json`);
        const routes = data?.routes || [];
        return ok({ workItemPath, routes, totalCount: routes.length, timestamp: new Date().toISOString() });
      } catch (e: any) {
        return err(`getWorkItemRoutes failed: ${e.message}`);
      }
    }
  );
}
