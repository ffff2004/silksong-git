import type {
  SemanticEventDirection,
  SemanticSnapshotItemStatus,
} from "@silksong-git/core";
import type { Hono, Schema } from "hono";

import type {
  DiffCommitsResult,
  GetSaveStateResult,
  HistoryResult,
  LocalHistoryWatcherStatus,
  ObserveSaveResult,
  RawObservationHistoryResult,
  RestoreEncodedSaveResult,
  SearchSemanticEventsResult,
} from "./types.ts";

export interface LocalHttpMeta {
  readonly api: {
    readonly name: "silksong-git-local-history";
    readonly version: { readonly major: 1; readonly minor: 0 };
  };
  readonly repoPath: string;
  readonly watchedSavePath: string;
  readonly capabilities: readonly LocalHttpCapability[];
}

export type LocalHttpCapability =
  | "watcherStatus"
  | "saveState"
  | "history"
  | "rawObservations"
  | "diff"
  | "search"
  | "checkpoint"
  | "exportEncodedSave"
  | "restoreInPlace";

interface JsonEndpoint<Input, Output> {
  readonly input: Input;
  readonly output: Output;
  readonly outputFormat: "json";
  readonly status: number;
}

interface BinaryEndpoint<Input> {
  readonly input: Input;
  readonly output: unknown;
  readonly outputFormat: "body";
  readonly status: number;
}

interface PaginationQuery {
  readonly limit?: string;
  readonly cursor?: string;
  readonly order?: "asc" | "desc";
}

interface LocalHttpRoutes {
  "/api/v1/meta": {
    readonly $get: JsonEndpoint<Record<string, never>, LocalHttpMeta>;
  };
  "/api/v1/watcher": {
    readonly $get: JsonEndpoint<
      Record<string, never>,
      LocalHistoryWatcherStatus
    >;
  };
  "/api/v1/save": {
    readonly $get: JsonEndpoint<
      {
        readonly query: {
          readonly selector?: "latest";
          readonly commit?: string;
        };
      },
      GetSaveStateResult
    >;
  };
  "/api/v1/history": {
    readonly $get: JsonEndpoint<
      {
        readonly query: PaginationQuery & {
          readonly includeFiltered?: "true" | "false";
        };
      },
      HistoryResult
    >;
  };
  "/api/v1/observations": {
    readonly $get: JsonEndpoint<
      { readonly query: PaginationQuery },
      RawObservationHistoryResult
    >;
  };
  "/api/v1/diff": {
    readonly $get: JsonEndpoint<
      {
        readonly query: {
          readonly from: string;
          readonly to: string;
          readonly includeFiltered?: "true" | "false";
        };
      },
      DiffCommitsResult
    >;
  };
  "/api/v1/search": {
    readonly $get: JsonEndpoint<
      {
        readonly query: PaginationQuery & {
          readonly includeFiltered?: "true" | "false";
          readonly itemId?: string;
          readonly label?: string;
          readonly type?: string;
          readonly statusTo?: SemanticSnapshotItemStatus;
          readonly eventType?: string;
          readonly direction?: SemanticEventDirection;
          readonly text?: string;
        };
      },
      SearchSemanticEventsResult
    >;
  };
  "/api/v1/checkpoints": {
    readonly $post: JsonEndpoint<
      {
        readonly json: {
          readonly message?: string;
          readonly allowUnchanged?: boolean;
        };
      },
      ObserveSaveResult
    >;
  };
  "/api/v1/export": {
    readonly $get: BinaryEndpoint<{
      readonly query: { readonly commit: string };
    }>;
  };
  "/api/v1/restores/in-place": {
    readonly $post: JsonEndpoint<
      {
        readonly json: {
          readonly commitRef: string;
          readonly confirmation: "restore-watched-save";
          readonly expectedCurrent:
            | { readonly status: "present"; readonly encodedSha256: string }
            | { readonly status: "missing" };
        };
      },
      RestoreEncodedSaveResult
    >;
  };
}

type LocalHttpSchema = Schema & LocalHttpRoutes;

export type LocalHttpApp = Hono<Record<string, never>, LocalHttpSchema>;
