import {
  For,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
} from "solid-js";

import { usePreferencesStore } from "../../state/preferences-store.tsx";
import { useSaveStore } from "../../state/save-store.tsx";
import {
  getProgressSectionTitle,
  getVisibleCategoryView,
} from "./progress-selectors.ts";
import type {
  ProgressItemData,
  ProgressSectionData,
} from "./progress-types.ts";
import { toHeadingId } from "./ProgressSection.tsx";

interface ProgressTocProps {
  readonly sections: readonly ProgressSectionData[];
}

export function ProgressToc(props: ProgressTocProps) {
  const saveStore = useSaveStore();
  const preferences = usePreferencesStore();
  const [activeHeadingId, setActiveHeadingId] = createSignal<string>();
  const [openSectionId, setOpenSectionId] = createSignal<string>();

  const visibleSections = createMemo(() =>
    props.sections
      .map((section) => {
        const title = getProgressSectionTitle(section);
        const sectionId = toHeadingId(title);
        const categories = section.categories
          .map((category) => {
            const view = getVisibleCategoryView({
              category,
              hasSave: saveStore.hasSave(),
              isObtained,
              mode: saveStore.mode(),
              sectionTitle: title,
              selectedActs: preferences.selectedActs(),
              showOnlyMissing: preferences.showOnlyMissing(),
            });
            if (view === undefined) {
              return undefined;
            }

            return {
              headingId: toHeadingId(`${title} ${category.label}`),
              view,
            };
          })
          .filter((category) => category !== undefined);

        return { categories, sectionId, title };
      })
      .filter((section) => section.categories.length > 0),
  );

  createEffect(() => {
    visibleSections();

    if (typeof IntersectionObserver === "undefined") {
      return;
    }

    const observer = createTocIntersectionObserver(updateTocState);

    for (const heading of document.querySelectorAll<HTMLElement>(
      "#allprogress-grid h2, #allprogress-grid h3",
    )) {
      observer.observe(heading);
    }

    onCleanup(() => {
      observer.disconnect();
    });
  });

  return (
    <nav id="toc" class="toc-container">
      <ul id="toc-list">
        <For each={visibleSections()}>
          {(entry) => (
            <li
              class="toc-category"
              classList={{ open: openSectionId() === entry.sectionId }}
            >
              <a
                href={`#${entry.sectionId}`}
                classList={{ active: activeHeadingId() === entry.sectionId }}
                onClick={(event) => {
                  event.preventDefault();
                  if (openSectionId() === entry.sectionId) {
                    setOpenSectionId(undefined);
                    return;
                  }

                  scrollToHeading(entry.sectionId);
                  setActiveHeadingId(entry.sectionId);
                  setOpenSectionId(entry.sectionId);
                }}
              >
                {entry.title}
              </a>
              <ul
                class="toc-sublist"
                classList={{ hidden: openSectionId() !== entry.sectionId }}
              >
                <For each={entry.categories}>
                  {(categoryEntry) => (
                    <li class="toc-item">
                      <a
                        href={`#${categoryEntry.headingId}`}
                        classList={{
                          active: activeHeadingId() === categoryEntry.headingId,
                        }}
                        onClick={(event) => {
                          event.preventDefault();
                          scrollToHeading(categoryEntry.headingId);
                          setActiveHeadingId(categoryEntry.headingId);
                          setOpenSectionId(entry.sectionId);
                        }}
                      >
                        {categoryEntry.view.category.label}
                        <span class="category-count">
                          {" "}
                          {categoryEntry.view.obtained}/
                          {categoryEntry.view.total}
                        </span>
                      </a>
                    </li>
                  )}
                </For>
              </ul>
            </li>
          )}
        </For>
      </ul>
    </nav>
  );

  function isObtained(item: ProgressItemData): boolean {
    const status = saveStore.semanticItem(item.id)?.status;
    if (
      item.type === "relic"
      || item.type === "materium"
      || item.type === "device"
    ) {
      return status === "done" || status === "accepted";
    }

    return status === "done";
  }

  function updateTocState(headingId: string) {
    const sectionId = findSectionId(headingId);
    if (sectionId === undefined) {
      return;
    }

    setActiveHeadingId(headingId);
    setOpenSectionId(sectionId);
  }

  function findSectionId(headingId: string): string | undefined {
    for (const section of visibleSections()) {
      if (section.sectionId === headingId) {
        return section.sectionId;
      }

      if (
        section.categories.some((category) => category.headingId === headingId)
      ) {
        return section.sectionId;
      }
    }

    return undefined;
  }
}

function scrollToHeading(headingId: string) {
  const heading = document.querySelector<HTMLElement>(`#${headingId}`);
  if (heading === null) {
    return;
  }

  if (typeof heading.scrollIntoView !== "function") {
    return;
  }

  heading.scrollIntoView({ behavior: "instant", block: "start" });
}

function createTocIntersectionObserver(
  onHeadingIntersected: (headingId: string) => void,
): IntersectionObserver {
  const handleIntersectionObserver = (
    entries: readonly IntersectionObserverEntry[],
  ) => {
    const headingId = getFirstIntersectingHeadingId(entries);
    if (headingId !== undefined) {
      onHeadingIntersected(headingId);
    }
  };

  return new IntersectionObserver(handleIntersectionObserver, {
    rootMargin: "-10% 0px -40% 0px",
    threshold: 0.6,
  });
}

function getFirstIntersectingHeadingId(
  entries: readonly IntersectionObserverEntry[],
): string | undefined {
  return entries.find((entry) => entry.isIntersecting)?.target.id;
}
