// This is the configuration file for ESLint, the TypeScript linter:
// https://eslint.org/docs/latest/use/configure/

// @ts-check

import { completeConfigBase } from "eslint-config-complete";
import { defineConfig } from "eslint/config";

export default defineConfig(...completeConfigBase, {
  files: ["apps/web/**/*.ts"],
  rules: {
    // By default, the upstream "n/file-extension-in-import" rule is enabled to lint for ".js" file
    // extensions, which is standard practice when writing TypeScript with ECMAScript modules that
    // will be transpiled to JavaScript. Since we use Vite, we can use ".ts" file extensions, which
    // is less confusing. However, it does not seem possible to configure
    // "n/file-extension-in-import" to work with ".ts" file extensions. Thus, we use
    // "import-x/extensions" instead.
    "n/file-extension-in-import": "off",
    "import-x/extensions": ["warn", "ignorePackages", { fix: true }],

    // This codebase mutates parameters in several places.
    "no-param-reassign": "off",

    // We temporarily allow circular references.
    "import-x/no-cycle": "off",

    // Complete-lint 5 enables stricter rules that would require broad rewrites of the current
    // static Web app. Keep this upgrade focused on tool compatibility instead of changing existing
    // DOM, state, parser, and user-facing text patterns.
    "@typescript-eslint/no-unsafe-argument": "off",
    "@typescript-eslint/no-unsafe-assignment": "off",
    "@typescript-eslint/no-unsafe-call": "off",
    "@typescript-eslint/no-unsafe-member-access": "off",
    "@typescript-eslint/no-unsafe-return": "off",
    "@typescript-eslint/strict-boolean-expressions": "off",
    "@typescript-eslint/strict-void-return": "off",
    "complete/require-ascii": "off",
    "regexp/require-unicode-regexp": "off",
    "regexp/require-unicode-sets-regexp": "off",
    "unicorn/max-nested-calls": "off",
    "unicorn/no-declarations-before-early-exit": "off",
    "unicorn/no-this-outside-of-class": "off",
    "unicorn/no-top-level-assignment-in-function": "off",
    "unicorn/no-unsafe-dom-html": "off",
    "unicorn/no-unreadable-new-expression": "off",
    "unicorn/no-useless-template-literals": "off",
    "unicorn/prefer-await": "off",
    "unicorn/prefer-dom-node-html-methods": "off",
    "unicorn/text-encoding-identifier-case": "off",
    "unicorn/try-complexity": "off",
  },
});
