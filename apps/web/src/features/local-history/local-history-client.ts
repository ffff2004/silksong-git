import type {
  LocalHttpErrorCode,
  LocalHttpMeta,
} from "@silksong-git/history/http-wire";
import {
  localHttpApiVersion,
  localHttpCapabilities,
  localHttpErrorSchema,
  localHttpMetaSchema,
} from "@silksong-git/history/http-wire";

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

  return {
    async getMeta() {
      let response: Response;
      try {
        response = await request(metaUrl, {
          headers: { Authorization: `Bearer ${input.token}` },
        });
      } catch (error) {
        throw new LocalHistoryClientError(
          {
            kind: "unavailable",
            message: "Unable to reach the Local History API.",
          },
          { cause: error },
        );
      }

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

      const parsed = localHttpMetaSchema.safeParse(payload);
      if (!parsed.success) {
        throw new LocalHistoryClientError(
          {
            kind: "protocol",
            message: "Local History returned an invalid metadata response.",
            status: response.status,
          },
          { cause: parsed.error },
        );
      }

      return parsed.data;
    },
  };
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
