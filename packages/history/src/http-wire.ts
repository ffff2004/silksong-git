import { z } from "zod";

export const localHttpApiName = "silksong-git-local-history" as const;

export const localHttpApiVersion = { major: 1, minor: 1 } as const;

export const localHttpCapabilities = [
  "watcherStatus",
  "saveState",
  "history",
  "rawObservations",
  "diff",
  "search",
  "checkpoint",
  "exportEncodedSave",
  "restoreInPlace",
] as const;

export type LocalHttpCapability = (typeof localHttpCapabilities)[number];

export const localHttpErrorCodes = [
  "invalid_request",
  "unauthorized",
  "route_not_found",
  "commit_not_found",
  "observation_not_found",
  "method_not_allowed",
  "request_timeout",
  "repository_busy",
  "restore_conflict",
  "payload_too_large",
  "unsupported_media_type",
  "save_decode_failed",
  "restore_configuration_invalid",
  "restore_backup_failed",
  "restore_write_failed",
  "restore_verification_failed",
  "internal_error",
  "watched_save_unavailable",
  "read_model_unavailable",
] as const;

export type LocalHttpErrorCode = (typeof localHttpErrorCodes)[number];

const apiVersionSchema = z.object({
  major: z.number().int().nonnegative(),
  minor: z.number().int().nonnegative(),
});

const apiIdentitySchema = z.object({
  name: z.literal(localHttpApiName),
  version: apiVersionSchema,
});

const capabilitySchema = z.string().min(1);

export const localHttpMetaSchema = z.object({
  api: apiIdentitySchema,
  repoPath: z.string(),
  watchedSavePath: z.string(),
  capabilities: z.array(capabilitySchema).readonly(),
});

export type LocalHttpMeta = z.infer<typeof localHttpMetaSchema>;

export const localHttpErrorSchema = z.object({
  error: z.object({
    code: z.enum(localHttpErrorCodes),
    message: z.string(),
  }),
});

export type LocalHttpError = z.infer<typeof localHttpErrorSchema>;
