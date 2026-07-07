import { onCleanup, onMount } from "solid-js";

export function useMapPanZoom(input: {
  readonly getImage: () => HTMLImageElement | undefined;
  readonly getStage: () => HTMLElement | undefined;
  readonly getWrapper: () => HTMLElement | undefined;
}): void {
  onMount(() => {
    const image = input.getImage();
    const stage = input.getStage();
    const wrapper = input.getWrapper();
    if (image === undefined || stage === undefined || wrapper === undefined) {
      return;
    }

    let scale = 1;
    let minScale = 1;
    let translateX = 0;
    let translateY = 0;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    const applyTransform = () => {
      stage.style.transform = `translate(-50%, -50%) translate3d(${translateX}px, ${translateY}px, 0) scale(${scale})`;
    };

    const fitToScreen = () => {
      if (image.naturalWidth === 0 || wrapper.clientWidth === 0) {
        return;
      }

      minScale =
        Math.min(
          wrapper.clientWidth / image.naturalWidth,
          wrapper.clientHeight / image.naturalHeight,
        ) * 0.9;
      scale = minScale;
      translateX = 0;
      translateY = 0;
      applyTransform();
    };

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(fitToScreen);
    resizeObserver?.observe(wrapper);
    image.addEventListener("load", fitToScreen);

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
      scale = Math.max(minScale, Math.min(scale * factor, 6));
      applyTransform();
    };

    const onPointerDown = (event: PointerEvent) => {
      if (
        event.button !== 0
        || (event.target as HTMLElement).closest(".map-pin")
      ) {
        return;
      }

      event.preventDefault();
      dragging = true;
      lastX = event.clientX;
      lastY = event.clientY;
      wrapper.setPointerCapture(event.pointerId);
      wrapper.style.cursor = "grabbing";
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!dragging) {
        return;
      }

      event.preventDefault();
      translateX += event.clientX - lastX;
      translateY += event.clientY - lastY;
      lastX = event.clientX;
      lastY = event.clientY;
      applyTransform();
    };

    const stopDrag = (event: PointerEvent) => {
      dragging = false;
      try {
        wrapper.releasePointerCapture(event.pointerId);
      } catch {
        // Pointer capture may already be released by the browser.
      }
      wrapper.style.cursor = "";
    };

    wrapper.style.userSelect = "none";
    wrapper.style.touchAction = "none";
    wrapper.addEventListener("wheel", onWheel, { passive: false });
    wrapper.addEventListener("pointerdown", onPointerDown);
    wrapper.addEventListener("pointermove", onPointerMove);
    wrapper.addEventListener("pointerup", stopDrag);
    wrapper.addEventListener("pointercancel", stopDrag);
    wrapper.addEventListener("pointerleave", stopDrag);
    fitToScreen();

    onCleanup(() => {
      resizeObserver?.disconnect();
      image.removeEventListener("load", fitToScreen);
      wrapper.removeEventListener("wheel", onWheel);
      wrapper.removeEventListener("pointerdown", onPointerDown);
      wrapper.removeEventListener("pointermove", onPointerMove);
      wrapper.removeEventListener("pointerup", stopDrag);
      wrapper.removeEventListener("pointercancel", stopDrag);
      wrapper.removeEventListener("pointerleave", stopDrag);
    });
  });
}
