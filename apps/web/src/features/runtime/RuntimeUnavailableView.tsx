import type { DesktopRuntimeStartup } from "../../runtime-capabilities/interface.ts";
import viewStyles from "../../ui/View.module.css";

type RuntimeUnavailableStartup = Extract<
  DesktopRuntimeStartup,
  { readonly kind: "unavailable" }
>;

export function RuntimeUnavailableView(props: {
  readonly startup: RuntimeUnavailableStartup;
}) {
  return (
    <main
      aria-label="Application content"
      data-testid="runtime-unavailable"
      class={viewStyles["view"]}
    >
      <section>
        <h1 class={viewStyles["heading"]}>Runtime unavailable</h1>
        <p role="alert">{props.startup.message}</p>
        <p>Local History and local save inspection are unavailable.</p>
        <p>Repair the Desktop installation and restart the application.</p>
        <p>Check: {props.startup.code}</p>
        {props.startup.cleanupIncomplete && (
          <p role="alert">
            Desktop could not confirm complete startup cleanup.
          </p>
        )}
      </section>
    </main>
  );
}
