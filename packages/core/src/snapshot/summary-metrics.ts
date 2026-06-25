import type { DecodedSave, SaveSummaryMetrics } from "../types.ts";
import { getNumber } from "./decoded-save-readers.ts";

export function createSummaryMetrics(
  decodedSave: DecodedSave,
): SaveSummaryMetrics {
  const { playerData } = decodedSave;

  return {
    completionPercentage: getNumber(playerData["completionPercentage"]),
    playTime: getNumber(playerData["playTime"]),
    rosaries: getNumber(playerData["geo"]),
    shellShards: getNumber(playerData["ShellShards"]),
    permadeathMode: playerData["permadeathMode"],
  };
}
