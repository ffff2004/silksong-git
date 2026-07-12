import { createHash, timingSafeEqual } from "node:crypto";

import { OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { timeout } from "hono/timeout";

import { readProjectConfig } from "./config.ts";
import {
  InvalidCommitRefError,
  InvalidReadModelCursorError,
  InvalidRestoreBackupDirectoryError,
  ObservationNotFoundError,
  ReadModelUnavailableError,
  RestoreBackupFailedError,
  RestoreConflictError,
  RestoreWriteFailedError,
  RestoreWriteVerificationError,
  SaveHistoryRepositoryBusyError,
} from "./errors.ts";
import {
  diffCommits,
  observeSave,
  queryHistory,
  queryRawObservations,
  searchSemanticEvents,
} from "./history-interface.ts";
import type { LocalHttpErrorCode } from "./http-contract.ts";
import { localHttpCapabilities, localHttpRoutes } from "./http-contract.ts";
import { restoreEncodedSave } from "./restore.ts";
import { getSaveState, readEncodedSave } from "./save-state.ts";
import type { LocalHistoryWatcherStatus } from "./types.ts";

const authorizationPattern = /^Bearer (?<token>[\w\-]+)$/v;

function validationHook(
  result: { readonly success: boolean },
  c: Context,
): Response | undefined {
  if (!result.success) {
    return invalidRequest(c);
  }

  return undefined;
}

export interface CreateLocalHttpAppInput {
  readonly repoPath: string;
  readonly token: string;
  readonly getWatcherStatus: () => LocalHistoryWatcherStatus;
  readonly onRequestError?: (error: HttpRequestErrorEvent) => void;
}

interface HttpRequestErrorEvent {
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly code: LocalHttpErrorCode;
  readonly message: string;
}

// The return type is intentionally inferred from the real Hono registration chain so LocalHttpApp
// cannot drift from the routes served by this factory.
// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
function buildLocalHttpApp(input: CreateLocalHttpAppInput) {
  const app = new OpenAPIHono<Record<string, never>>({
    defaultHook: validationHook,
  });

  app.use(
    "/api/v1/*",
    cors({
      origin: "*",
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["Authorization", "Content-Type"],
      exposeHeaders: ["Content-Disposition", "ETag", "Retry-After"],
      credentials: false,
      maxAge: 600,
    }),
  );
  app.use("/api/v1/*", async (c, next) => {
    c.header("Cache-Control", "no-store");

    if (!isAuthorized(c.req.header("Authorization"), input.token)) {
      return errorResponse(c, 401, "unauthorized", "Authentication required.");
    }

    await next();

    return undefined;
  });
  app.use("/api/v1/*", timeout(10_000, new HTTPException(408)));
  app.use("/api/v1/checkpoints", requireJsonBody);
  app.use("/api/v1/restores/in-place", requireJsonBody);
  app.use(
    "/api/v1/checkpoints",
    bodyLimit({
      maxSize: 16 * 1024,
      onError: (c) =>
        errorResponse(
          c,
          413,
          "payload_too_large",
          "Request body is too large.",
        ),
    }),
  );
  app.use(
    "/api/v1/restores/in-place",
    bodyLimit({
      maxSize: 16 * 1024,
      onError: (c) =>
        errorResponse(
          c,
          413,
          "payload_too_large",
          "Request body is too large.",
        ),
    }),
  );

  const routedApp = app
    .openapi(localHttpRoutes.meta, async (c) => {
      const config = await readProjectConfig(input.repoPath);

      return c.json(
        {
          api: {
            name: "silksong-git-local-history" as const,
            version: { major: 1 as const, minor: 0 as const },
          },
          repoPath: input.repoPath,
          watchedSavePath: config.watchedSavePath,
          capabilities: localHttpCapabilities,
        },
        200,
      );
    })
    .openapi(localHttpRoutes.watcher, (c) =>
      c.json(input.getWatcherStatus(), 200),
    )
    .openapi(localHttpRoutes.save, async (c) => {
      const query = c.req.valid("query");

      const result = await getSaveState({
        repoPath: input.repoPath,
        selector:
          query.commit === undefined
            ? { kind: "latest" }
            : { kind: "commit", commitRef: query.commit },
      });

      return c.json(result, 200);
    })
    .openapi(localHttpRoutes.history, async (c) => {
      const query = c.req.valid("query");
      const result = await queryHistory({ repoPath: input.repoPath, ...query });

      return c.json(result, 200);
    })
    .openapi(localHttpRoutes.observations, async (c) => {
      const query = c.req.valid("query");
      const result = await queryRawObservations({
        repoPath: input.repoPath,
        ...query,
      });

      return c.json(result, 200);
    })
    .openapi(localHttpRoutes.diff, async (c) => {
      const query = c.req.valid("query");

      const result = await diffCommits({
        repoPath: input.repoPath,
        fromRef: query.from,
        toRef: query.to,
        includeFiltered: query.includeFiltered,
      });

      return c.json(result, 200);
    })
    .openapi(localHttpRoutes.search, async (c) => {
      const { includeFiltered, limit, order, cursor, ...query } =
        c.req.valid("query");

      const result = await searchSemanticEvents({
        repoPath: input.repoPath,
        query,
        includeFiltered,
        limit,
        cursor,
        order,
      });

      return c.json(result, 200);
    })
    .openapi(localHttpRoutes.checkpoints, async (c) => {
      const result = await observeSave({
        repoPath: input.repoPath,
        trigger: "manualCheckpoint",
        ...c.req.valid("json"),
      });

      if (result.status === "watcherError") {
        if (result.error.reason === "decodeFailure") {
          return c.json(
            {
              error: {
                code: "save_decode_failed" as const,
                message: "The Watched Save could not be decoded.",
              },
            },
            422,
          );
        }

        input.onRequestError?.({
          method: c.req.method,
          path: c.req.path,
          status: 503,
          code: "watched_save_unavailable",
          message: "The Watched Save is unavailable.",
        });

        return c.json(
          {
            error: {
              code: "watched_save_unavailable" as const,
              message: "The Watched Save is unavailable.",
            },
          },
          503,
        );
      }

      return c.json(result, 200);
    })
    .openapi(localHttpRoutes.export, async (c) => {
      const result = await readEncodedSave({
        repoPath: input.repoPath,
        commitRef: c.req.valid("query").commit,
      });
      const disposition = createContentDisposition(result.suggestedFileName);

      return new Response(result.encodedBytes, {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": result.encodedBytes.byteLength.toString(),
          "Content-Disposition": disposition,
          ETag: `"sha256-${result.encodedSha256}"`,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Expose-Headers":
            "Content-Disposition,ETag,Retry-After",
        },
      });
    })
    .openapi(localHttpRoutes.restoreInPlace, async (c) => {
      const request = c.req.valid("json");

      const result = await restoreEncodedSave({
        repoPath: input.repoPath,
        commitRef: request.commitRef,
        target: {
          kind: "inPlace",
          confirmation: request.confirmation,
          expectedCurrent: request.expectedCurrent,
        },
      });

      return c.json(result, 200);
    });

  for (const route of Object.values(localHttpRoutes)) {
    routedApp.all(route.path, (c) =>
      errorResponse(c, 405, "method_not_allowed", "Method not allowed."),
    );
  }

  routedApp.notFound((c) =>
    errorResponse(c, 404, "route_not_found", "Route not found."),
  );
  routedApp.onError((error, c) => {
    const mapped = mapError(error);

    if (mapped.code === "repository_busy") {
      c.header("Retry-After", "1");
    }

    if (mapped.status >= 500) {
      input.onRequestError?.({
        method: c.req.method,
        path: c.req.path,
        ...mapped,
      });
    }

    return errorResponse(c, mapped.status, mapped.code, mapped.message);
  });

  return routedApp;
}

export type LocalHttpApp = ReturnType<typeof buildLocalHttpApp>;

export const createLocalHttpApp: (
  input: CreateLocalHttpAppInput,
) => LocalHttpApp = buildLocalHttpApp;

async function requireJsonBody(c: Context, next: () => Promise<void>) {
  if (c.req.method !== "POST") {
    await next();

    return;
  }

  const contentType = c.req
    .header("Content-Type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();

  if (contentType !== "application/json") {
    return errorResponse(
      c,
      415,
      "unsupported_media_type",
      "Content-Type must be application/json.",
    );
  }

  await next();

  // Keep the explicit undefined for TypeScript's noImplicitReturns middleware check.

  return undefined;
}

function invalidRequest(c: Parameters<typeof errorResponse>[0]) {
  return errorResponse(c, 400, "invalid_request", "Invalid request.");
}

function errorResponse(
  c: { json: (body: object, status: number) => Response },
  status: number,
  code: LocalHttpErrorCode,
  message: string,
) {
  return c.json({ error: { code, message } }, status);
}

function mapError(error: unknown): {
  readonly status: number;
  readonly code: LocalHttpErrorCode;
  readonly message: string;
} {
  if (error instanceof InvalidCommitRefError) {
    return {
      status: 404,
      code: "commit_not_found",
      message: "Commit not found.",
    };
  }
  if (error instanceof InvalidReadModelCursorError) {
    return {
      status: 400,
      code: "invalid_request",
      message: "Invalid request.",
    };
  }
  if (error instanceof ObservationNotFoundError) {
    return {
      status: 404,
      code: "observation_not_found",
      message: "Raw Save Observation not found.",
    };
  }
  if (error instanceof HTTPException && error.status === 408) {
    return {
      status: 408,
      code: "request_timeout",
      message: "Request timed out.",
    };
  }
  if (error instanceof SaveHistoryRepositoryBusyError) {
    return {
      status: 409,
      code: "repository_busy",
      message: "Save History Repository is busy.",
    };
  }
  if (error instanceof RestoreConflictError) {
    return {
      status: 409,
      code: "restore_conflict",
      message: "The Watched Save changed after confirmation.",
    };
  }
  if (error instanceof ReadModelUnavailableError) {
    return {
      status: 503,
      code: "read_model_unavailable",
      message: "Semantic Read Model is unavailable.",
    };
  }
  if (error instanceof InvalidRestoreBackupDirectoryError) {
    return {
      status: 500,
      code: "restore_configuration_invalid",
      message: "Restore configuration is invalid.",
    };
  }
  if (error instanceof RestoreBackupFailedError) {
    return {
      status: 500,
      code: "restore_backup_failed",
      message: "Restore backup failed.",
    };
  }
  if (error instanceof RestoreWriteFailedError) {
    return {
      status: 500,
      code: "restore_write_failed",
      message: "Restore write failed.",
    };
  }
  if (error instanceof RestoreWriteVerificationError) {
    return {
      status: 500,
      code: "restore_verification_failed",
      message: "Restore verification failed.",
    };
  }

  return {
    status: 500,
    code: "internal_error",
    message: "Internal server error.",
  };
}

function createContentDisposition(fileName: string) {
  // The fallback intentionally discards non-ASCII code points; filename* preserves Unicode.
  // eslint-disable-next-line @typescript-eslint/no-misused-spread
  const asciiCandidate = [...fileName.normalize("NFKD")]
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;

      return codePoint >= 32 && codePoint <= 126;
    })
    .join("")
    .replaceAll(/["\\]/gv, "_");
  const ascii = asciiCandidate === "" ? "save.dat" : asciiCandidate;

  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

function isAuthorized(authorization: string | undefined, token: string) {
  const match = authorizationPattern.exec(authorization ?? "");

  if (match?.groups?.["token"] === undefined) {
    return false;
  }

  const actual = createHash("sha256").update(match.groups["token"]).digest();
  const expected = createHash("sha256").update(token).digest();

  return timingSafeEqual(actual, expected);
}
