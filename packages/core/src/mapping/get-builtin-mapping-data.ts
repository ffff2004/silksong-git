import bossesJSON from "../data/bosses.json" with { type: "json" };
import completionJSON from "../data/completion.json" with { type: "json" };
import essentialsJSON from "../data/essentials.json" with { type: "json" };
import journalJSON from "../data/journal.json" with { type: "json" };
import mainJSON from "../data/main.json" with { type: "json" };
import miniBossesJSON from "../data/mini-bosses.json" with { type: "json" };
import scenesJSON from "../data/scenes.json" with { type: "json" };
import wishesJSON from "../data/wishes.json" with { type: "json" };

import type { MappingData } from "../types.ts";

export function getBuiltinMappingData(): MappingData {
  return {
    version: "web-current",
    sections: [
      createSection("main", "Main", mainJSON),
      createSection("essentials", "Essentials", essentialsJSON),
      createSection("bosses", "Bosses", bossesJSON),
      createSection("mini-bosses", "Mini-Bosses", miniBossesJSON),
      createSection("completion", "Completion", completionJSON),
      createSection("wishes", "Wishes", wishesJSON),
      createSection("journal", "Journal", journalJSON),
      createSection("scenes", "Scenes", scenesJSON),
    ],
  };
}

function createSection(
  id: string,
  label: string,
  table: { readonly categories: unknown },
): MappingData["sections"][number] {
  return {
    id,
    label,
    categories:
      table.categories as MappingData["sections"][number]["categories"],
  };
}
