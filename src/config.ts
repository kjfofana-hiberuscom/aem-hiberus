export interface AemConfig {
  /** Base URL of the AEM author instance, e.g. http://localhost:4502 */
  aemUrl: string;
  /** AEM user for Basic auth */
  user: string;
  /** AEM password for Basic auth */
  password: string;
  /** When true, all write/mutating tools are disabled */
  readOnly: boolean;
}

/**
 * Load AEM configuration from environment variables.
 *
 * Required:
 *   AEM_URL       — base URL of AEM author instance
 *
 * Optional:
 *   AEM_USER      — AEM user (default: admin)
 *   AEM_PASSWORD  — AEM password (default: admin)
 *   AEM_READ_ONLY — set to "true" to disable write tools
 */
export function loadConfig(): AemConfig {
  const aemUrl = process.env["AEM_URL"];
  if (!aemUrl || aemUrl.trim() === "") {
    throw new Error(
      "Missing required environment variable: AEM_URL\n" +
        "Example: AEM_URL=http://localhost:4502"
    );
  }

  return {
    aemUrl: aemUrl.trim().replace(/\/$/, ""),
    user: process.env["AEM_USER"] ?? "admin",
    password: process.env["AEM_PASSWORD"] ?? "admin",
    readOnly: (process.env["AEM_READ_ONLY"] ?? "false").toLowerCase() === "true",
  };
}
