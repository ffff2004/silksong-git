import { lintCommands } from "complete-node";

import { checkForIllegalCharacters } from "./lint/illegal-characters.ts";
import { checkWebJSONFiles, checkWebJSONSchemas } from "./lint/web-json.ts";

await lintCommands(import.meta.dirname, [
  // Use TypeScript to type-check the code.
  "tsc --noEmit",
  "tsc --noEmit --project ./scripts/tsconfig.json",

  // Use ESLint to lint the code.
  // - "--max-warnings 0" makes warnings fail, since we set all ESLint errors to warnings.
  "eslint --max-warnings 0 .",
  "eslint --max-warnings 0 --config eslint.config.json.mjs apps/web/src/data/*.json",

  // Use Prettier to check formatting.
  // - "--log-level=warn" makes it only output errors.
  "prettier --log-level=warn --check .",

  // Use Knip to check for unused files, exports, and dependencies.
  // - "--treat-config-hints-as-errors" - Exit with non-zero code (1) if there are any configuration
  //   hints.
  "knip --treat-config-hints-as-errors",

  // Use stylelint to lint the CSS.
  "stylelint ./apps/web/public/assets/css/style.css",

  // Ensure that the Web data JSON files satisfy their schemas.
  ["check Web JSON schemas", checkWebJSONSchemas()],

  // Ensure that certain characters do not appear in any files.
  ["check for illegal characters", checkForIllegalCharacters()],

  // Ensure that the Web data JSON files adhere to certain quality standards.
  ["check Web JSON files", checkWebJSONFiles()],
]);
