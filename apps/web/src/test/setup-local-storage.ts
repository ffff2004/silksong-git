interface JsdomGlobal {
  readonly jsdom?: {
    readonly window: Window;
  };
}

const jsdomWindow = (globalThis as JsdomGlobal).jsdom?.window;

if (jsdomWindow === undefined) {
  throw new Error("Expected Vitest jsdom environment to be available.");
}

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: jsdomWindow.localStorage,
  writable: true,
});
