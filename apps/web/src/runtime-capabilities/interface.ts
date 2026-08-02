export interface RepoSessionConnection {
  readonly endpoint: string;
  readonly token: string;
  readonly access?: "readWrite" | "readOnly";
}

export type RepositoryLifecycle = "managed" | "archived" | "external";

export interface RepositoryLibraryEntry {
  readonly name: string;
  readonly lifecycle: RepositoryLifecycle;
  readonly status: string;
  readonly requiredAction: string;
  readonly current: boolean;
  readonly watching: boolean;
}

export interface RepositoryLibrary {
  readonly managed: readonly RepositoryLibraryEntry[];
  readonly archived: readonly RepositoryLibraryEntry[];
  readonly attention: readonly RepositoryLibraryEntry[];
  readonly external?: RepositoryLibraryEntry;
  readonly stale: boolean;
  readonly error?: string;
}

export type OpenExternalRepositoryResult =
  | { readonly kind: "cancelled" }
  | { readonly kind: "opened" }
  | { readonly kind: "busy" }
  | { readonly kind: "blockedByMutation" }
  | {
      readonly action:
        | "chooseAnotherDirectory"
        | "confirmMigration"
        | "rebuildReadModel"
        | "useNewerApp";
      readonly kind: "requiresAction";
      readonly status:
        | "invalid"
        | "legacyConfig"
        | "migrationRequired"
        | "newerIncompatible"
        | "rebuildRequired";
    };

export type PickStaticEncodedSaveResult =
  | { readonly kind: "cancelled" }
  | { readonly decodedSave: unknown; readonly kind: "loaded" }
  | { readonly kind: "invalidFile" }
  | { readonly kind: "decodeFailed" }
  /** Safe native picker or sidecar failure reported by the File menu event. */
  | { readonly kind: "failed"; readonly message: string };

export type RuntimeCapabilities =
  | { readonly kind: "browser" }
  | {
      readonly getRepoSessionConnection: () =>
        | Promise<RepoSessionConnection>
        | RepoSessionConnection;
      readonly kind: "desktop";
      readonly closeRepository?: () => Promise<void>;
      readonly getRepositoryLibrary?: () => Promise<RepositoryLibrary>;
      readonly openLibraryEntry?: (input: {
        readonly lifecycle: Exclude<RepositoryLifecycle, "external">;
        readonly name: string;
      }) => Promise<OpenExternalRepositoryResult>;
      readonly openExternalRepository: () => Promise<OpenExternalRepositoryResult>;
      /** Opens the native Encoded Save picker without exposing filesystem authority. */
      readonly pickStaticEncodedSave: () => Promise<PickStaticEncodedSaveResult>;
      /** Receives the outcome of the native File menu's equivalent picker action. */
      readonly onStaticEncodedSavePicked?: (
        listener: (result: PickStaticEncodedSaveResult) => void,
      ) => Promise<() => void>;
      /** Reopens only an explicitly invalidated in-memory Desktop selection. */
      readonly reopenRepository?: () => Promise<OpenExternalRepositoryResult>;
      readonly startWatching: () => Promise<void>;
      readonly stopWatching: () => Promise<void>;
    };
