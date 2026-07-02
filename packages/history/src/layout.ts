import path from "node:path";

export const encodedSaveArtifactPath = "save.dat";
const decodedSaveArtifactPath = "decoded-save.json";
const observationArtifactPath = "observation.json";

export const trackedRawObservationPaths = [
  ".gitignore",
  ".silksong-git/config.json",
  encodedSaveArtifactPath,
  decodedSaveArtifactPath,
  observationArtifactPath,
] as const;

const ignoredRuntimeArtifactPaths = [
  ".silksong-git/read-model.sqlite",
  ".silksong-git/write.lock",
] as const;

export const defaultGitignoreContent = `${ignoredRuntimeArtifactPaths.join("\n")}\n`;

interface RepositoryLayout {
  readonly silksongGitDirectory: string;
  readonly configPath: string;
  readonly readModelPath: string;
  readonly writeLockPath: string;
  readonly gitignorePath: string;
  readonly encodedSavePath: string;
  readonly decodedSavePath: string;
  readonly observationPath: string;
}

export function getRepositoryLayout(repoPath: string): RepositoryLayout {
  const silksongGitDirectory = path.join(repoPath, ".silksong-git");

  return {
    silksongGitDirectory,
    configPath: path.join(silksongGitDirectory, "config.json"),
    readModelPath: path.join(silksongGitDirectory, "read-model.sqlite"),
    writeLockPath: path.join(silksongGitDirectory, "write.lock"),
    gitignorePath: path.join(repoPath, ".gitignore"),
    encodedSavePath: path.join(repoPath, encodedSaveArtifactPath),
    decodedSavePath: path.join(repoPath, decodedSaveArtifactPath),
    observationPath: path.join(repoPath, observationArtifactPath),
  };
}
