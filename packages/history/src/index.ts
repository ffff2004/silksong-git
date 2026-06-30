import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createProjectConfig, readProjectConfig } from "./config.ts";
import {
  readCurrentHead,
  readGitBlob,
  readHistoryCommit,
  runGit,
} from "./git-store.ts";
import { sha256Hex } from "./hash.ts";
import { encodedSaveArtifactPath, getRepositoryLayout } from "./layout.ts";
import { decodeObservation } from "./observation-decoder.ts";
import type { ObservationMetadata } from "./observation.ts";
import { commitRawSaveObservation } from "./raw-observation-store.ts";
import {
  diffReadModelCommits,
  queryReadModelHistory,
  rebuildReadModel,
  searchReadModelEvents,
} from "./read-model.ts";
import type {
  DiffCommitsInput,
  DiffCommitsResult,
  HistoryResult,
  InitSaveHistoryInput,
  InitSaveHistoryResult,
  ObserveSaveInput,
  ObserveSaveResult,
  QueryHistoryInput,
  RebuildSemanticReadModelInput,
  RebuildSemanticReadModelResult,
  RestoreEncodedSaveInput,
  RestoreEncodedSaveResult,
  SearchSemanticEventsInput,
  SearchSemanticEventsResult,
} from "./types.ts";

export type {
  DiffCommitsInput,
  DiffCommitsResult,
  HistoricalSemanticEvent,
  HistoryCommit,
  HistoryResult,
  InitSaveHistoryInput,
  InitSaveHistoryResult,
  ObserveSaveInput,
  ObserveSaveResult,
  ProjectConfigOverrides,
  QueryHistoryInput,
  RawSaveObservation,
  RebuildSemanticReadModelInput,
  RebuildSemanticReadModelResult,
  RestoreEncodedSaveInput,
  RestoreEncodedSaveResult,
  RestoreTarget,
  SearchSemanticEventsInput,
  SearchSemanticEventsResult,
  SemanticUpdateResult,
  WatcherError,
} from "./types.ts";

export async function initSaveHistory(
  input: InitSaveHistoryInput,
): Promise<InitSaveHistoryResult> {
  const layout = getRepositoryLayout(input.repoPath);

  await mkdir(input.repoPath, { recursive: true });
  await runGit(input.repoPath, ["init"]);

  await mkdir(layout.silksongGitDirectory, { recursive: true });
  await writeFile(layout.gitignorePath, ".silksong-git/read-model.sqlite\n");
  await writeFile(
    layout.configPath,
    `${JSON.stringify(createProjectConfig(input), undefined, 2)}\n`,
  );

  return {
    repoPath: input.repoPath,
    configPath: layout.configPath,
  };
}

export async function observeSave(
  input: ObserveSaveInput,
): Promise<ObserveSaveResult> {
  const config = await readProjectConfig(input.repoPath);
  const observedAt = input.observedAt ?? new Date();
  const encodedBytes = await readFile(config.watchedSavePath);
  const encodedSha256 = sha256Hex(encodedBytes);
  const lastObservation = await readLastObservation(input.repoPath);

  if (
    input.force !== true
    && lastObservation?.encodedSha256 === encodedSha256
  ) {
    return {
      status: "skipped",
      reason: "unchanged",
      encodedSha256,
    };
  }

  const decoded = decodeObservation(encodedBytes);

  if (decoded.status === "watcherError") {
    return decoded;
  }

  const previousCommit = await readCurrentHead(input.repoPath);
  const observationMetadata: ObservationMetadata = {
    observedAt: observedAt.toISOString(),
    sourcePath: config.watchedSavePath,
    encodedSha256,
    previousCommit,
    decodedSha256: decoded.decodedSha256,
    decoderVersion: decoded.decoderVersion,
    schema: decoded.schema,
  };

  return {
    status: "committed",
    observation: await commitRawSaveObservation({
      repoPath: input.repoPath,
      encodedBytes,
      decodedJson: decoded.decodedJson,
      metadata: observationMetadata,
    }),
    semanticUpdate: decoded.semanticUpdate,
  };
}

export async function restoreEncodedSave(
  input: RestoreEncodedSaveInput,
): Promise<RestoreEncodedSaveResult> {
  if (input.target.kind !== "path") {
    throw new Error("In-place restore is not implemented yet.");
  }

  const encodedSave = await readGitBlob(
    input.repoPath,
    input.commitRef,
    encodedSaveArtifactPath,
  );

  await writeFile(input.target.path, encodedSave, {
    flag: input.target.overwrite === true ? "w" : "wx",
  });

  return {
    commit: await readHistoryCommit(input.repoPath, input.commitRef),
    targetPath: input.target.path,
    writtenSha256: sha256Hex(encodedSave),
  };
}

export async function rebuildSemanticReadModel(
  input: RebuildSemanticReadModelInput,
): Promise<RebuildSemanticReadModelResult> {
  return await rebuildReadModel(input.repoPath);
}

export async function queryHistory(
  input: QueryHistoryInput,
): Promise<HistoryResult> {
  return await Promise.resolve(queryReadModelHistory(input.repoPath, input));
}

export async function diffCommits(
  input: DiffCommitsInput,
): Promise<DiffCommitsResult> {
  return await diffReadModelCommits(input);
}

export async function searchSemanticEvents(
  input: SearchSemanticEventsInput,
): Promise<SearchSemanticEventsResult> {
  return await Promise.resolve(searchReadModelEvents(input.repoPath, input));
}

async function readLastObservation(
  repoPath: string,
): Promise<ObservationMetadata | undefined> {
  try {
    const observationJson = await readFile(
      getRepositoryLayout(repoPath).observationPath,
      "utf8",
    );

    return JSON.parse(observationJson) as ObservationMetadata;
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }

    throw error;
  }
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
