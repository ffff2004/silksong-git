import path from "node:path";

import {
  readCurrentHead,
  readGitBlob,
  readHistoryCommit,
} from "./git-store.ts";
import { sha256Hex } from "./hash.ts";
import { decodedSaveArtifactPath, encodedSaveArtifactPath } from "./layout.ts";
import { readRawSaveObservation, readSemanticSnapshot } from "./read-model.ts";
import { assertRepositoryCapability } from "./repository-compatibility.ts";
import type {
  GetSaveStateInput,
  GetSaveStateResult,
  ReadEncodedSaveInput,
  ReadEncodedSaveResult,
} from "./types.ts";
import { readWatchedSavePath } from "./watched-save.ts";

export async function getSaveState(
  input: GetSaveStateInput,
): Promise<GetSaveStateResult> {
  await assertRepositoryCapability(input.repoPath, "read", input.access);
  const selectedRef =
    input.selector.kind === "latest"
      ? await readCurrentHead(input.repoPath)
      : input.selector.commitRef;

  if (selectedRef === undefined) {
    return { status: "empty" };
  }

  const commit = await readHistoryCommit(input.repoPath, selectedRef);
  const observation = await readRawSaveObservation(input.repoPath, commit.ref);
  const decodedBytes = await readGitBlob(
    input.repoPath,
    commit.ref,
    decodedSaveArtifactPath,
  );
  const decodedSave: unknown = JSON.parse(decodedBytes.toString("utf8"));
  const semanticSnapshot =
    observation.schema.status === "unrecognized"
      ? // The public API uses explicit null to distinguish an unrecognized schema from an omitted field.
        // eslint-disable-next-line unicorn/no-null
        null
      : await readSemanticSnapshot(input.repoPath, commit.ref);

  return {
    status: "available",
    observation,
    decodedSave,
    semanticSnapshot,
  };
}

export async function readEncodedSave(
  input: ReadEncodedSaveInput,
): Promise<ReadEncodedSaveResult> {
  await assertRepositoryCapability(input.repoPath, "read", input.access);
  const commit = await readHistoryCommit(input.repoPath, input.commitRef);
  const encodedBytes = await readGitBlob(
    input.repoPath,
    commit.ref,
    encodedSaveArtifactPath,
  );
  const watchedSavePath = await readWatchedSavePath(
    input.repoPath,
    input.access,
  );
  const watchedStem = path.parse(path.basename(watchedSavePath)).name;
  const safeStemCandidate = watchedStem
    .normalize("NFC")
    .replaceAll(/[^\p{Letter}\p{Number}\-._]+/gv, "-")
    .replaceAll(/^-/gv, "")
    .replaceAll(/-$/gv, "");
  const safeStem = safeStemCandidate === "" ? "save" : safeStemCandidate;

  return {
    commit,
    encodedBytes,
    encodedSha256: sha256Hex(encodedBytes),
    suggestedFileName: `${safeStem}.${commit.shortRef}.dat`,
  };
}
