/// <reference types="node" />

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@solidjs/testing-library";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import decodedSave from "../test-fixtures/mask-shard-2-collected-rosaries-save.decoded.json";
import { App } from "./App.tsx";

describe("Solid Web app routing", () => {
  beforeEach(() => {
    window.scrollTo = vi.fn();
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    globalThis.location.hash = "";
  });

  it("shows Progress by default", async () => {
    render(() => <App />);

    expect(await screen.findByTestId("progress-view")).toBeDefined();
    expect(
      screen.getByRole("link", { name: "Progress" }).getAttribute("href"),
    ).toBe("#/progress");
  });

  it("loads decoded JSON through Static Web Mode and renders summary metrics", async () => {
    render(() => <App />);

    fireEvent.click(getRequiredElement("#upload-save"));
    const fileInput = getRequiredFileInput();

    const file = new File([JSON.stringify(decodedSave)], "save.json", {
      type: "application/json",
    });
    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => {
      expect(document.querySelector("#completionValue")?.textContent).toBe(
        "39%",
      );
    });

    expect(document.querySelector("#modeBanner")?.textContent).toContain(
      "NORMAL SAVE LOADED",
    );
    expect(document.querySelector("#playtimeValue")?.textContent).toBe(
      "24h 12m",
    );
    expect(document.querySelector("#rosariesValue")?.textContent).toBe("800");
    expect(document.querySelector("#shardsValue")?.textContent).toBe("76");
  }, 20_000);

  it("applies Static Web Mode preference filters to progress rendering", async () => {
    const { container } = render(() => <App />);

    expect(screen.getByText("Base Needle")).toBeDefined();
    fireEvent.click(getRequiredElement("#acts-dropdown-button"));
    fireEvent.click(getRequiredElement('#acts-dropdown-menu input[value="2"]'));
    fireEvent.click(getRequiredElement('#acts-dropdown-menu input[value="3"]'));

    expect(screen.queryByText("Shining Needle")).toBeNull();
    expect(screen.getByText("Base Needle")).toBeDefined();

    fireEvent.click(getRequiredElement("#upload-save"));
    const fileInput = getRequiredFileInput();
    const file = new File([JSON.stringify(decodedSave)], "save.json", {
      type: "application/json",
    });
    fireEvent.change(fileInput, { target: { files: [file] } });
    await waitFor(() => {
      expect(document.querySelector("#completionValue")?.textContent).toBe(
        "39%",
      );
    });

    fireEvent.click(getRequiredElement("#show-only-missing"));
    expect(container.querySelector(".boss.done")).toBeNull();
  }, 20_000);

  it("shows Raw Save and Map routes from loaded Static Web Mode state", async () => {
    render(() => <App />);

    fireEvent.click(getRequiredElement("#upload-save"));
    const fileInput = getRequiredFileInput();
    const file = new File([JSON.stringify(decodedSave)], "save.json", {
      type: "application/json",
    });
    fireEvent.change(fileInput, { target: { files: [file] } });
    await waitFor(() => {
      expect(document.querySelector("#completionValue")?.textContent).toBe(
        "39%",
      );
    });

    fireEvent.click(screen.getByRole("link", { name: "Raw Save Data" }));
    expect(await screen.findByTestId("raw-save-view")).toBeDefined();
    expect(screen.getByTestId("raw-save-fallback").textContent).toContain(
      "completionPercentage",
    );

    fireEvent.click(screen.getByRole("link", { name: "Interactive Map" }));
    expect(await screen.findByTestId("map-view")).toBeDefined();
    expect(document.querySelector("#worldMap")).not.toBeNull();
    expect(document.querySelectorAll(".map-pin").length).toBeGreaterThan(0);
  }, 20_000);

  it("resets upload platform pill styling for both links and buttons", () => {
    const pillRule = getCssRuleBody(".pill");
    const pillHoverRule = getCssRuleBody(".pill:hover");

    expect(pillRule).toContain("appearance: none;");
    expect(pillRule).toContain("box-sizing: content-box;");
    expect(pillRule).toContain("color: var(--accent);");
    expect(pillHoverRule).toContain("background: #2a2a2a;");
    expect(pillHoverRule).toContain("color: #e69b50;");
    expect(pillHoverRule).toContain(
      "text-shadow: 0 0 8px rgba(197, 106, 45, 0.4);",
    );
  });

  it("lets button-rendered controls inherit the page font", () => {
    const buttonRule = getCssRuleBody("button");

    expect(buttonRule).toContain("font: inherit;");
  });
});

function getRequiredFileInput(): HTMLInputElement {
  const fileInput = document.querySelector<HTMLInputElement>("#fileInput");
  if (fileInput === null) {
    throw new Error("Expected upload file input to exist.");
  }

  return fileInput;
}

function getRequiredElement(selector: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(selector);
  if (element === null) {
    throw new Error(`Expected ${selector} to exist.`);
  }

  return element;
}

function getCssRuleBody(selector: string): string {
  const stylesheet = readFileSync("public/assets/css/style.css", "utf8");
  const rulePattern = new RegExp(
    String.raw`${escapeRegExp(selector)}\s*\{([^}]*)\}`,
  );
  const match = rulePattern.exec(stylesheet);
  if (match?.[1] === undefined) {
    throw new Error(`Expected ${selector} CSS rule to exist.`);
  }

  return match[1];
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[$()*+.?[\\\]^{|}]/g, String.raw`\$&`);
}
