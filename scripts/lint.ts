import path from "node:path";

import { lintCommands } from "complete-node";

import {
  checkCoreMappingJSONFiles,
  checkCoreMappingJSONSchemas,
} from "./lint/core-mapping-json.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const WEB_STYLELINT_COMMAND = "stylelint ./apps/web/src/**/*.css";

process.chdir(REPO_ROOT);

const scopes = process.argv.slice(2);

await lintCommands(import.meta.dirname, getLintCommands(scopes));

type LintCommand = string | [string, Promise<void>];

function getLintCommands(
  selectedScopes: readonly string[],
): readonly LintCommand[] {
  if (selectedScopes.length === 0) {
    return [
      ...getTypeScriptCommands([
        "apps/cli",
        "apps/web",
        "packages/core",
        "packages/history",
        "scripts",
      ]),

      // Use ESLint to lint the code.
      // - "--max-warnings 0" makes warnings fail, since we set all ESLint errors to warnings.
      "eslint --cache --cache-location .eslintcache --max-warnings 0 .",
      "eslint --max-warnings 0 --config eslint.config.json.mjs packages/core/src/data/*.json",

      // Use Prettier to check formatting.
      // - "--log-level=warn" makes it only output errors.
      "prettier --log-level=warn --check .",

      // Use Knip to check for unused files, exports, and dependencies.
      // - "--treat-config-hints-as-errors" - Exit with non-zero code (1) if there are any
      //   configuration hints.
      "knip --treat-config-hints-as-errors",

      // Use stylelint to lint the CSS.
      WEB_STYLELINT_COMMAND,

      // Ensure that the core mapping JSON files satisfy their schemas.
      ["check core mapping JSON schemas", checkCoreMappingJSONSchemas()],

      // Ensure that the core mapping JSON files adhere to certain quality standards.
      ["check core mapping JSON files", checkCoreMappingJSONFiles()],
    ];
  }

  return [
    ...getTypeScriptCommands(selectedScopes),
    ...selectedScopes.flatMap(getScopedLintCommands),
  ];
}

function getTypeScriptCommands(
  scopesToLint: readonly string[],
): readonly string[] {
  return scopesToLint.flatMap((scope) => {
    switch (scope) {
      case "apps/cli": {
        return ["tsc --project ./apps/cli/tsconfig.json"];
      }

      case "apps/web": {
        return [
          "tsc --project ./apps/web/tsconfig.json",
          "tsc --project ./apps/web/tsconfig.node.json",
        ];
      }

      case "packages/core": {
        return [
          "tsc --project ./packages/core/tsconfig.json",
          "tsc --project ./packages/core/tsconfig.node.json",
        ];
      }

      case "packages/history": {
        return ["tsc --project ./packages/history/tsconfig.json"];
      }

      case "scripts": {
        return ["tsc --project ./scripts/tsconfig.json"];
      }

      default: {
        throw new Error(`Unknown lint scope: ${scope}`);
      }
    }
  });
}

function getScopedLintCommands(scope: string): readonly LintCommand[] {
  switch (scope) {
    case "apps/cli":
    case "packages/history":
    case "scripts": {
      return [
        `eslint --cache --cache-location .eslintcache --max-warnings 0 ${scope}`,
        `prettier --log-level=warn --check ${scope}`,
      ];
    }

    case "apps/web": {
      return [
        "eslint --cache --cache-location .eslintcache --max-warnings 0 apps/web",
        "prettier --log-level=warn --check apps/web",
        WEB_STYLELINT_COMMAND,
      ];
    }

    case "packages/core": {
      return [
        "eslint --cache --cache-location .eslintcache --max-warnings 0 packages/core",
        "eslint --max-warnings 0 --config eslint.config.json.mjs packages/core/src/data/*.json",
        "prettier --log-level=warn --check packages/core",
        ["check core mapping JSON schemas", checkCoreMappingJSONSchemas()],
        ["check core mapping JSON files", checkCoreMappingJSONFiles()],
      ];
    }

    default: {
      throw new Error(`Unknown lint scope: ${scope}`);
    }
  }
}
