import type { ObserveSaveResult, ProjectConfig } from "@silksong-git/history";

export interface OpenRepoSessionInput {
  readonly repoPath: string;
  readonly port?: number;
  readonly onEvent?: (event: RepoSessionEvent) => void;
  // System-boundary adapters used by behavior tests and non-Node hosts.
  readonly runtime?: RepoSessionRuntimeAdapters;
}

export interface RepoSession {
  readonly repoPath: string;
  readonly http: {
    readonly endpoint: string;
    readonly token: string;
  };
  readonly getWatcherStatus: () => RepoSessionWatcherStatus;
  startWatching: () => Promise<void>;
  stopWatching: () => Promise<void>;
  stop: () => Promise<void>;
}

export interface RepoSessionRuntimeAdapters {
  readonly fileStabilityProbe?: FileStabilityProbe;
  readonly now?: () => Date;
  readonly watchEventSource?: WatchEventSource;
  readonly watchScheduler?: WatchScheduler;
}

interface RepoSessionWatcherStatusBase {
  readonly observationRevision: number;
  readonly repoPath: string;
  readonly lastObservation?: RepoSessionObservationSummary;
}

export type RepoSessionWatcherStatus =
  | (RepoSessionWatcherStatusBase & {
      readonly status: "inactive" | "starting";
    })
  | (RepoSessionWatcherStatusBase & {
      readonly status: "running" | "stopping";
      readonly activity: "idle" | "pending" | "observing";
      readonly startedAt: string;
      readonly watchedSavePath: string;
      readonly capturePolicy: ProjectConfig["capturePolicy"];
    });

export type RepoSessionObservationSummary =
  | {
      readonly cause: "startup" | "change" | "deferred";
      readonly completedAt: string;
      readonly status: "committed";
      readonly commit: {
        readonly ref: string;
        readonly shortRef: string;
        readonly committedAt: string;
      };
      readonly eventCount: number;
      readonly semanticStatus: "updated" | "notAvailable";
    }
  | {
      readonly cause: "startup" | "change" | "deferred";
      readonly completedAt: string;
      readonly status: "skipped";
      readonly reason: "unchanged" | "minimumCommitInterval";
      readonly nextAllowedAt?: string;
    }
  | {
      readonly cause: "startup" | "change" | "deferred";
      readonly completedAt: string;
      readonly status: "watcherError";
      readonly error: {
        readonly message: string;
        readonly reason: "decodeFailure" | "readFailure" | "stabilityTimeout";
      };
    };

export type RepoSessionEvent =
  | {
      readonly type: "started";
      readonly repoPath: string;
      readonly watchedSavePath: string;
      readonly capturePolicy: ProjectConfig["capturePolicy"];
    }
  | {
      readonly type: "httpRequestError";
      readonly repoPath: string;
      readonly error: {
        readonly method: string;
        readonly path: string;
        readonly status: number;
        readonly code: string;
        readonly message: string;
      };
    }
  | {
      /** Safe lifecycle signal for a mutation admitted through Local HTTP. */
      readonly type: "mutationActivity";
      readonly repoPath: string;
      readonly mutation: "manualCheckpoint" | "inPlaceRestore";
      readonly status: "started" | "finished";
    }
  | {
      readonly type: "observation";
      readonly repoPath: string;
      readonly cause: "startup" | "change" | "deferred";
      readonly result: ObserveSaveResult;
    }
  | {
      readonly type: "fatalError";
      readonly repoPath: string;
      readonly error: RepoSessionFatalError;
    }
  | {
      readonly type: "stopping";
      readonly repoPath: string;
    }
  | {
      readonly type: "stopped";
      readonly repoPath: string;
    };

export interface RepoSessionFatalError {
  readonly message: string;
  readonly reason: "httpServerFailure" | "watchBackendFailure";
}

export interface WatchEventSource {
  start: (
    input: WatchEventSourceStartInput,
  ) => WatchEventSubscription | Promise<WatchEventSubscription>;
}

export interface WatchEventSourceStartInput {
  readonly watchedSavePath: string;
  readonly onChange: () => void | Promise<void>;
  readonly onError: (error: unknown) => void | Promise<void>;
}

export interface WatchEventSubscription {
  stop: () => void | Promise<void>;
}

export interface WatchScheduler {
  scheduleAt: (
    runAt: Date,
    task: () => void | Promise<void>,
  ) => ScheduledWatchTask;
}

export interface ScheduledWatchTask {
  cancel: () => void;
}

export interface FileStabilityProbe {
  waitForStableFile: (filePath: string) => Promise<void>;
}
