import path from "node:path";

export const encodedSaveArtifactPath = "save.dat";
export const decodedSaveArtifactPath = "decoded-save.json";
const observationArtifactPath = "observation.json";
const gitAttributesArtifactPath = ".gitattributes";

export const trackedRawObservationPaths = [
  ".gitignore",
  gitAttributesArtifactPath,
  ".silksong-git/config.json",
  encodedSaveArtifactPath,
  decodedSaveArtifactPath,
  observationArtifactPath,
] as const;

const ignoredRuntimeArtifactPaths = [
  ".silksong-git/read-model.sqlite",
  ".silksong-git/write.lock",
  ".silksong-git/watch.lock",
  ".silksong-git/no-hooks/",
  ".silksong-git/global-attributes",
] as const;

export const defaultGitignoreContent = `${ignoredRuntimeArtifactPaths.join("\n")}\n`;
export const defaultGitAttributesContent = [
  "save.dat -text -filter -ident -diff -merge",
  "decoded-save.json text eol=lf -filter -ident",
  "observation.json text eol=lf -filter -ident",
  ".silksong-git/config.json text eol=lf -filter -ident",
  ".gitignore text eol=lf -filter -ident",
  ".gitattributes text eol=lf -filter -ident",
  "",
].join("\n");

interface RepositoryLayout {
  readonly silksongGitDirectory: string;
  readonly gitInfoDirectory: string;
  readonly gitInfoAttributesPath: string;
  readonly globalAttributesPath: string;
  readonly noHooksDirectory: string;
  readonly configPath: string;
  readonly readModelPath: string;
  readonly writeLockPath: string;
  readonly watchLockPath: string;
  readonly gitignorePath: string;
  readonly gitAttributesPath: string;
  readonly encodedSavePath: string;
  readonly decodedSavePath: string;
  readonly observationPath: string;
}

export function getRepositoryLayout(repoPath: string): RepositoryLayout {
  const silksongGitDirectory = path.join(repoPath, ".silksong-git");
  const gitInfoDirectory = path.join(repoPath, ".git/info");

  return {
    silksongGitDirectory,
    gitInfoDirectory,
    gitInfoAttributesPath: path.join(gitInfoDirectory, "attributes"),
    globalAttributesPath: path.join(silksongGitDirectory, "global-attributes"),
    noHooksDirectory: path.join(silksongGitDirectory, "no-hooks"),
    configPath: path.join(silksongGitDirectory, "config.json"),
    readModelPath: path.join(silksongGitDirectory, "read-model.sqlite"),
    writeLockPath: path.join(silksongGitDirectory, "write.lock"),
    watchLockPath: path.join(silksongGitDirectory, "watch.lock"),
    gitignorePath: path.join(repoPath, ".gitignore"),
    gitAttributesPath: path.join(repoPath, gitAttributesArtifactPath),
    encodedSavePath: path.join(repoPath, encodedSaveArtifactPath),
    decodedSavePath: path.join(repoPath, decodedSaveArtifactPath),
    observationPath: path.join(repoPath, observationArtifactPath),
  };
}
