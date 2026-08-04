// Typed API client. Every backend failure — network, HTTP status, or the
// server's JSON error envelope — is normalized into ApiError, which the
// toast layer renders as an error notification bubble.

export interface UiConfig {
  appName: string;
  tagline: string;
  defaultTheme: string;
  repoUrl?: string | null;
}

export interface ServerConfig {
  ui: UiConfig;
  version: string;
  startedAtMs: number;
}

export interface Metrics {
  requestsTotal: number;
  requestsPerMin: number;
  wsClients: number;
  uptimeSecs: number;
  timestampMs: number;
}

export type Document = Record<string, unknown>;

export interface DocumentPage {
  data: Document[];
  page: { limit: number; returned: number; nextCursor: string | null };
  total: number;
}

export interface CollectionInfo {
  name: string;
  count: number;
  indexes: string[];
}

export interface StoreStats {
  collectionCount: number;
  documentCount: number;
  dataPath: string;
}

export interface RequestTrace {
  method: string;
  path: string;
  status: number;
  durationMs: number;
  timestampMs: number;
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers as Record<string, string> | undefined),
      },
    });
  } catch {
    throw new ApiError("NETWORK", 0, "Cannot reach the server");
  }

  if (!res.ok) {
    // Prefer the backend's { error: { code, message } } envelope.
    let code = `HTTP_${res.status}`;
    let message = res.statusText || "Request failed";
    try {
      const body = (await res.json()) as {
        error?: { code?: string; message?: string };
      };
      if (body.error) {
        code = body.error.code ?? code;
        message = body.error.message ?? message;
      }
    } catch {
      /* body was not JSON — keep the status text */
    }
    throw new ApiError(code, res.status, message);
  }

  if (res.status === 204) {
    return undefined as T;
  }
  return (await res.json()) as T;
}

function queryString(params?: Record<string, string | number | boolean | undefined>) {
  if (!params) return "";
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : "";
}

export const api = {
  config: () => request<ServerConfig>("/api/config"),
  health: () => request<{ status: string; version: string }>("/api/health"),
  metrics: () => request<Metrics>("/api/metrics"),
  requests: (limit = 100) => request<{ data: RequestTrace[] }>(`/api/requests?limit=${limit}`),
  storeStats: () => request<StoreStats>("/api/stats"),
  collections: () => request<{ data: CollectionInfo[] }>("/api/collections"),
  compact: () => request<void>("/api/maintenance/compact", { method: "POST" }),
  listDocuments: (collection: string, params?: Record<string, string | number | boolean | undefined>) =>
    request<DocumentPage>(`/data/${collection}${queryString(params)}`),
  createDocument: (collection: string, document: Document) =>
    request<Document>(`/data/${collection}`, {
      method: "POST",
      body: JSON.stringify(document),
    }),
  replaceDocument: (collection: string, id: string, document: Document) =>
    request<Document>(`/data/${collection}/${id}`, {
      method: "PUT",
      body: JSON.stringify(document),
    }),
  deleteDocument: (collection: string, id: string) =>
    request<void>(`/data/${collection}/${id}`, { method: "DELETE" }),
};
