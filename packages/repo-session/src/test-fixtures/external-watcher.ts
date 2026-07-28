import { acquireSaveHistoryWatcher } from "@silksong-git/history";

export const externalWatcherFixturePath = import.meta.filename;

if (process.argv[1] === externalWatcherFixturePath) {
  await runExternalWatcherFixture();
}

async function runExternalWatcherFixture() {
  const repoPath = process.argv[2];

  if (repoPath === undefined || process.send === undefined) {
    throw new Error(
      "External watcher fixture requires a repository path and IPC.",
    );
  }

  const send = process.send.bind(process);
  const watcher = await acquireSaveHistoryWatcher({ repoPath });
  send({ type: "acquired" });

  process.once("message", (message: unknown) => {
    if (
      typeof message !== "object"
      || message === null
      || !("type" in message)
      || message.type !== "release"
    ) {
      return;
    }

    watcher
      .release()
      .then(() => {
        send({ type: "released" });
      })
      .catch((error: unknown) => {
        send({
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        });
        process.exitCode = 1;
      });
  });
}
