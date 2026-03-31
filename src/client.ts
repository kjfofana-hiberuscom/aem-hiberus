/**
 * AEM HTTP client with Basic auth.
 * Provides JCR/Sling helpers used by all tool modules.
 */

import type { AemConfig } from "./config.js";

export class AemClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;

  constructor(config: AemConfig) {
    this.baseUrl = config.aemUrl;
    this.authHeader =
      "Basic " +
      Buffer.from(`${config.user}:${config.password}`).toString("base64");
  }

  // ---------------------------------------------------------------------------
  // Core fetch helper
  // ---------------------------------------------------------------------------

  private async request(
    method: string,
    path: string,
    body?: URLSearchParams | string | null,
    extraHeaders: Record<string, string> = {}
  ): Promise<any> {
    const url = path.startsWith("http") ? path : `${this.baseUrl}${path}`;

    const headers: Record<string, string> = {
      Authorization: this.authHeader,
      Accept: "application/json",
      ...extraHeaders,
    };

    if (body instanceof URLSearchParams) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    } else if (typeof body === "string" && body) {
      headers["Content-Type"] = "application/json";
    }

    const response = await fetch(url, {
      method,
      headers,
      body: body ?? undefined,
      redirect: "follow",
    });

    if (response.status === 204) return {};

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const err: any = new Error(
        `AEM ${method} ${path} → ${response.status}: ${text.slice(0, 300)}`
      );
      err.status = response.status;
      throw err;
    }

    const text = await response.text();
    if (!text || text.trim() === "") return {};
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  // ---------------------------------------------------------------------------
  // HTTP methods
  // ---------------------------------------------------------------------------

  /** GET a JSON endpoint. Optionally append query params. */
  async get(path: string, params?: Record<string, any>): Promise<any> {
    let fullPath = path;
    if (params && Object.keys(params).length > 0) {
      const base = path.startsWith("http")
        ? path
        : `${this.baseUrl}${path}`;
      const url = new URL(base);
      Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined && v !== null) url.searchParams.append(k, String(v));
      });
      // Return just the path+query if not absolute, otherwise full URL
      fullPath = path.startsWith("http") ? url.toString() : url.pathname + url.search;
    }
    return this.request("GET", fullPath);
  }

  /** GET a JCR JSON endpoint with numeric depth or infinity. */
  async getJson(path: string, depthOrInfinity: number | "infinity" = 1): Promise<any> {
    const suffix =
      depthOrInfinity === "infinity" ? ".infinity.json" : `.${depthOrInfinity}.json`;
    return this.get(`${path}${suffix}`);
  }

  /** Check whether a JCR path exists. */
  async exists(path: string): Promise<boolean> {
    try {
      await this.get(`${path}.json`);
      return true;
    } catch (error: any) {
      if (error?.status === 404) {
        return false;
      }
      throw error;
    }
  }

  /** POST with URLSearchParams (Sling form post) */
  async post(path: string, body: URLSearchParams): Promise<any> {
    return this.request("POST", path, body, { Accept: "application/json" });
  }

  /** POST JSON body */
  async postJson(path: string, body: object): Promise<any> {
    return this.request("POST", path, JSON.stringify(body), {
      "Content-Type": "application/json",
      Accept: "application/json",
    });
  }

  /** POST raw binary body (used by asset upload via /api/assets/).
   *  Uses same Basic Auth as all other methods. */
  async postBinary(
    path: string,
    data: Buffer | Uint8Array,
    contentType: string
  ): Promise<any> {
    const url = path.startsWith("http") ? path : `${this.baseUrl}${path}`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: this.authHeader,
        "Content-Type": contentType,
        Accept: "application/json",
      },
      body: data.buffer.slice(
        data.byteOffset,
        data.byteOffset + data.byteLength
      ) as ArrayBuffer,
      redirect: "follow",
    });

    if (response.status === 204) return {};
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const e: any = new Error(
        `AEM POST ${path} → ${response.status}: ${text.slice(0, 300)}`
      );
      e.status = response.status;
      throw e;
    }
    const text = await response.text();
    if (!text || text.trim() === "") return {};
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  /** POST and return raw Response (needed for Location header on workflow creation) */
  async postRaw(path: string, body: URLSearchParams): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    return fetch(url, {
      method: "POST",
      headers: {
        Authorization: this.authHeader,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
      redirect: "follow",
    });
  }

  /** PUT JSON body */
  async put(path: string, body: object): Promise<any> {
    return this.request("PUT", path, JSON.stringify(body), {
      "Content-Type": "application/json",
      Accept: "application/json",
    });
  }

  /** DELETE */
  async delete(path: string): Promise<any> {
    return this.request("DELETE", path);
  }

  // ---------------------------------------------------------------------------
  // Sling helpers
  // ---------------------------------------------------------------------------

  /** Sling POST servlet with :operation=delete */
  async slingDelete(path: string): Promise<any> {
    const fd = new URLSearchParams();
    fd.append(":operation", "delete");
    return this.post(path, fd);
  }

  /** Sling import with JSON content */
  async slingImport(
    path: string,
    content: object,
    options: { replace?: boolean; replaceProperties?: boolean } = {}
  ): Promise<any> {
    const fd = new URLSearchParams();
    fd.append(":operation", "import");
    fd.append(":contentType", "json");
    fd.append(":replace", String(options.replace ?? true));
    fd.append(":replaceProperties", String(options.replaceProperties ?? true));
    fd.append(":content", JSON.stringify(content));
    return this.post(path, fd);
  }
}
