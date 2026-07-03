import { lintCommands } from "complete-node";

import {
  checkCoreMappingJSONFiles,
  checkCoreMappingJSONSchemas,
} from "./lint/core-mapping-json.ts";
import { checkForIllegalCharacters } from "./lint/illegal-characters.ts";

await lintCommands(import.meta.dirname, [
  // Use TypeScript to type-check the code.
  "tsc --project ./apps/cli/tsconfig.json",
  "tsc --project ./apps/web/tsconfig.json",
  "tsc --project ./apps/web/tsconfig.node.json",
  "tsc --project ./packages/core/tsconfig.json",
  "tsc --project ./packages/core/tsconfig.node.json",
  "tsc --project ./packages/history/tsconfig.json",
  "tsc --project ./scripts/tsconfig.json",

  // Use ESLint to lint the code.
  // - "--max-warnings 0" makes warnings fail, since we set all ESLint errors to warnings.
  "eslint --cache --cache-location .eslintcache --max-warnings 0 .",
  "eslint --max-warnings 0 --config eslint.config.json.mjs packages/core/src/data/*.json",

  // Use Prettier to check formatting.
  // - "--log-level=warn" makes it only output errors.
  "prettier --log-level=warn --check .",

  // Use Knip to check for unused files, exports, and dependencies.
  // - "--treat-config-hints-as-errors" - Exit with non-zero code (1) if there are any configuration
  //   hints.
  "knip --treat-config-hints-as-errors",

  // Use stylelint to lint the CSS.
  "stylelint ./apps/web/public/assets/css/style.css",

  // Ensure that the core mapping JSON files satisfy their schemas.
  ["check core mapping JSON schemas", checkCoreMappingJSONSchemas()],

  // Ensure that certain characters do not appear in any files.
  ["check for illegal characters", checkForIllegalCharacters()],

  // Ensure that the core mapping JSON files adhere to certain quality standards.
  ["check core mapping JSON files", checkCoreMappingJSONFiles()],
]);
