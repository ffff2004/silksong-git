import { assetUrl } from "../app/asset-url.ts";

export function BackToTop() {
  return (
    <button id="back-to-top" type="button">
      <img
        src={assetUrl("assets/icons/Up_Arrow.png")}
        alt="Back to Top"
        width="50"
      />
      <span>Top</span>
    </button>
  );
}
