import { readFile } from "node:fs/promises";

import { readCurrentHead } from "./git-store.ts";
import { sha256Hex } from "./hash.ts";
import { getRepositoryLayout } from "./layout.ts";
import { decodeObservation } from "./observation-decoder.ts";
import type { ObservationMetadata } from "./observation.ts";
import { commitRawSaveObservation } from "./raw-observation-store.ts";
import {
  appendObservationToReadModel,
  prepareReadModelForAppend,
} from "./read-model.ts";
import type {
  ObserveSaveInput,
  ObserveSaveResult,
  ProjectConfig,
  SemanticUpdateResult,
} from "./types.ts";

interface ObserveSaveUsingConfigInput extends ObserveSaveInput {
  readonly config: ProjectConfig;
}

export async function observeSaveUsingConfig(
  input: ObserveSaveUsingConfigInput,
): Promise<ObserveSaveResult> {
  const { config } = input;
  const trigger = input.trigger ?? "watcher";
  const isManualCheckpoint = trigger === "manualCheckpoint";
  const shouldCommitUnchanged =
    isManualCheckpoint && input.allowUnchanged === true;
  const observedAt = input.observedAt ?? new Date();
  const readResult = await readWatchedSave(config.watchedSavePath);

  if (readResult.status === "watcherError") {
    return readResult;
  }

  const { encodedBytes } = readResult;
  const encodedSha256 = sha256Hex(encodedBytes);
  const lastObservation = await readLastObservation(input.repoPath);

  if (
    !shouldCommitUnchanged
    && lastObservation?.encodedSha256 === encodedSha256
  ) {
    return {
      status: "skipped",
      reason: "unchanged",
      encodedSha256,
    };
  }

  if (
    !isManualCheckpoint
    && isInsideMinimumCommitInterval(
      lastObservation?.observedAt,
      observedAt,
      config.capturePolicy.minCommitIntervalMs,
    )
  ) {
    return {
      status: "skipped",
      reason: "minimumCommitInterval",
      encodedSha256,
      nextAllowedAt: getNextAllowedObservationAt(
        lastObservation?.observedAt,
        config.capturePolicy.minCommitIntervalMs,
      ),
    };
  }

  const decoded = decodeObservation(encodedBytes);

  if (decoded.status === "watcherError") {
    return decoded;
  }

  const previousCommit = await readCurrentHead(input.repoPath);
  const observationMetadata: ObservationMetadata = {
    observedAt: observedAt.toISOString(),
    trigger,
    message: input.message,
    sourcePath: config.watchedSavePath,
    encodedSha256,
    previousCommit,
    decodedSha256: decoded.decodedSha256,
    decoderVersion: decoded.decoderVersion,
    schema: decoded.schema,
  };

  let isReadModelReady = true;
  try {
    await prepareReadModelForAppend(input.repoPath, previousCommit);
  } catch {
    isReadModelReady = false;
  }

  const observation = await commitRawSaveObservation({
    repoPath: input.repoPath,
    encodedBytes,
    decodedJson: decoded.decodedJson,
    metadata: observationMetadata,
  });

  if (!isReadModelReady) {
    return {
      status: "committed",
      observation,
      semanticUpdate: {
        status: "notAvailable",
        reason: "readModelUnavailable",
      },
    };
  }

  let semanticUpdate: SemanticUpdateResult;
  try {
    semanticUpdate = appendObservationToReadModel({
      repoPath: input.repoPath,
      observation,
      decodedSave: decoded.decodedSave,
      displaySemanticEventFilters: config.displaySemanticEventFilters,
    });
  } catch {
    semanticUpdate = {
      status: "notAvailable",
      reason: "readModelUnavailable",
    };
  }

  return {
    status: "committed",
    observation,
    semanticUpdate,
  };
}

type ReadWatchedSaveResult =
  | Extract<ObserveSaveResult, { readonly status: "watcherError" }>
  | {
      readonly status: "ok";
      readonly encodedBytes: Uint8Array;
    };

async function readWatchedSave(
  filePath: string,
): Promise<ReadWatchedSaveResult> {
  try {
    return {
      status: "ok",
      encodedBytes: await readFile(filePath),
    };
  } catch (error) {
    return {
      status: "watcherError",
      error: {
        message: getErrorMessage(error),
        reason: "readFailure",
      },
    };
  }
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

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isInsideMinimumCommitInterval(
  lastObservedAt: string | undefined,
  observedAt: Date,
  minCommitIntervalMs: number,
): boolean {
  if (lastObservedAt === undefined || minCommitIntervalMs <= 0) {
    return false;
  }

  return (
    observedAt.getTime() - Date.parse(lastObservedAt) < minCommitIntervalMs
  );
}

function getNextAllowedObservationAt(
  lastObservedAt: string | undefined,
  minCommitIntervalMs: number,
): string {
  if (lastObservedAt === undefined) {
    throw new Error("missing last observation for minimum interval skip");
  }

  const nextAllowedAt = new Date(
    Date.parse(lastObservedAt) + minCommitIntervalMs,
  );

  return nextAllowedAt.toISOString();
}
