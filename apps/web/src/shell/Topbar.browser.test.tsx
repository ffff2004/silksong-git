import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";

import { App } from "../app/App.tsx";
import { browserRuntimeCapabilities } from "../runtime-capabilities/browser.ts";
import decodedSave from "../test-fixtures/mask-shard-2-collected-rosaries-save.decoded.json";
// Browser tests render App directly, so load the production root stylesheet.
// eslint-disable-next-line import-x/no-unassigned-import
import "../app/global.css";

afterEach(() => {
  cleanup();
  localStorage.clear();
  globalThis.location.hash = "";
});

it("moves the complete control group below ModeBanner when space is insufficient", async () => {
  await page.viewport(1600, 800);
  render(() => <App runtimeCapabilities={browserRuntimeCapabilities} />);

  await userEvent.click(page.getByRole("button", { name: "Upload save" }));
  await userEvent.upload(
    requireFileInput("#fileInput"),
    new File([JSON.stringify(decodedSave)], "save.json", {
      type: "application/json",
    }),
  );
  await expect.element(page.getByText("NORMAL SAVE LOADED")).toBeVisible();
  await document.fonts.ready;

  await setViewport(1600);
  assertTopbarLayout("same-row");

  await setViewport(900);
  assertTopbarLayout("controls-below");
});

async function setViewport(width: number) {
  await page.viewport(width, 800);
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        resolve();
      });
    });
  });
}

function assertTopbarLayout(expected: "same-row" | "controls-below") {
  const banner = requireHTMLElement("#modeBanner");
  const controls = requireHTMLElement(
    '[aria-label="Save and preference controls"]',
  );
  const topbar = requireHTMLElement("header");
  const main = requireHTMLElement("#main");
  const bannerRect = banner.getBoundingClientRect();
  const controlsRect = controls.getBoundingClientRect();

  expect(rectanglesIntersect(bannerRect, controlsRect)).toBe(false);

  if (expected === "same-row") {
    expect(controlsRect.top).toBeLessThan(bannerRect.bottom);
    expect(bannerRect.right).toBeLessThanOrEqual(controlsRect.left);
  } else {
    expect(controlsRect.top).toBeGreaterThanOrEqual(bannerRect.bottom);
  }

  for (const element of topbar.querySelectorAll<HTMLElement>("*")) {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const isVisible =
      style.display !== "none"
      && style.visibility !== "hidden"
      && rect.width > 0
      && rect.height > 0;

    if (isVisible) {
      expect(rect.top).toBeGreaterThanOrEqual(0);
    }
  }

  expect(main.getBoundingClientRect().bottom).toBeCloseTo(
    globalThis.innerHeight,
    1,
  );
}

function rectanglesIntersect(first: DOMRect, second: DOMRect): boolean {
  return !(
    first.right <= second.left
    || second.right <= first.left
    || first.bottom <= second.top
    || second.bottom <= first.top
  );
}

function requireFileInput(selector: string): HTMLInputElement {
  const element = document.querySelector(selector);

  if (!(element instanceof HTMLInputElement)) {
    throw new TypeError(`Expected HTMLInputElement: ${selector}`);
  }

  return element;
}

function requireHTMLElement(selector: string): HTMLElement {
  const element = document.querySelector(selector);

  if (!(element instanceof HTMLElement)) {
    throw new TypeError(`Expected HTMLElement: ${selector}`);
  }

  return element;
}
