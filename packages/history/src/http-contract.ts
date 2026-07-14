import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";

import { createLocalHttpWireSchemas } from "./http-wire.ts";

export * from "./http-wire.ts";

type OpenApiZodSchema = z.ZodType & {
  readonly openapi: (refId: string) => z.ZodType;
};

const decorateOpenApi = <T extends z.ZodType>(schema: T, refId: string): T =>
  (schema as OpenApiZodSchema).openapi(refId) as T;

const contractSchemas = createLocalHttpWireSchemas(z, decorateOpenApi);
const {
  localHttpMetaSchema: metaSchema,
  localHttpErrorSchema: errorSchema,
  saveQuerySchema,
  historyQuerySchema,
  observationsQuerySchema,
  diffQuerySchema,
  searchQuerySchema,
  checkpointBodySchema,
  exportQuerySchema,
  restoreBodySchema,
  historyResultSchema,
  rawObservationHistoryResultSchema,
  saveStateResultSchema,
  diffCommitsResultSchema,
  searchResultSchema,
  watcherStatusSchema,
  observeSaveResultSchema,
  restoreResultSchema,
} = contractSchemas;

function jsonSuccess(schema: z.ZodType) {
  return {
    description: "Successful response.",
    content: { "application/json": { schema } },
  } as const;
}
const invalidRequest = {
  description: "The request is invalid.",
  content: { "application/json": { schema: errorSchema } },
} as const;
const unauthorized = {
  description: "Bearer authentication failed.",
  content: { "application/json": { schema: errorSchema } },
} as const;
const internalError = {
  description: "The request failed without exposing internal details.",
  content: { "application/json": { schema: errorSchema } },
} as const;

const baseResponses = {
  400: invalidRequest,
  401: unauthorized,
  408: internalError,
  500: internalError,
} as const;

export const localHttpRoutes = {
  meta: createRoute({
    method: "get",
    path: "/api/v1/meta",
    summary: "Get Local History API compatibility metadata",
    responses: {
      200: jsonSuccess(metaSchema),
      401: unauthorized,
      500: internalError,
    },
  }),
  watcher: createRoute({
    method: "get",
    path: "/api/v1/watcher",
    summary: "Get the current watcher status",
    responses: {
      200: jsonSuccess(watcherStatusSchema),
      401: unauthorized,
      500: internalError,
    },
  }),
  save: createRoute({
    method: "get",
    path: "/api/v1/save",
    summary: "Get the latest or commit-selected Save State",
    request: { query: saveQuerySchema },
    responses: {
      200: jsonSuccess(saveStateResultSchema),
      404: internalError,
      ...baseResponses,
    },
  }),
  history: createRoute({
    method: "get",
    path: "/api/v1/history",
    summary: "Query Semantic Event history",
    request: { query: historyQuerySchema },
    responses: {
      200: jsonSuccess(historyResultSchema),
      503: internalError,
      ...baseResponses,
    },
  }),
  observations: createRoute({
    method: "get",
    path: "/api/v1/observations",
    summary: "Query Raw Save Observations",
    request: { query: observationsQuerySchema },
    responses: {
      200: jsonSuccess(rawObservationHistoryResultSchema),
      503: internalError,
      ...baseResponses,
    },
  }),
  diff: createRoute({
    method: "get",
    path: "/api/v1/diff",
    summary: "Diff two observation commits",
    request: { query: diffQuerySchema },
    responses: {
      200: jsonSuccess(diffCommitsResultSchema),
      404: internalError,
      503: internalError,
      ...baseResponses,
    },
  }),
  search: createRoute({
    method: "get",
    path: "/api/v1/search",
    summary: "Search Semantic Events",
    request: { query: searchQuerySchema },
    responses: {
      200: jsonSuccess(searchResultSchema),
      503: internalError,
      ...baseResponses,
    },
  }),
  checkpoints: createRoute({
    method: "post",
    path: "/api/v1/checkpoints",
    summary: "Create a manual checkpoint",
    request: {
      body: {
        required: true,
        content: { "application/json": { schema: checkpointBodySchema } },
      },
    },
    responses: {
      200: jsonSuccess(observeSaveResultSchema),
      409: internalError,
      413: invalidRequest,
      415: invalidRequest,
      422: invalidRequest,
      503: internalError,
      ...baseResponses,
    },
  }),
  export: createRoute({
    method: "get",
    path: "/api/v1/export",
    summary: "Export an exact committed Encoded Save",
    request: { query: exportQuerySchema },
    responses: {
      200: {
        description: "Exact committed Encoded Save bytes.",
        headers: {
          "Content-Disposition": { schema: { type: "string" } },
          ETag: { schema: { type: "string" } },
        },
        content: {
          "application/octet-stream": {
            schema: z.string().openapi({ format: "binary" }),
          },
        },
      },
      404: internalError,
      ...baseResponses,
    },
  }),
  restoreInPlace: createRoute({
    method: "post",
    path: "/api/v1/restores/in-place",
    summary: "Restore a commit to the Watched Save",
    request: {
      body: {
        required: true,
        content: { "application/json": { schema: restoreBodySchema } },
      },
    },
    responses: {
      200: jsonSuccess(restoreResultSchema),
      404: internalError,
      409: internalError,
      413: invalidRequest,
      415: invalidRequest,
      ...baseResponses,
    },
  }),
} as const;

export type LocalHttpOpenApiDocument = ReturnType<
  OpenAPIHono<Record<string, never>>["getOpenAPI31Document"]
>;

export function createLocalHttpOpenApiDocument(): LocalHttpOpenApiDocument {
  const app = new OpenAPIHono<Record<string, never>>();
  const documentConfig = {
    info: {
      title: "Silksong Git Local History API",
      version: "1.0.0",
    },
    openapi: "3.1.0" as const,
    security: [{ bearerAuth: [] }],
  };

  app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
    type: "http",
    scheme: "bearer",
  });

  for (const route of Object.values(localHttpRoutes)) {
    app.openAPIRegistry.registerPath(route);
  }

  return app.getOpenAPI31Document(documentConfig, {
    unionPreferredType: "oneOf",
  });
}
