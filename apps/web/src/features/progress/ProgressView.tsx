import { useSaveStore } from "../../state/save-store.tsx";
import { ProgressSnapshotView } from "./ProgressSnapshotView.tsx";

export function ProgressView() {
  const saveStore = useSaveStore();

  return <ProgressSnapshotView snapshot={saveStore.snapshot()} />;
}
