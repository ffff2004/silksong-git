import { readCurrentHead } from "./git-store.ts";
import { readRawSaveObservation } from "./read-model.ts";
import { assertRepositoryCapability } from "./repository-compatibility.ts";
import type {
  InPlaceRestorePreflightInput,
  InPlaceRestorePreflightResult,
} from "./types.ts";
import { readWatchedSavePresence } from "./watched-save.ts";

export async function preflightInPlaceRestore(
  input: InPlaceRestorePreflightInput,
): Promise<InPlaceRestorePreflightResult> {
  await assertRepositoryCapability(input.repoPath, "read", input.access);

  const head = await readCurrentHead(input.repoPath);
  if (head === undefined) {
    return { status: "emptyHistory" };
  }

  const observation = await readRawSaveObservation(input.repoPath, head);
  const watchedSaveStatus = await readWatchedSavePresence(
    input.repoPath,
    input.access,
  );

  if (watchedSaveStatus === "missing") {
    return {
      status: "targetMissing",
      expectedCurrent: { status: "missing" },
    };
  }

  return {
    status: "targetPresent",
    expectedCurrent: {
      status: "present",
      encodedSha256: observation.encodedSha256,
    },
  };
}
