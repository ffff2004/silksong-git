import { writeFile } from "node:fs/promises";

import { readHistoryCommit, runGit } from "./git-store.ts";
import { getRepositoryLayout, trackedRawObservationPaths } from "./layout.ts";
import type { ObservationMetadata } from "./observation.ts";
import type { RawSaveObservation } from "./types.ts";

interface CommitRawSaveObservationInput {
  readonly repoPath: string;
  readonly encodedBytes: Uint8Array;
  readonly decodedJson: string;
  readonly metadata: ObservationMetadata;
}

export async function commitRawSaveObservation(
  input: CommitRawSaveObservationInput,
): Promise<RawSaveObservation> {
  const layout = getRepositoryLayout(input.repoPath);

  await writeFile(layout.encodedSavePath, input.encodedBytes);
  await writeFile(layout.decodedSavePath, input.decodedJson);
  await writeFile(
    layout.observationPath,
    `${JSON.stringify(input.metadata, undefined, 2)}\n`,
  );
  await runGit(input.repoPath, ["add", ...trackedRawObservationPaths]);
  await runGit(
    input.repoPath,
    [
      "-c",
      "user.name=silksong-git",
      "-c",
      "user.email=silksong-git@example.invalid",
      "commit",
      "-m",
      `Observe save ${input.metadata.observedAt}`,
    ],
    {
      GIT_AUTHOR_DATE: input.metadata.observedAt,
      GIT_COMMITTER_DATE: input.metadata.observedAt,
    },
  );

  return {
    commit: await readHistoryCommit(input.repoPath, "HEAD"),
    ...input.metadata,
  };
}
