const invoke = window.__TAURI__.core.invoke;
const status = document.querySelector("#status");
const steps = document.querySelector("#steps");
const details = document.querySelector("#details");
const runButton = document.querySelector("#run");
const closeButton = document.querySelector("#close-probe");

function showSteps(names) {
  steps.replaceChildren(
    ...names.map((name) => {
      const item = document.createElement("li");
      item.textContent = `✓ ${name}`;
      return item;
    }),
  );
}

runButton.addEventListener("click", async () => {
  runButton.disabled = true;
  closeButton.disabled = true;
  status.textContent = "Running the installed sidecar tracer…";
  details.textContent = "";

  try {
    const result = await invoke("run_tracer");
    showSteps(result.visibleSteps);
    details.textContent = JSON.stringify(result, undefined, 2);
    status.textContent = "PASS — packaged tracer completed.";
    document.title = "PASS · Silksong Git packaging tracer";
  } catch (error) {
    status.textContent = `FAIL — ${String(error)}`;
    document.title = "FAIL · Silksong Git packaging tracer";
  } finally {
    runButton.disabled = false;
    closeButton.disabled = false;
  }
});

closeButton.addEventListener("click", async () => {
  runButton.disabled = true;
  closeButton.disabled = true;
  status.textContent = "Active operation started. Close this window now.";

  try {
    const result = await invoke("start_active_work");
    showSteps(["active sidecar operation started", "close waits for drain"]);
    details.textContent = JSON.stringify(result, undefined, 2);
    document.title = "ACTIVE · closing after graceful drain";
    await new Promise((resolve) => setTimeout(resolve, 150));
    await window.__TAURI__.window.getCurrentWindow().close();
  } catch (error) {
    status.textContent = `FAIL — ${String(error)}`;
    document.title = "FAIL · Silksong Git packaging tracer";
  }
});

invoke("prototype_autorun").then((mode) => {
  if (mode === "tracer") {
    runButton.click();
  } else if (mode === "close-drain") {
    closeButton.click();
  }
});
