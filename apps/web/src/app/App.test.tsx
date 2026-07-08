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

const intersectionState: {
  callback: IntersectionObserverCallback | undefined;
} = {
  callback: undefined,
};

class MockIntersectionObserver {
  readonly disconnect = vi.fn();
  readonly observe = vi.fn();
  readonly root = document;
  readonly rootMargin = "";
  readonly scrollMargin = "";
  readonly takeRecords = vi.fn(Array<IntersectionObserverEntry>);
  readonly thresholds: readonly number[] = [];
  readonly unobserve = vi.fn();

  constructor(callback?: IntersectionObserverCallback) {
    intersectionState.callback = callback;
  }
}

describe("Solid Web app routing", () => {
  beforeEach(() => {
    window.scrollTo = vi.fn();
    intersectionState.callback = undefined;
    vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    globalThis.location.hash = "";
    vi.unstubAllGlobals();
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

  it("reveals undiscovered progress items when Show spoilers is enabled", () => {
    render(() => <App />);

    const card = screen.getByText("Shining Needle").closest(".boss");
    if (card === null) {
      throw new Error("Expected Shining Needle card to exist.");
    }

    expect(card.classList.contains("locked")).toBe(true);
    expect(card.querySelector("img")?.getAttribute("src")).toContain(
      "locked.png",
    );

    fireEvent.click(getRequiredElement("#show-spoilers"));

    expect(card.classList.contains("locked")).toBe(false);
    expect(card.querySelector("img")?.getAttribute("src")).not.toContain(
      "locked.png",
    );
  });

  it("keeps the progress TOC collapsible, counted, and synced to scroll", () => {
    render(() => <App />);

    const categories = document.querySelectorAll(".toc-category");
    expect(categories.length).toBeGreaterThan(1);
    expect(document.querySelector(".toc-category.open")).toBeNull();
    expect(document.querySelector(".toc-sublist:not(.hidden)")).toBeNull();

    const firstCategory = getRequiredElement(".toc-category > a");
    const firstCategoryItem = firstCategory.closest(".toc-category");
    if (firstCategoryItem === null) {
      throw new Error("Expected first TOC category to exist.");
    }

    fireEvent.click(firstCategory);
    expect(firstCategoryItem.classList.contains("open")).toBe(true);
    expect(firstCategoryItem.querySelector(".toc-sublist.hidden")).toBeNull();

    fireEvent.click(firstCategory);
    expect(firstCategoryItem.classList.contains("open")).toBe(false);
    expect(
      firstCategoryItem.querySelector(".toc-sublist.hidden"),
    ).not.toBeNull();

    expect(document.querySelector(".toc-item a")?.textContent).toMatch(
      /\b\d+\/\d+\b/,
    );

    const headings = document.querySelectorAll<HTMLElement>(
      "#allprogress-grid h3",
    );
    expect(headings.length).toBeGreaterThan(1);
    const targetHeading = headings[1];
    if (targetHeading === undefined) {
      throw new Error("Expected second progress category heading to exist.");
    }
    intersectionState.callback?.(
      [createIntersectionEntry(targetHeading)],
      new MockIntersectionObserver(),
    );

    const activeLink = document.querySelector(".toc-item a.active");
    expect(activeLink?.getAttribute("href")).toBe(`#${targetHeading.id}`);
    expect(
      activeLink?.closest(".toc-category")?.classList.contains("open"),
    ).toBe(true);
    expect(document.querySelectorAll(".toc-category.open").length).toBe(1);
  });

  it("keeps the progress legend in the progress view and persists its collapsed state", () => {
    const { unmount } = render(() => <App />);

    const progressSection = getRequiredElement("#allprogress-section");
    const legend = progressSection.querySelector(".progress-legend");
    expect(legend).not.toBeNull();
    expect(
      document.querySelector(".toc-container .progress-legend"),
    ).toBeNull();
    expect(screen.getByText("Upgrade of another tool")).toBeDefined();

    const collapseButton = getRequiredElement(".progress-legend-toggle");
    expect(collapseButton.getAttribute("aria-label")).toBe("Collapse legend");
    fireEvent.click(collapseButton);
    expect(screen.queryByText("Upgrade of another tool")).toBeNull();
    expect(localStorage.getItem("progressLegendCollapsed")).toBe("true");

    unmount();
    cleanup();
    render(() => <App />);

    expect(screen.queryByText("Upgrade of another tool")).toBeNull();
    expect(
      getRequiredElement(".progress-legend-toggle").getAttribute("aria-label"),
    ).toBe("Expand legend");
  });

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

  it("shows progress item map locations in the shared interactive map canvas", () => {
    render(() => <App />);

    fireEvent.click(getRequiredElement("#progress-bell_beast"));

    const modal = getRequiredElement("#info-overlay");
    const canvas = modal.querySelector(".interactive-map-canvas");
    if (canvas === null) {
      throw new Error("Expected modal map canvas to exist.");
    }

    expect(canvas.classList.contains("interactive-map-canvas-modal")).toBe(
      true,
    );
    expect(canvas.querySelector("img")?.getAttribute("src")).toContain(
      "labelled_map_act3.png",
    );
    expect(
      canvas.querySelector<HTMLElement>('.map-pin[aria-label="Bell Beast"]'),
    ).not.toBeNull();

    const image = canvas.querySelector<HTMLImageElement>(
      ".interactive-map-image",
    );
    const stage = canvas.querySelector<HTMLElement>(".interactive-map-stage");
    if (image === null || stage === null) {
      throw new Error("Expected modal map image and stage to exist.");
    }

    setReadonlyNumberProperty(canvas, "clientWidth", 100);
    setReadonlyNumberProperty(canvas, "clientHeight", 50);
    setReadonlyNumberProperty(image, "naturalWidth", 100);
    setReadonlyNumberProperty(image, "naturalHeight", 100);
    fireEvent.load(image);

    const transform = parseMapTransform(stage.style.transform);
    expect(transform.x).toBeCloseTo(42.4);
    expect(transform.y).toBeCloseTo(-34);
    expect(transform.scale).toBe(2);
  });

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

function createIntersectionEntry(target: Element): IntersectionObserverEntry {
  const rect = target.getBoundingClientRect();

  return {
    boundingClientRect: rect,
    intersectionRatio: 1,
    intersectionRect: rect,
    isIntersecting: true,
    rootBounds: rect,
    target,
    time: 0,
  };
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[$()*+.?[\\\]^{|}]/g, String.raw`\$&`);
}

function setReadonlyNumberProperty(
  object: object,
  property: "clientHeight" | "clientWidth" | "naturalHeight" | "naturalWidth",
  value: number,
) {
  Object.defineProperty(object, property, { configurable: true, value });
}

function parseMapTransform(value: string): {
  readonly scale: number;
  readonly x: number;
  readonly y: number;
} {
  const match =
    /translate3d\((?<x>-?\d+(?:\.\d+)?)px, (?<y>-?\d+(?:\.\d+)?)px, 0\) scale\((?<scale>\d+(?:\.\d+)?)\)/u.exec(
      value,
    );
  const groups = match?.groups;
  if (
    groups?.["x"] === undefined
    || groups["y"] === undefined
    || groups["scale"] === undefined
  ) {
    throw new Error(`Expected map transform, got ${value}.`);
  }

  return {
    scale: Number(groups["scale"]),
    x: Number(groups["x"]),
    y: Number(groups["y"]),
  };
}
