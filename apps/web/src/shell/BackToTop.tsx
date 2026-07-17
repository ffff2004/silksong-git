import { createSignal, onCleanup, onMount } from "solid-js";

import { assetUrl } from "../app/asset-url.ts";
import styles from "./BackToTop.module.css";

export function BackToTop() {
  let button: HTMLButtonElement | undefined;
  const [isVisible, setIsVisible] = createSignal(false);

  onMount(() => {
    const main = button?.closest("main");
    if (!(main instanceof HTMLElement)) {
      return;
    }

    const updateVisibility = () => {
      setIsVisible(main.scrollTop > 300);
    };

    main.addEventListener("scroll", updateVisibility);
    updateVisibility();
    onCleanup(() => {
      main.removeEventListener("scroll", updateVisibility);
    });
  });

  return (
    <button
      ref={button}
      id="back-to-top"
      class={styles["button"]}
      type="button"
      aria-label="Back to Top"
      hidden={!isVisible()}
      onClick={() => {
        button?.closest("main")?.scrollTo({ behavior: "instant", top: 0 });
      }}
    >
      <img src={assetUrl("assets/icons/Up_Arrow.png")} alt="" width="50" />
      <span>Top</span>
    </button>
  );
}
