export interface RepoSessionConnection {
  readonly endpoint: string;
  readonly token: string;
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

export type RuntimeCapabilities =
  | { readonly kind: "browser" }
  | {
      readonly getRepoSessionConnection: () =>
        | Promise<RepoSessionConnection>
        | RepoSessionConnection;
      readonly kind: "desktop";
      readonly openExternalRepository: () => Promise<OpenExternalRepositoryResult>;
      /** Reopens only an explicitly invalidated in-memory Desktop selection. */
      readonly reopenRepository?: () => Promise<OpenExternalRepositoryResult>;
      readonly startWatching: () => Promise<void>;
      readonly stopWatching: () => Promise<void>;
    };
