import type {
  LocalHttpCheckpointResult,
  LocalHttpDiffResult,
  LocalHttpErrorCode,
  LocalHttpHistoryResult,
  LocalHttpMeta,
  LocalHttpObservationHistoryResult,
  LocalHttpRestoreResult,
  LocalHttpSaveState,
  LocalHttpSearchResult,
  LocalHttpWatcherStatus,
} from "@silksong-git/history/http-wire";
import {
  diffCommitsResultSchema,
  historyResultSchema,
  localHttpApiVersion,
  localHttpCapabilities,
  localHttpErrorSchema,
  localHttpMetaSchema,
  observeSaveResultSchema,
  rawObservationHistoryResultSchema,
  restoreResultSchema,
  saveStateResultSchema,
  searchResultSchema,
  watcherStatusSchema,
} from "@silksong-git/history/http-wire";
import { createLocalHistoryUrl } from "./url-utils.ts";

export type LocalHistoryClientErrorKind =
  | "api"
  | "incompatible"
  | "protocol"
  | "unauthorized"
  | "unavailable";

export class LocalHistoryClientError extends Error {
  readonly code: LocalHttpErrorCode | undefined;
  readonly kind: LocalHistoryClientErrorKind;
  readonly status: number | undefined;

  constructor(
    input: {
      readonly code?: LocalHttpErrorCode;
      readonly kind: LocalHistoryClientErrorKind;
      readonly message: string;
      readonly status?: number;
    },
    options?: ErrorOptions,
  ) {
    super(input.message, options);
    this.name = "LocalHistoryClientError";
    this.code = input.code;
    this.kind = input.kind;
    this.status = input.status;
  }
}

export interface LocalHistoryClient {
  readonly getMeta: () => Promise<LocalHttpMeta>;
  readonly getSave: (selector: SaveSelector) => Promise<LocalHttpSaveState>;
  readonly getWatcher: () => Promise<LocalHttpWatcherStatus>;
  readonly getHistory: (
    query?: HistoryQuery,
  ) => Promise<LocalHttpHistoryResult>;
  readonly getObservations: (
    query?: ObservationQuery,
  ) => Promise<LocalHttpObservationHistoryResult>;
  readonly getDiff: (input: DiffQuery) => Promise<LocalHttpDiffResult>;
  readonly search: (query: SearchQuery) => Promise<LocalHttpSearchResult>;
  readonly checkpoint: (
    input?: CheckpointInput,
  ) => Promise<LocalHttpCheckpointResult>;
  readonly exportSave: (commitRef: string) => Promise<LocalEncodedSaveDownload>;
  readonly restoreInPlace: (
    input: RestoreInput,
  ) => Promise<LocalHttpRestoreResult>;
}

type SaveSelector =
  | { readonly kind: "latest" }
  | { readonly kind: "commit"; readonly commitRef: string };

interface HistoryQuery {
  readonly includeFiltered?: boolean;
  readonly limit?: number;
  readonly cursor?: string;
  readonly order?: "asc" | "desc";
}

interface ObservationQuery {
  readonly limit?: number;
  readonly cursor?: string;
  readonly order?: "asc" | "desc";
}

interface DiffQuery {
  readonly from: string;
  readonly to: string;
  readonly includeFiltered?: boolean;
}

interface SearchQuery extends HistoryQuery {
  readonly itemId?: string;
  readonly label?: string;
  readonly type?: string;
  readonly statusTo?: "accepted" | "done" | "missing" | "unknown";
  readonly eventType?: string;
  readonly direction?: "neutral" | "progression" | "regression";
  readonly text?: string;
}

interface CheckpointInput {
  readonly message?: string;
  readonly allowUnchanged?: boolean;
}

interface RestoreInput {
  readonly commitRef: string;
  readonly expectedCurrent:
    | { readonly status: "present"; readonly encodedSha256: string }
    | { readonly status: "missing" };
}

interface LocalEncodedSaveDownload {
  readonly bytes: ArrayBuffer;
  readonly fileName: string;
  readonly etag: string | undefined;
}

export interface CreateLocalHistoryClientInput {
  readonly endpoint: string;
  readonly fetch?: typeof fetch;
  readonly token: string;
}

export function assertLocalHistoryCompatibility(meta: LocalHttpMeta): void {
  if (
    meta.api.version.major !== localHttpApiVersion.major
    || meta.api.version.minor < localHttpApiVersion.minor
  ) {
    throw new LocalHistoryClientError({
      kind: "incompatible",
      message: "Local History API version is not supported.",
    });
  }

  const missingCapabilities = localHttpCapabilities.filter(
    (capability) => !meta.capabilities.includes(capability),
  );
  if (missingCapabilities.length > 0) {
    throw new LocalHistoryClientError({
      kind: "incompatible",
      message: `Local History is missing capabilities: ${missingCapabilities.join(", ")}.`,
    });
  }
}

export function createLocalHistoryClient(
  input: CreateLocalHistoryClientInput,
): LocalHistoryClient {
  const request = input.fetch ?? globalThis.fetch;
  const metaUrlObject = new URL("/api/v1/meta", input.endpoint);
  const metaUrl = metaUrlObject.href;
  const saveUrlObject = new URL("/api/v1/save", input.endpoint);

  const requestResponse = async (
    url: string,
    init?: RequestInit,
  ): Promise<Response> => {
    try {
      const response = await request(url, {
        ...init,
        headers: createAuthorizationHeaders(input.token, init?.headers),
      });

      if (response.status === 401) {
        throw new LocalHistoryClientError({
          kind: "unauthorized",
          message: "Local History authentication failed.",
          status: response.status,
        });
      }

      if (!response.ok) {
        throw await createApiError(response);
      }

      return response;
    } catch (error) {
      if (error instanceof LocalHistoryClientError) {
        throw error;
      }

      throw new LocalHistoryClientError(
        {
          kind: "unavailable",
          message: "Unable to reach the Local History API.",
        },
        { cause: error },
      );
    }
  };

  const getJson = async <T>(
    url: string,
    schema: { safeParse: (payload: unknown) => { success: boolean; data?: T } },
    invalidMessage: string,
  ): Promise<T> => {
    const response = await requestResponse(url);

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new LocalHistoryClientError(
        {
          kind: "protocol",
          message: "Local History returned invalid JSON.",
          status: response.status,
        },
        { cause: error },
      );
    }

    const parsed = schema.safeParse(payload);
    if (!parsed.success || parsed.data === undefined) {
      throw new LocalHistoryClientError(
        {
          kind: "protocol",
          message: invalidMessage,
          status: response.status,
        },
        { cause: parsed },
      );
    }

    return parsed.data;
  };

  return {
    getMeta: async () =>
      await getJson(
        metaUrl,
        localHttpMetaSchema,
        "Local History returned an invalid metadata response.",
      ),
    async getSave(selector) {
      const url = new URL(saveUrlObject);
      if (selector.kind === "latest") {
        url.searchParams.set("selector", "latest");
      } else {
        url.searchParams.set("commit", selector.commitRef);
      }

      return await getJson(
        url.href,
        saveStateResultSchema,
        "Local History returned an invalid save response.",
      );
    },
    getWatcher: async () =>
      await getJson(
        createLocalHistoryUrl(input.endpoint, "/api/v1/watcher"),
        watcherStatusSchema,
        "Local History returned an invalid watcher response.",
      ),
    getHistory: async (query = {}) =>
      await getJson(
        createQueryUrl("/api/v1/history", input.endpoint, query),
        historyResultSchema,
        "Local History returned an invalid history response.",
      ),
    getObservations: async (query = {}) =>
      await getJson(
        createQueryUrl("/api/v1/observations", input.endpoint, query),
        rawObservationHistoryResultSchema,
        "Local History returned an invalid observations response.",
      ),
    getDiff: async (query) =>
      await getJson(
        createQueryUrl("/api/v1/diff", input.endpoint, query),
        diffCommitsResultSchema,
        "Local History returned an invalid diff response.",
      ),
    search: async (query) =>
      await getJson(
        createQueryUrl("/api/v1/search", input.endpoint, query),
        searchResultSchema,
        "Local History returned an invalid search response.",
      ),
    async checkpoint(body = {}) {
      const response = await requestResponse(
        createLocalHistoryUrl(input.endpoint, "/api/v1/checkpoints"),
        {
          body: JSON.stringify(body),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        },
      );
      return await parseJsonResponse(
        response,
        observeSaveResultSchema,
        "Local History returned an invalid checkpoint response.",
      );
    },
    async exportSave(commitRef) {
      const url = new URL("/api/v1/export", input.endpoint);
      url.searchParams.set("commit", commitRef);
      const response = await requestResponse(url.href);
      return {
        bytes: await response.arrayBuffer(),
        etag: response.headers.get("ETag") ?? undefined,
        fileName: parseFileName(response.headers.get("Content-Disposition")),
      };
    },
    async restoreInPlace(body) {
      const response = await requestResponse(
        createLocalHistoryUrl(input.endpoint, "/api/v1/restores/in-place"),
        {
          body: JSON.stringify({
            confirmation: "restore-watched-save",
            ...body,
          }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        },
      );
      return await parseJsonResponse(
        response,
        restoreResultSchema,
        "Local History returned an invalid restore response.",
      );
    },
  };
}

function createQueryUrl(path: string, endpoint: string, query: object): string {
  const url = new URL(path, endpoint);
  for (const [key, value] of Object.entries(query as Record<string, unknown>)) {
    if (value !== undefined) {
      url.searchParams.set(key, toQueryValue(value));
    }
  }

  return url.href;
}

function createAuthorizationHeaders(
  token: string,
  headers: HeadersInit | undefined,
): Headers {
  const result = new Headers(headers);
  result.set("Authorization", `Bearer ${token}`);
  return result;
}

function toQueryValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value.toString();
  }

  throw new TypeError("Local History query values must be primitive.");
}

async function parseJsonResponse<T>(
  response: Response,
  schema: { safeParse: (payload: unknown) => { success: boolean; data?: T } },
  invalidMessage: string,
): Promise<T> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new LocalHistoryClientError(
      { kind: "protocol", message: "Local History returned invalid JSON." },
      { cause: error },
    );
  }

  const parsed = schema.safeParse(payload);
  if (!parsed.success || parsed.data === undefined) {
    throw new LocalHistoryClientError(
      { kind: "protocol", message: invalidMessage },
      { cause: parsed },
    );
  }

  return parsed.data;
}

function parseFileName(disposition: string | null): string {
  const match = /filename="(?<name>[^"]+)"/u.exec(disposition ?? "");
  return match?.groups?.["name"] ?? "save.dat";
}

async function createApiError(
  response: Response,
): Promise<LocalHistoryClientError> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    return new LocalHistoryClientError(
      {
        kind: "protocol",
        message: "Local History returned an invalid error response.",
        status: response.status,
      },
      { cause: error },
    );
  }

  const parsed = localHttpErrorSchema.safeParse(payload);
  if (!parsed.success) {
    return new LocalHistoryClientError(
      {
        kind: "protocol",
        message: "Local History returned an invalid error response.",
        status: response.status,
      },
      { cause: parsed.error },
    );
  }

  return new LocalHistoryClientError({
    code: parsed.data.error.code,
    kind: "api",
    message: parsed.data.error.message,
    status: response.status,
  });
}
