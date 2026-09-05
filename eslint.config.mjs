// This is the configuration file for ESLint, the TypeScript linter:
// https://eslint.org/docs/latest/use/configure/

// @ts-check

import { completeConfigBase } from "eslint-config-complete";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig(
  globalIgnores([
    "apps/desktop/src-tauri/gen/**",
    "apps/desktop/src-tauri/target/**",
    "apps/web/dist-desktop/**",
  ]),
  ...completeConfigBase,
  {
    files: ["**/*"],
    rules: {
      // 我说中文
      "complete/require-ascii": "off",
    },
  },
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    rules: {
      // By default, the upstream "n/file-extension-in-import" rule is enabled to lint for ".js"
      // file extensions, which is standard practice when writing TypeScript with ECMAScript modules
      // that will be transpiled to JavaScript. Since we use Vite, we can use ".ts" file extensions,
      // which is less confusing. However, it does not seem possible to configure
      // "n/file-extension-in-import" to work with ".ts" file extensions. Thus, we use
      // "import-x/extensions" instead.
      "n/file-extension-in-import": "off",
      "import-x/extensions": ["warn", "ignorePackages", { fix: true }],

      // This codebase mutates parameters in several places.
      "no-param-reassign": "off",

      // We temporarily allow circular references.
      "import-x/no-cycle": "off",

      // Complete-lint 5 enables stricter rules that would require broad rewrites of the current
      // static Web app. Keep the remaining overrides focused on lower-signal compatibility churn
      // instead of changing existing DOM, state, parser, and user-facing text patterns.
      "regexp/require-unicode-regexp": "off",
      "regexp/require-unicode-sets-regexp": "off",
      "unicorn/max-nested-calls": "off",
      "unicorn/prefer-await": "off",
      "unicorn/try-complexity": "off",

      "@typescript-eslint/explicit-module-boundary-types": "off",
      // Vite guarantees that class names declared in a CSS Module exist at runtime. TypeScript's
      // generic CSS Module index signature cannot express that guarantee when
      // noUncheckedIndexedAccess is enabled, so allow assertions only on the conventional `styles`
      // import while preserving the ban everywhere else in Web code.
      "@typescript-eslint/no-non-null-assertion": "off",
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "TSNonNullExpression:not([expression.type='MemberExpression'][expression.object.name='styles'])",
          message:
            "Non-null assertions are only allowed for class names from the conventional CSS Module `styles` import.",
        },
      ],
      "no-unassigned-vars": "off",
      "perfectionist/sort-jsx-props": "off",
    },
  },
  {
    files: ["apps/web/**/*.test.{ts,tsx}"],
    rules: {
      "import-x/no-extraneous-dependencies": "off",
      "unicorn/no-global-object-property-assignment": "off",
    },
  },
  {
    files: ["apps/cli/src/**/*.ts", "apps/cli/tsup.config.ts"],
    rules: {
      // The installable CLI bundles workspace packages into dist/main.js, so these imports are
      // build-time inputs rather than package runtime dependencies.
      "import-x/no-extraneous-dependencies": [
        "error",
        {
          devDependencies: ["apps/cli/src/**/*.ts", "apps/cli/tsup.config.ts"],
        },
      ],
    },
  },
  {
    files: [
      "apps/desktop-sidecar/src/**/*.ts",
      "apps/desktop-sidecar/tsup.config.ts",
    ],
    rules: {
      // The development sidecar bundles workspace packages into dist/main.js. Test-only History
      // imports remain explicit development dependencies.
      "import-x/no-extraneous-dependencies": [
        "error",
        {
          devDependencies: [
            "apps/desktop-sidecar/src/**/*.test.ts",
            "apps/desktop-sidecar/tsup.config.ts",
          ],
        },
      ],
    },
  },
  {
    files: ["apps/desktop-sidecar/prototypes/**/*.ts"],
    rules: {
      // Prototypes intentionally exercise the private sidecar seam and shell tooling directly; they
      // are not production package code and are deleted or promoted as a unit.
      "@typescript-eslint/no-restricted-imports": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/strict-boolean-expressions": "off",
      "@typescript-eslint/strict-void-return": "off",
      "complete/no-mutable-return": "off",
      "complete/no-string-length-0": "off",
      "complete/prefer-readonly-parameter-types": "off",
      "complete/prefer-const": "off",
      "complete/prefer-is-array": "off",
      "complete/sort-objects": "off",
      "no-bitwise": "off",
      "no-param-reassign": "off",
      "no-void": "off",
      "preserve-caught-error": "off",
      "prefer-const": "off",
      "unicorn/no-array-front-mutation": "off",
      "unicorn/no-await-expression-member": "off",
      "unicorn/no-return-array-push": "off",
      "unicorn/no-unnecessary-splice": "off",
      "unicorn/no-unreadable-for-of-expression": "off",
      "unicorn/no-unreadable-new-expression": "off",
      "unicorn/no-this-outside-of-class": "off",
      "unicorn/prefer-top-level-await": "off",
      "unicorn/try-complexity": "off",
    },
  },
  {
    files: ["**/*.ts"],
    rules: {
      // Sequential async work is common for filesystem polling and ordered IO.
      "no-await-in-loop": "off",

      // Synchronous event APIs sometimes need explicit Promise rejection handlers.
      "unicorn/prefer-await": "off",

      // 弱智规则，会导致传给 Git 命令的参数被错误地认为是错误的模板字符串
      "unicorn/no-incorrect-template-string-interpolation": "off",
    },
  },
  {
    files: ["**/*.test.{ts,tsx}"],
    rules: {
      // Tests often use small helper classes and queue-like fixtures.
      "@typescript-eslint/require-await": "off",
      "complete/require-variadic-function-argument": "off",
      "max-classes-per-file": "off",
      "unicorn/no-array-front-mutation": "off",
    },
  },
);
