const APP_ENTRY_PLACEHOLDER = "__SILKSONG_GIT_APP_ENTRY__";
const COMPOSITION_PLACEHOLDER = "__SILKSONG_GIT_COMPOSITION__";

export function selectCompositionRoot(html: string, mode: string): string {
  assertSinglePlaceholder(html, APP_ENTRY_PLACEHOLDER);
  assertSinglePlaceholder(html, COMPOSITION_PLACEHOLDER);

  const isDesktop = mode === "desktop";
  return html
    .replace(
      APP_ENTRY_PLACEHOLDER,
      isDesktop ? "/src/desktop-main.tsx" : "/src/main.tsx",
    )
    .replace(COMPOSITION_PLACEHOLDER, isDesktop ? "desktop" : "browser");
}

function assertSinglePlaceholder(html: string, placeholder: string) {
  const firstIndex = html.indexOf(placeholder);
  if (firstIndex === -1 || firstIndex !== html.lastIndexOf(placeholder)) {
    throw new Error(`Expected exactly one ${placeholder} placeholder.`);
  }
}
