import { getBuiltinMappingData } from "@silksong-git/core";
import { assertArray } from "complete-common";
import { getStoredActFilter } from "../components/acts-dropdown.ts";
import { showOnlyMissing } from "../components/show-only-missing.ts";
import { showSpoilers } from "../components/show-spoilers.ts";
import { BASE_PATH } from "../constants.ts";

import {
  allProgressGrid,
  getHTMLElement,
  getHTMLElements,
  infoContent,
  infoOverlay,
  tocList,
} from "../elements.ts";
import {
  getSaveData,
  getSaveDataMode,
  getSemanticSnapshotItem,
} from "../save-data.ts";
import type { Category } from "../types/Category.ts";
import type { Item } from "../types/Item.ts";

let tocObserver: IntersectionObserver | undefined;
let isManualScroll = false; // prevent observer interference

function getProgressCategories(categories: unknown): readonly Category[] {
  // Keep the runtime JSON guard meaningful: assert the imported data before treating it as the
  // business type, instead of asserting after a type cast.
  assertArray(
    categories,
    "The contents of one of the JSON files was not an array.",
  );

  return categories as readonly Category[];
}

function getProgressSections(): ReadonlyArray<{
  title: string;
  categories: readonly Category[];
}> {
  const titlesBySectionId = new Map([
    ["bosses", "Bosses"],
    ["completion", "Completion"],
    ["essentials", "Essential Items"],
    ["journal", "Journal"],
    ["main", "Main Progress"],
    ["mini-bosses", "Mini-Bosses"],
    ["scenes", "Rooms"],
    ["wishes", "Wishes"],
  ]);

  return getBuiltinMappingData().sections.map((section) => ({
    title: titlesBySectionId.get(section.id) ?? section.label,
    categories: getProgressCategories(section.categories),
  }));
}

export function updateTabProgress(): void {
  initProgressListeners();
  const spoilerOn = showSpoilers.checked;
  const showMissingOnly = showOnlyMissing.checked;
  allProgressGrid.innerHTML = "";

  const allCategories = getProgressSections();

  for (const { title, categories } of allCategories) {
    const categoryHeader = document.createElement("h2");
    categoryHeader.className = "category-header";
    categoryHeader.textContent = title;
    categoryHeader.style.marginTop = "2rem";
    categoryHeader.style.marginBottom = "1rem";
    allProgressGrid.append(categoryHeader);

    for (const category of categories) {
      const section = document.createElement("div");
      section.className = "main-section-block";

      const heading = document.createElement("h3");
      heading.className = "category-title";
      heading.textContent = category.label;

      const { items } = category;

      const saveData = getSaveData();

      const obtainedGroups = new Set<string>();
      if (saveData !== undefined) {
        for (const i of items) {
          if (!(typeof i.group === "string" && i.group !== "")) {
            continue;
          }

          if (isObtained(i)) {
            obtainedGroups.add(i.group);
          }
        }
      }

      const actFilter = getStoredActFilter();

      let filteredItems = items.filter(
        (item: Item) => actFilter.includes(item.act) && matchMode(item),
      );

      if (showMissingOnly && saveData !== undefined) {
        filteredItems = filteredItems.filter((item: Item) => {
          if (isObtained(item)) {
            return false;
          }

          if (item.unobtainable === true && typeof item.group === "string") {
            return !obtainedGroups.has(item.group);
          }

          if (item.type === "collectable") {
            return getNumericValue(item) === 0;
          }
          if (item.type === "level") {
            return getNumericValue(item) < item.required;
          }
          if (item.type === "quest") {
            return !isDone(item);
          }
          if (item.type === "anyOf") {
            return !isObtained(item);
          }
          return !isDone(item);
        });
      }

      let obtained = 0;
      let total = 0;

      for (const item of filteredItems) {
        const unlocked = saveData !== undefined && isObtained(item);

        if (item.type === "tool" && item.upgradeOf !== undefined) {
          continue;
        }

        if (saveData === undefined) {
          total++;
          continue;
        }

        if (
          item.unobtainable === true
          && typeof item.group === "string"
          && item.group.trim() !== ""
          && filteredItems.some((i) => i.group === item.group && isObtained(i))
          && !unlocked
        ) {
          continue;
        }

        total++;
        if (unlocked) {
          obtained++;
        }
      }

      const count = document.createElement("span");
      count.className = "category-count";
      count.textContent = ` ${obtained}/${total}`;
      heading.append(count);

      section.append(heading);

      const desc = document.createElement("p");
      desc.className = "category-description";
      desc.textContent = category.description;
      section.append(desc);

      const subgrid = document.createElement("div");
      subgrid.className = "grid";

      const visible = renderGenericGrid(subgrid, filteredItems, spoilerOn);

      if (filteredItems.length === 0 || (showMissingOnly && visible === 0)) {
        continue;
      }

      section.append(subgrid);
      allProgressGrid.append(section);
    }
  }

  buildDynamicTOC();
  initScrollSpy();
}

let progressListenerRegistered = false;

function initProgressListeners() {
  if (progressListenerRegistered) {
    return;
  }
  progressListenerRegistered = true;

  globalThis.addEventListener("save-data-changed", () => {
    updateTabProgress();
  });
}

let mapListenerRegistered = false;

function initWorldMapListeners() {
  if (mapListenerRegistered) {
    return;
  }
  mapListenerRegistered = true;

  globalThis.addEventListener("save-data-changed", () => {
    renderWorldMapPins();
  });
}

function getSnapshotValue(item: Item): unknown {
  return getSemanticSnapshotItem(item.id)?.value;
}

function getNumericValue(item: Item): number {
  const value = getSnapshotValue(item);
  return typeof value === "number" ? value : 0;
}

function isDone(item: Item): boolean {
  return getSemanticSnapshotItem(item.id)?.status === "done";
}

function isAccepted(item: Item): boolean {
  return getSemanticSnapshotItem(item.id)?.status === "accepted";
}

function isObtained(item: Item): boolean {
  if (
    item.type === "relic"
    || item.type === "materium"
    || item.type === "device"
  ) {
    return isDone(item) || isAccepted(item);
  }

  return isDone(item);
}

function buildDynamicTOC() {
  tocList.innerHTML = "";

  const headers = getHTMLElements(
    document,
    "#allprogress-grid h2, #allprogress-grid h3",
  );

  let currentCategory: HTMLLIElement | undefined;
  let currentSubList: HTMLUListElement | undefined;

  for (const header of headers) {
    const tag = header.tagName.toLowerCase();
    const text = header.textContent.trim();
    if (text === "") {
      continue;
    }

    if (header.id === "") {
      const cleanId = text
        .toLowerCase()
        .replaceAll(/\s+/g, "-")
        .replaceAll(/[^\w-]/g, "");
      header.id = `section-${cleanId}`;
    }

    if (tag === "h2") {
      const li = document.createElement("li");
      li.className = "toc-category";
      li.dataset["manual"] = "false";

      const a = document.createElement("a");
      a.href = `#${header.id}`;
      a.textContent = text;
      a.addEventListener("click", (e) => {
        e.preventDefault();
        const target = getHTMLElement(header.id);
        target.scrollIntoView({
          behavior: "instant",
          block: "start",
        });

        const wasOpen = li.classList.contains("open");
        const tocCategories = getHTMLElements(document, ".toc-category");
        for (const cat of tocCategories) {
          cat.classList.remove("open");
          cat.querySelector(".toc-sublist")?.classList.add("hidden");
        }
        if (!wasOpen) {
          li.classList.add("open");
          li.querySelector(".toc-sublist")?.classList.remove("hidden");
        }
      });

      li.append(a);
      currentSubList = document.createElement("ul");
      currentSubList.className = "toc-sublist hidden";
      li.append(currentSubList);
      tocList.append(li);
      currentCategory = li;
    } else if (
      tag === "h3"
      && currentCategory !== undefined
      && currentSubList !== undefined
    ) {
      const subLi = document.createElement("li");
      subLi.className = "toc-item";
      const a = document.createElement("a");
      a.href = `#${header.id}`;
      a.textContent = text;
      subLi.append(a);
      currentSubList.append(subLi);
    }
  }

  if (document.querySelector(".toc-legend")) {
    return;
  }

  // Append legend block at the bottom of the TOC.
  const legendBlock = document.createElement("div");
  legendBlock.className = "toc-legend";
  legendBlock.innerHTML = `
    <div class="legend-title">Legend</div>
    <ul class="legend-list">
      <li><i class="fa-solid fa-arrow-up"></i> Upgrade of another tool</li>
      <li><i class="fa-solid fa-code-branch"></i> Mutually exclusive item</li>
      <li><span class="legend-missable">!</span> Missable item</li>
    </ul>
  `;
  tocList.parentElement?.append(legendBlock);
}

function resolveIconSrc(icon: string | undefined): string {
  const clean = (icon ?? "").trim();
  if (clean === "") {
    return "";
  }

  if (clean.startsWith("http") || clean.startsWith("/")) {
    return clean;
  }

  if (clean.startsWith("assets/")) {
    return `${BASE_PATH}/${clean}`;
  }

  return `${BASE_PATH}/assets/${clean}`;
}

function resolveMapImageSrc(src: string): string {
  const clean = src.trim();
  if (clean === "") {
    return "";
  }

  if (clean.startsWith("http") || clean.startsWith("/")) {
    return clean;
  }

  return `${BASE_PATH}/${clean}`;
}

function showGenericModal(item: Item) {
  let mapSrc: string | undefined;
  if (item.map === undefined || item.map === "") {
    mapSrc = undefined;
  } else if (item.map.startsWith("http")) {
    mapSrc = item.map;
  } else {
    mapSrc = `${BASE_PATH}/${item.map}`;
  }

  const pinIconSrc = resolveIconSrc(item.icon);

  infoContent.innerHTML = `
    <button id="modalCloseBtn" class="modal-close">✕</button>
    <img src="${pinIconSrc}" alt="${item.label}" class="info-image">
    <h2 class="info-title">${item.label}</h2>

    <p class="info-description">${item.description}</p>

    ${
      item.type === "journal"
      && typeof item.hornetDescription === "string"
      && item.hornetDescription.trim() !== ""
        ? `
        <img src="${BASE_PATH}/assets/ui/divider_journal.png" alt="divider" class="journal-divider" />
        <p class="hornet-description">${item.hornetDescription}</p>
      `
        : ""
    }

    ${
      item.type === "level" && item.obtain !== undefined
        ? `<p class="info-extra"><strong>Obtained:</strong> ${item.obtain}</p>`
        : ""
    }
    ${
      item.type === "level" && item.cost !== undefined
        ? `<p class="info-extra"><strong>Cost:</strong> ${item.cost}</p>`
        : ""
    }
    ${
      item.type === "collectable" && item.use !== undefined
        ? `<p class="info-extra"><strong>Use:</strong> ${item.use}</p>`
        : ""
    }

${(() => {
  if (item.mapViewer === undefined && (mapSrc === undefined || mapSrc === "")) {
    return "";
  }

  if (item.mapViewer) {
    const pinHtml =
      item.showOnMap === true
        ? `
        <img
          src="${pinIconSrc}"
  class="custom-map-pin"
          style="left:${item.mapViewer.x * 100}%; top:${item.mapViewer.y * 100}%;"
          alt=""
          draggable="false"
        />
      `
        : "";

    return `
  <div class="info-map-wrapper">
    <div class="custom-map-viewer" id="custom-map-${item.id}">
      <div class="custom-map-inner" id="custom-map-inner-${item.id}">
        <img
          src="${resolveMapImageSrc(item.mapViewer.src)}"
          class="custom-map-image"
          id="custom-map-img-${item.id}"
          draggable="false"
          loading="lazy"
        />
        ${pinHtml}
      </div>
    </div>
  </div>
`;
  }

  return `
    <div class="info-map-wrapper">
      <div class="map-loading-overlay">
        <span class="map-loading-text">Loading map...</span>
      </div>
      <iframe
        src="${mapSrc}"
        class="info-map-embed"
        loading="lazy"
        referrerpolicy="no-referrer-when-downgrade"
        allowfullscreen
        onload="this.previousElementSibling.remove()">
      </iframe>
    </div>
  `;
})()}

    ${
      item.link === ""
        ? ""
        : `
        <div class="info-link-wrapper">
          <a href="${item.link}" target="_blank" class="info-link">More info</a>
        </div>
      `
    }
  `;

  infoOverlay.classList.remove("hidden");

  if (item.mapViewer) {
    const viewer = document.querySelector<HTMLElement>(
      `#custom-map-${item.id}`,
    );
    const inner = document.querySelector<HTMLElement>(
      `#custom-map-inner-${item.id}`,
    );
    const img = document.querySelector<HTMLImageElement>(
      `#custom-map-img-${item.id}`,
    );

    if (viewer && inner && img) {
      const { x, y } = item.mapViewer;
      let scale = item.mapViewer.zoom ?? 1;
      let tx = 0;
      let ty = 0;

      const applyTransform = () => {
        inner.style.transform = `translate(-50%, -50%) translate3d(${tx}px, ${ty}px, 0) scale(${scale})`;
      };

      const centerOnXY = () => {
        if (img.naturalWidth === 0 || viewer.clientWidth === 0) {
          return;
        }

        tx = (img.naturalWidth * scale) / 2 - img.naturalWidth * x * scale;
        ty = (img.naturalHeight * scale) / 2 - img.naturalHeight * y * scale;

        applyTransform();
      };

      viewer.addEventListener(
        "wheel",
        (e) => {
          e.preventDefault();
          const rect = viewer.getBoundingClientRect();

          const mouseX = e.clientX - rect.left - rect.width / 2;
          const mouseY = e.clientY - rect.top - rect.height / 2;

          const prevScale = scale;
          const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
          const newScale = Math.min(6, Math.max(0.2, scale * factor));

          if (newScale !== prevScale) {
            const actualFactor = newScale / prevScale;
            tx = mouseX - (mouseX - tx) * actualFactor;
            ty = mouseY - (mouseY - ty) * actualFactor;
            scale = newScale;
          }
          applyTransform();
        },
        { passive: false },
      );

      let dragging = false;
      let lastX = 0;
      let lastY = 0;

      viewer.addEventListener("pointerdown", (e) => {
        dragging = true;
        lastX = e.clientX;
        lastY = e.clientY;
        viewer.setPointerCapture(e.pointerId);
      });

      viewer.addEventListener("pointermove", (e) => {
        if (!dragging) {
          return;
        }
        tx += e.clientX - lastX;
        ty += e.clientY - lastY;
        lastX = e.clientX;
        lastY = e.clientY;
        applyTransform();
      });

      const stopDrag = (e: PointerEvent) => {
        dragging = false;
        try {
          viewer.releasePointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
      };
      viewer.addEventListener("pointerup", stopDrag);
      viewer.addEventListener("pointercancel", stopDrag);

      const onReady = () => {
        setTimeout(centerOnXY, 10);
      };

      if (img.complete && img.naturalWidth > 0) {
        onReady();
      } else {
        img.addEventListener("load", onReady, { once: true });
      }
    }
  }

  // Attach listener to the *newly created* close button.
  const modalCloseBtn = document.querySelector("#modalCloseBtn");
  if (modalCloseBtn) {
    modalCloseBtn.addEventListener("click", () => {
      infoOverlay.classList.add("hidden");
    });
  }
}

/**
 * Renders a grid of items (e.g. bosses, relics, tools, etc.) with their unlock states.
 *
 * @returns The number of items rendered.
 */
function renderGenericGrid(
  containerElement: HTMLElement,
  items: readonly Item[],
  spoilerOn: boolean,
): number {
  containerElement.innerHTML = "";

  const saveData = getSaveData();

  const obtainedGroups = new Set<string>();
  for (const i of items) {
    if (typeof i.group === "string" && i.group.trim() !== "" && isObtained(i)) {
      obtainedGroups.add(i.group);
    }
  }

  let renderedCount = 0;

  for (const item of items) {
    let flag: string | undefined;
    if (item.type === "sceneVisited" || item.type === "anyOf") {
      flag = undefined;
    } else if (item.type === "key" && "flags" in item && item.flags) {
      flag = item.flags.join("|");
    } else {
      const { flag: itemFlag } = item;
      flag = itemFlag;
    }

    const div = document.createElement("div");
    div.className = "boss";

    // Upgrade marker (only for tools that are upgrades of other ones).
    if (item.type === "tool" && item.upgradeOf !== undefined) {
      const upgradeIcon = document.createElement("span");
      upgradeIcon.className = "upgrade-icon";
      upgradeIcon.title = "Upgrade of another tool";
      upgradeIcon.innerHTML = '<i class="fa-solid fa-arrow-up"></i>';
      div.append(upgradeIcon);
    }

    // Act label (ACT I / II / III).
    const romanActs = { 1: "I", 2: "II", 3: "III" };
    const actLabel = document.createElement("span");
    actLabel.className = `act-label act-${item.act}`;
    actLabel.textContent = `ACT ${romanActs[item.act]}`;
    div.append(actLabel);

    div.id = `${containerElement.id}-${item.id}`;
    div.dataset["flag"] = flag;
    if (typeof item.group === "string" && item.group.trim() !== "") {
      div.dataset["group"] = item.group;
    }

    const img = document.createElement("img");
    img.alt = item.label;

    const done = isDone(item);
    const accepted = isAccepted(item);

    // Unobtainable icon
    if (item.unobtainable === true) {
      const unob = document.createElement("span");
      unob.className = "missable-icon unobtainable-icon";
      unob.title = "Mutually exclusive item  only one of these can be obtained";
      unob.innerHTML = '<i class="fa-solid fa-code-branch"></i>';
      div.append(unob);
    }

    if (
      saveData !== undefined
      && item.unobtainable === true
      && typeof item.group === "string"
      && obtainedGroups.has(item.group)
      && !done
    ) {
      div.classList.add("unobtainable", "done");
    }

    // Hide done items if "Only Missing" is checked.
    if (showOnlyMissing.checked && isObtained(item)) {
      continue;
    }

    // Missable icon
    if (item.missable === true) {
      const warn = document.createElement("span");
      warn.className = "missable-icon";
      warn.title = "Missable item - can be permanently lost";
      warn.textContent = "!";
      div.append(warn);
    }

    // Icon handling
    const iconPath = resolveIconSrc(item.icon);
    const lockedPath = `${BASE_PATH}/assets/icons/locked.png`;

    if (done) {
      img.src = iconPath;
      div.classList.add("done");
    } else if (accepted) {
      img.src = iconPath;
      div.classList.add("accepted");
    } else if (item.unobtainable === true && saveData !== undefined) {
      img.src = iconPath;
      div.classList.add("unobtainable");
    } else if (spoilerOn) {
      img.src = iconPath;
      div.classList.add("unlocked");
    } else {
      img.src = lockedPath;
      div.classList.add("locked");

      div.addEventListener("mouseenter", () => {
        img.src = iconPath;
        div.classList.remove("locked");
      });

      div.addEventListener("mouseleave", () => {
        img.src = lockedPath;

        // eslint-disable-next-line no-void
        void img.offsetWidth;

        div.classList.add("locked");
      });
    }

    // Title
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = item.label;
    div.append(img, title);

    // Journal counter
    if (item.type === "journal") {
      const current = getNumericValue(item);
      const counter = document.createElement("span");
      counter.className = "journal-counter";
      counter.textContent =
        current >= item.required ? `${current}` : `${current}/${item.required}`;
      div.append(counter);
    }

    div.addEventListener("click", () => {
      showGenericModal(item);
    });

    containerElement.append(div);
    renderedCount++;
  }

  return renderedCount;
}

function initScrollSpy() {
  const tocLinks = getHTMLElements(document, ".toc-item a, .toc-category > a");

  // Prevent duplicate observers
  if (tocObserver !== undefined) {
    tocObserver.disconnect();
  }

  const updateTocState = (targetId: string) => {
    const match = document.querySelector(`a[href="#${CSS.escape(targetId)}"]`);
    if (!match) {
      return;
    }

    const parentCategory = match.closest(".toc-category");

    // Update active link
    for (const link of tocLinks) {
      link.classList.remove("active");
    }
    match.classList.add("active");

    // Update category visibility
    const tocCategories = getHTMLElements(document, ".toc-category");
    for (const category of tocCategories) {
      const sublist = category.querySelector(".toc-sublist");
      if (category === parentCategory) {
        category.classList.add("open");
        sublist?.classList.remove("hidden");
      } else {
        category.classList.remove("open");
        sublist?.classList.add("hidden");
      }
    }
  };

  // Create IntersectionObserver for automatic scroll highlighting.
  tocObserver = new IntersectionObserver(
    (entries: readonly IntersectionObserverEntry[]) => {
      if (isManualScroll) {
        return;
      } // Skip updates during manual scroll

      for (const entry of entries) {
        if (!entry.isIntersecting) {
          continue;
        }

        updateTocState(entry.target.id);
        break;
      }
    },
    {
      threshold: 0.6, // At least 60% visible is required
      rootMargin: "-10% 0px -40% 0px", // Delays the change slightly
    },
  );

  const handleTocClick = (event: Event) => {
    event.preventDefault();

    const href = (event.currentTarget as HTMLAnchorElement).getAttribute(
      "href",
    );
    if (href === null || !href.startsWith("#")) {
      return;
    }

    const targetId = href.replace("#", "");
    const targetElement = document.querySelector<HTMLElement>(`#${targetId}`); // adding # to get by id
    if (!targetElement) {
      return;
    }

    // Prevent observer from overriding click highlight.
    isManualScroll = true;
    updateTocState(targetId);

    targetElement.scrollIntoView({ behavior: "instant" });

    // Reenable observer slightly after scroll completes.
    setTimeout(() => {
      isManualScroll = false;
    }, 800); // adjust if your scroll is slower/faster
  };

  // Attach click listeners
  for (const link of tocLinks) {
    link.removeEventListener("click", handleTocClick); // Prevent duplicate
    link.addEventListener("click", handleTocClick);
  }

  // Observe all headers
  const headers = getHTMLElements(
    document,
    "#allprogress-grid h2, #allprogress-grid h3",
  );
  for (const section of headers) {
    tocObserver.observe(section);
  }
}

function matchMode(item: Item) {
  const { mode } = item;

  // No mode -> always visible.
  if (mode === undefined) {
    return true;
  }

  // BEFORE loading a save > show all.
  const saveData = getSaveData();
  if (saveData === undefined) {
    return true;
  }

  // AFTER loading > match mode.
  const saveDataMode = getSaveDataMode();
  return mode === saveDataMode;
}

function collectAllItems(): readonly Item[] {
  const categories = getProgressSections().flatMap(
    (section) => section.categories,
  );

  return categories.flatMap((c) => c.items);
}

function renderWorldMapPins() {
  const img = document.querySelector<HTMLImageElement>("#worldMap");
  const overlay = document.querySelector<HTMLDivElement>("#mapPinsOverlay");
  const searchInput = document.querySelector<HTMLInputElement>("#map-search");
  const searchCount = document.querySelector<HTMLElement>("#map-search-count");

  if (searchInput) {
    searchInput.addEventListener("input", renderWorldMapPins);
  }
  if (!img || !overlay) {
    return;
  }

  overlay.innerHTML = "";

  const currentSrc = img.getAttribute("src") ?? "";
  const currentResolved = resolveMapImageSrc(currentSrc);
  const searchTerm = searchInput ? searchInput.value.trim().toLowerCase() : "";

  const items = collectAllItems();
  const saveData = getSaveData();
  const activeFilters = new Set<string>();

  // eslint-disable-next-line unicorn/prefer-spread
  const nodes = Array.from(
    document.querySelectorAll<HTMLInputElement>("#map-filters input:checked"),
  );

  for (const el of nodes) {
    const val = el.dataset["category"];
    if (typeof val === "string") {
      activeFilters.add(val);
    }
  }

  let matchCount = 0;

  for (const item of items) {
    if (
      item.showOnMap !== true
      || typeof item.mapCategory !== "string"
      || !activeFilters.has(item.mapCategory)
    ) {
      continue;
    }

    if (searchTerm !== "" && !fuzzyMatch(item.label, searchTerm)) {
      continue;
    }

    if (!item.mapViewer) {
      continue;
    }

    const itemMapResolved = resolveMapImageSrc(item.mapViewer.src);
    if (itemMapResolved !== currentResolved) {
      continue;
    }

    const pinSrc = resolveIconSrc(item.icon);
    if (pinSrc === "") {
      continue;
    }

    matchCount++;

    const pin = document.createElement("img");
    pin.className = "map-pin";
    pin.src = pinSrc;
    pin.alt = "";
    pin.draggable = false;
    pin.style.left = `${item.mapViewer.x * 100}%`;
    pin.style.top = `${item.mapViewer.y * 100}%`;

    if (saveData !== undefined && isObtained(item)) {
      pin.classList.add("obtained");
    }

    pin.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      showGenericModal(item);
    });

    overlay.append(pin);
  }

  if (searchCount) {
    searchCount.textContent =
      searchTerm === ""
        ? ""
        : `${matchCount} result${matchCount === 1 ? "" : "s"}`;
  }
}

function formatLabel(slug: string): string {
  return slug
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function fuzzyMatch(text: string, pattern: string): boolean {
  if (pattern === "") {
    return true;
  }
  const t = text.toLowerCase();
  const p = pattern.toLowerCase();

  // Always prefer substring match first.
  if (t.includes(p)) {
    return true;
  }

  // Only allow fuzzy for patterns of 3+ chars to avoid noise.
  if (p.length < 3) {
    return false;
  }

  let pi = 0;
  let firstMatch = -1;
  let lastMatch = -1;
  for (let ti = 0; ti < t.length && pi < p.length; ti++) {
    if (t[ti] !== p[pi]) {
      continue;
    }

    if (firstMatch === -1) {
      firstMatch = ti;
    }
    lastMatch = ti;
    pi++;
  }
  if (pi < p.length) {
    return false;
  }

  const spanRatio = (lastMatch - firstMatch + 1) / t.length;
  return spanRatio < 0.5;
}

function generateFilterCheckboxes() {
  const container = document.querySelector<HTMLElement>("#map-filters");
  if (!container) {
    return;
  }

  container.innerHTML = "";

  const allItems = collectAllItems();
  const uniqueCategories = new Set<string>();

  for (const item of allItems) {
    if (
      typeof item.mapCategory === "string"
      && item.mapCategory.trim() !== ""
    ) {
      uniqueCategories.add(item.mapCategory);
    }
  }

  const categoriesList = [...uniqueCategories];

  for (const category of categoriesList) {
    const label = document.createElement("label");
    label.className = "filter-item";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.dataset["category"] = category;
    input.checked = true;

    const span = document.createElement("span");
    span.textContent = formatLabel(category);

    label.append(input, span);
    container.append(label);
  }
}
export function initWorldMapPins(): void {
  initWorldMapListeners();

  const select = document.querySelector<HTMLSelectElement>("#map-act-select");
  const img = document.querySelector<HTMLImageElement>("#worldMap");
  const overlay = document.querySelector<HTMLDivElement>("#mapPinsOverlay");
  const pinsToggle = document.querySelector<HTMLInputElement>("#show-map-pins");

  if (!select || !img || !overlay) {
    return;
  }

  generateFilterCheckboxes();

  if (pinsToggle) {
    const applyPinsVisibility = () => {
      overlay.classList.toggle("hidden", !pinsToggle.checked);
    };
    pinsToggle.addEventListener("change", applyPinsVisibility);
    applyPinsVisibility();
  }

  // eslint-disable-next-line unicorn/prefer-spread
  const categoryFilters = Array.from(
    document.querySelectorAll<HTMLInputElement>("#map-filters input"),
  );

  for (const input of categoryFilters) {
    input.addEventListener("change", () => {
      renderWorldMapPins();
    });
  }

  document.querySelector("#hide-all-filters")?.addEventListener("click", () => {
    for (const categoryFilter of categoryFilters) {
      categoryFilter.checked = false;
    }
    renderWorldMapPins();
  });

  document.querySelector("#show-all-filters")?.addEventListener("click", () => {
    for (const categoryFilter of categoryFilters) {
      categoryFilter.checked = true;
    }
    renderWorldMapPins();
  });

  const setMapFromSelect = () => {
    const v = select.value.trim();
    img.src =
      v.startsWith("http") || v.startsWith("/") ? v : resolveMapImageSrc(v);
  };

  select.addEventListener("change", () => {
    setMapFromSelect();
    img.addEventListener(
      "load",
      () => {
        renderWorldMapPins();
      },
      { once: true },
    );
  });

  img.addEventListener("load", () => {
    renderWorldMapPins();
  });

  if (img.complete) {
    renderWorldMapPins();
  } else {
    setMapFromSelect();
  }
}
