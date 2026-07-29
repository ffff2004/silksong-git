import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import type { Server } from "node:http";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";

const WEBDRIVER_URL = "http://127.0.0.1:4444";
const WEBDRIVER_REQUEST_TIMEOUT_MILLISECONDS = 5000;
const PROCESS_EXIT_TIMEOUT_MILLISECONDS = 5000;
const REMOTE_NAVIGATION_SETTLE_MILLISECONDS = 2000;
const ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";
const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const application = path.join(
  REPO_ROOT,
  "apps/desktop/src-tauri/target/release/silksong-git",
);
const encodedFixture = path.join(
  REPO_ROOT,
  "packages/core/src/decode/fixtures/mask-shard-2-collected-rosaries-save.dat",
);
const decodedFixture = path.join(
  REPO_ROOT,
  "apps/web/src/test-fixtures/mask-shard-2-collected-rosaries-save.decoded.json",
);

await runSmoke();

async function runSmoke() {
  await assertRegularFile(application);
  await assertRegularFile(encodedFixture);
  await assertRegularFile(decodedFixture);

  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "silksong-git-webkit-smoke-"),
  );
  const resources: SmokeResources = {
    driverOutput: [],
    openLog: path.join(temporaryDirectory, "opened-urls.log"),
    temporaryDirectory,
  };
  let smokeError: unknown;

  try {
    await exerciseApplication(resources);
  } catch (error) {
    smokeError = error;
  }

  const cleanupErrors: unknown[] = [];
  if (resources.sessionId !== undefined) {
    try {
      await webdriver("DELETE", `/session/${resources.sessionId}`);
    } catch (error) {
      cleanupErrors.push(
        new Error("Failed to delete the WebDriver session.", { cause: error }),
      );
    }
  }
  if (resources.driverProcess !== undefined) {
    try {
      await terminateProcessGroup(resources.driverProcess);
    } catch (error) {
      cleanupErrors.push(
        new Error("Failed to terminate the tauri-driver process group.", {
          cause: error,
        }),
      );
    }
  }
  if (resources.remoteTarget !== undefined) {
    try {
      await closeServer(resources.remoteTarget.server);
    } catch (error) {
      cleanupErrors.push(
        new Error("Failed to close the remote-navigation target.", {
          cause: error,
        }),
      );
    }
  }
  try {
    await rm(resources.temporaryDirectory, { force: true, recursive: true });
  } catch (error) {
    cleanupErrors.push(
      new Error(`Failed to remove ${resources.temporaryDirectory}.`, {
        cause: error,
      }),
    );
  }

  if (smokeError !== undefined) {
    console.error(resources.driverOutput.join(""));
  }
  const errors = [
    ...(smokeError === undefined ? [] : [smokeError]),
    ...cleanupErrors,
  ];
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, "WebKitGTK smoke and cleanup failed.");
  }

  console.log(
    "WebKitGTK smoke passed: Encoded and Decoded uploads, Monaco, external opening, popup denial, remote navigation denial, and bounded cleanup.",
  );
}

interface SmokeResources {
  readonly driverOutput: string[];
  readonly openLog: string;
  readonly temporaryDirectory: string;
  driverProcess?: ChildProcess;
  remoteTarget?: RemoteTarget;
  sessionId?: string;
}

async function exerciseApplication(resources: SmokeResources) {
  const state = resources;
  const fakeBin = path.join(resources.temporaryDirectory, "bin");
  await mkdir(fakeBin);
  const fakeXdgOpen = path.join(fakeBin, "xdg-open");
  await writeFile(
    fakeXdgOpen,
    '#!/bin/sh\nprintf "%s\\n" "$1" >> "$SILKSONG_GIT_OPEN_LOG"\n',
  );
  await chmod(fakeXdgOpen, 0o755);

  const remoteTarget = await startRemoteTarget();
  state.remoteTarget = remoteTarget;
  const tauriDriverPath = process.env["TAURI_DRIVER"] ?? "tauri-driver";
  const driverProcess = spawn(tauriDriverPath, [], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    env: {
      ...process.env,
      GDK_BACKEND: "x11",
      PATH: `${fakeBin}:${process.env["PATH"] ?? ""}`,
      SILKSONG_GIT_OPEN_LOG: resources.openLog,
    },
  });
  state.driverProcess = driverProcess;
  captureOutput(driverProcess, resources.driverOutput);

  await waitForDriver(driverProcess);
  const { sessionId } = await webdriver<{
    readonly sessionId: string;
  }>("POST", "/session", {
    capabilities: {
      alwaysMatch: {
        browserName: "wry",
        "tauri:options": { application },
      },
    },
  });
  state.sessionId = sessionId;

  await uploadSave(sessionId, encodedFixture);
  await assertText(sessionId, "#completionValue", "39%");

  await click(sessionId, 'a[href="#/raw-save"]');
  await waitForElement(sessionId, "#raw-save-data-output .monaco-editor");

  await click(sessionId, "#upload-save");
  await setFileInput(sessionId, "#fileInput", decodedFixture);
  await waitForMissingElement(sessionId, "#uploadOverlay");
  await click(sessionId, 'a[href="#/progress"]');
  await assertText(sessionId, "#completionValue", "39%");

  await assertRemoteNavigationDenied(sessionId, remoteTarget);

  await execute(
    sessionId,
    [
      "const link = document.createElement('a');",
      "link.id = 'smoke-denied-popup';",
      "link.href = 'https://example.com/popup';",
      "link.target = '_blank';",
      "link.textContent = 'Denied popup';",
      "link.style = 'position: fixed; inset: 0 auto auto 0; z-index: 2147483647';",
      "document.body.append(link);",
    ].join(""),
  );
  await trustedClick(sessionId, "#smoke-denied-popup");
  await settleNativePolicy();
  await assertSingleWindow(sessionId);
  await assertOpenLog(resources.openLog, []);

  await trustedClick(sessionId, 'a[href="https://hollowknight.wiki"]');
  await waitFor(async () => {
    const openedUrls = await readOpenLog(resources.openLog);
    return openedUrls.length === 1;
  }, "validated external opening");
  await assertOpenLog(resources.openLog, ["https://hollowknight.wiki/"]);
  await assertSingleWindow(sessionId);
}

interface RemoteTarget {
  readonly server: Server;
  readonly url: string;
  readonly requestCount: () => number;
}

async function startRemoteTarget(): Promise<RemoteTarget> {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      '<!doctype html><title>Remote target</title><main id="remote-target">Navigation escaped the app</main>',
    );
  });
  server.listen(0, "127.0.0.1");
  try {
    await waitForServerListening(server);
  } catch (error) {
    server.closeAllConnections();
    server.close();
    throw error;
  }
  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer(server);
    throw new Error("Remote-navigation target did not bind a TCP port.");
  }
  return {
    requestCount: () => requests,
    server,
    url: `http://127.0.0.1:${address.port}/remote-navigation`,
  };
}

async function waitForServerListening(server: Server) {
  if (server.listening) {
    return;
  }
  await withTimeout(
    new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.once("listening", resolve);
    }),
    PROCESS_EXIT_TIMEOUT_MILLISECONDS,
    "remote-navigation target startup",
  );
}

async function closeServer(server: Server) {
  server.closeAllConnections();
  if (!server.listening) {
    return;
  }
  await withTimeout(
    new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) {
          resolve();
        } else {
          reject(error);
        }
      });
    }),
    PROCESS_EXIT_TIMEOUT_MILLISECONDS,
    "remote-navigation target shutdown",
  );
}

interface ApplicationState {
  readonly composition: string | null;
  readonly completion: string | null;
  readonly url: string;
}

async function assertRemoteNavigationDenied(
  session: string,
  remoteTarget: RemoteTarget,
) {
  const initialUrl = await webdriver<string>("GET", `/session/${session}/url`);
  const initialState = await getApplicationState(session);
  if (
    initialState.url !== initialUrl
    || initialState.composition !== "desktop"
    || initialState.completion !== "39%"
  ) {
    throw new Error(
      `Unexpected application state before remote navigation: ${JSON.stringify(initialState)}.`,
    );
  }

  await execute(
    session,
    `window.location.href = ${JSON.stringify(remoteTarget.url)};`,
  );
  const deadline = Date.now() + REMOTE_NAVIGATION_SETTLE_MILLISECONDS;
  do {
    if (remoteTarget.requestCount() !== 0) {
      throw new Error("Denied remote navigation reached the loopback target.");
    }
    const [currentUrl, currentState] = await Promise.all([
      webdriver<string>("GET", `/session/${session}/url`),
      getApplicationState(session),
    ]);
    if (
      currentUrl !== initialUrl
      || currentState.url !== initialUrl
      || currentState.composition !== initialState.composition
      || currentState.completion !== initialState.completion
    ) {
      throw new Error(
        `Application changed during denied remote navigation: ${JSON.stringify({ currentState, currentUrl, initialState, initialUrl })}.`,
      );
    }
    await delay(100);
  } while (Date.now() < deadline);

  if (remoteTarget.requestCount() !== 0) {
    throw new Error("Denied remote navigation reached the loopback target.");
  }
}

async function getApplicationState(session: string): Promise<ApplicationState> {
  return await webdriver("POST", `/session/${session}/execute/sync`, {
    args: [],
    script: [
      "return {",
      "composition: document.querySelector('meta[name=\"silksong-git-composition\"]')?.content ?? null,",
      "completion: document.querySelector('#completionValue')?.textContent ?? null,",
      "url: window.location.href,",
      "};",
    ].join(""),
  });
}

async function uploadSave(session: string, filePath: string) {
  await click(session, "#upload-save");
  await setFileInput(session, "#fileInput", filePath);
  await waitForMissingElement(session, "#uploadOverlay");
}

async function click(session: string, selector: string) {
  await waitForElement(session, selector);
  await webdriver("POST", `/session/${session}/execute/sync`, {
    args: [selector],
    script: "document.querySelector(arguments[0]).click();",
  });
}

async function trustedClick(session: string, selector: string) {
  const element = await waitForElement(session, selector);
  await webdriver("POST", `/session/${session}/execute/sync`, {
    args: [selector],
    script:
      "document.querySelector(arguments[0]).scrollIntoView({ block: 'center' });",
  });
  await webdriver("POST", `/session/${session}/element/${element}/click`, {});
}

async function setFileInput(
  session: string,
  selector: string,
  filePath: string,
) {
  const element = await waitForElement(session, selector);
  await webdriver("POST", `/session/${session}/element/${element}/value`, {
    text: filePath,
  });
}

async function assertText(session: string, selector: string, expected: string) {
  await waitFor(async () => {
    const element = await findElement(session, selector);
    if (element === undefined) {
      return false;
    }
    const text = await webdriver<string>(
      "GET",
      `/session/${session}/element/${element}/text`,
    );
    return text === expected;
  }, `${selector} text ${expected}`);
}

async function assertSingleWindow(session: string) {
  const handles = await webdriver<readonly string[]>(
    "GET",
    `/session/${session}/window/handles`,
  );
  if (handles.length !== 1) {
    throw new Error(`Expected one WebView window, received ${handles.length}.`);
  }
}

async function execute(session: string, script: string) {
  await webdriver("POST", `/session/${session}/execute/sync`, {
    args: [],
    script,
  });
}

async function waitForElement(
  session: string,
  selector: string,
): Promise<string> {
  let found: string | undefined;
  await waitFor(async () => {
    found = await findElement(session, selector);
    return found !== undefined;
  }, `element ${selector}`);
  if (found === undefined) {
    throw new Error(`Element disappeared after wait: ${selector}`);
  }
  return found;
}

async function waitForMissingElement(session: string, selector: string) {
  await waitFor(
    async () => (await findElement(session, selector)) === undefined,
    `missing element ${selector}`,
  );
}

async function findElement(
  session: string,
  selector: string,
): Promise<string | undefined> {
  let element: Record<string, string> | null;
  try {
    element = await webdriver<Record<string, string> | null>(
      "POST",
      `/session/${session}/execute/sync`,
      {
        args: [selector],
        script: "return document.querySelector(arguments[0]);",
      },
    );
  } catch (error) {
    assertTransientElementLookup(error);
    return undefined;
  }
  return element?.[ELEMENT_KEY];
}

function assertTransientElementLookup(error: unknown) {
  if (!isWebdriverError(error, "stale element reference")) {
    throw error;
  }
}

async function waitForDriver(driverProcess: ChildProcess) {
  let spawnError: Error | undefined;
  driverProcess.once("error", (error) => {
    spawnError = error;
  });
  await waitFor(async () => {
    if (spawnError !== undefined) {
      throw spawnError;
    }
    if (driverProcess.exitCode !== null || driverProcess.signalCode !== null) {
      throw new Error("tauri-driver exited before accepting connections.");
    }
    try {
      await webdriver("GET", "/status");
      return true;
    } catch {
      return false;
    }
  }, "tauri-driver startup");
}

async function webdriver<T = unknown>(
  method: string,
  route: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${WEBDRIVER_URL}${route}`, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers:
      body === undefined ? undefined : { "content-type": "application/json" },
    method,
    signal: AbortSignal.timeout(WEBDRIVER_REQUEST_TIMEOUT_MILLISECONDS),
  });
  const payload = (await response.json()) as {
    readonly value?: T & {
      readonly error?: string;
      readonly message?: string;
    };
  };
  if (!response.ok || payload.value?.error !== undefined) {
    const error = new Error(
      payload.value?.message ?? `WebDriver ${method} ${route} failed.`,
    );
    Object.assign(error, { webdriverError: payload.value?.error });
    throw error;
  }
  return payload.value as T;
}

async function waitFor(
  probe: () => Promise<boolean>,
  description: string,
  timeoutMilliseconds = 20_000,
) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (await probe()) {
      return;
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function settleNativePolicy() {
  await delay(500);
}

async function assertOpenLog(openLog: string, expected: readonly string[]) {
  const actual = await readOpenLog(openLog);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected opened URLs ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}.`,
    );
  }
}

function isWebdriverError(error: unknown, code: string): boolean {
  return (
    error instanceof Error
    && "webdriverError" in error
    && error.webdriverError === code
  );
}

async function readOpenLog(openLog: string): Promise<readonly string[]> {
  try {
    const contents = await readFile(openLog, "utf8");
    return contents.split("\n").filter((line) => line !== "");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return [];
    }
    throw error;
  }
}

async function assertRegularFile(filePath: string) {
  const fileStats = await stat(filePath);
  if (!fileStats.isFile()) {
    throw new Error(`Expected regular file: ${filePath}`);
  }
}

function captureOutput(
  processHandle: ChildProcess,
  output: Readonly<{ push: (value: string) => number }>,
) {
  processHandle.stdout?.on("data", (chunk: Buffer) => {
    output.push(chunk.toString());
  });
  processHandle.stderr?.on("data", (chunk: Buffer) => {
    output.push(chunk.toString());
  });
}

async function terminateProcessGroup(processHandle: ChildProcess) {
  const { pid } = processHandle;
  if (pid === undefined) {
    await waitForProcessExit(processHandle);
    return;
  }

  signalProcessGroup(pid, "SIGTERM");
  if (await waitForProcessGroupExit(pid, PROCESS_EXIT_TIMEOUT_MILLISECONDS)) {
    await waitForProcessExit(processHandle);
    return;
  }

  signalProcessGroup(pid, "SIGKILL");
  if (
    !(await waitForProcessGroupExit(pid, PROCESS_EXIT_TIMEOUT_MILLISECONDS))
  ) {
    throw new Error(`Process group ${pid} survived SIGKILL.`);
  }
  await waitForProcessExit(processHandle);
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!isNodeError(error, "ESRCH")) {
      throw error;
    }
  }
}

async function waitForProcessGroupExit(
  pid: number,
  timeoutMilliseconds: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (!processGroupExists(pid)) {
      return true;
    }
    await delay(50);
  }
  return !processGroupExists(pid);
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (isNodeError(error, "ESRCH")) {
      return false;
    }
    throw error;
  }
}

async function waitForProcessExit(processHandle: ChildProcess) {
  if (processHandle.exitCode !== null || processHandle.signalCode !== null) {
    return;
  }
  await withTimeout(
    new Promise<void>((resolve) => {
      processHandle.once("exit", () => {
        resolve();
      });
    }),
    PROCESS_EXIT_TIMEOUT_MILLISECONDS,
    "tauri-driver child exit",
  );
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMilliseconds: number,
  description: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Timed out waiting for ${description}.`));
        }, timeoutMilliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function delay(milliseconds: number) {
  await new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === code
  );
}
