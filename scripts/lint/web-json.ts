import {
  assertObject,
  assertString,
  isArray,
  isFirstLetterCapitalized,
  isObject,
} from "complete-common";
import { getFilePathsInDirectory, readFile } from "complete-node";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { WEB_APP_ROOT } from "./paths.ts";

const execFileAsync = promisify(execFile);

interface CommandErrorOutput {
  readonly stderr?: unknown;
  readonly stdout?: unknown;
}

async function getWebDataJSONFilePaths(): Promise<readonly string[]> {
  const dataPath = path.join(WEB_APP_ROOT, "src", "data");
  const filePaths = await getFilePathsInDirectory(dataPath);

  return filePaths.filter(
    (filePath) =>
      filePath.endsWith(".json") && !filePath.endsWith(".schema.json"),
  );
}

export async function checkWebJSONSchemas(): Promise<void> {
  const jsonFilePaths = await getWebDataJSONFilePaths();

  const schemaChecks = jsonFilePaths.map(async (jsonFilePath) => {
    const { name, dir } = path.parse(jsonFilePath);
    const schemaFilePath = path.join(dir, `${name}.schema.json`);

    try {
      await execFileAsync("ajv", [
        "validate",
        "-c",
        "ajv-formats",
        "-d",
        jsonFilePath,
        "-s",
        schemaFilePath,
      ]);
    } catch (error) {
      const details = getCommandErrorDetails(error);
      throw new Error(
        `JSON schema validation failed for "${jsonFilePath}".${details}`,
        { cause: error },
      );
    }
  });

  await Promise.all(schemaChecks);
}

function getCommandErrorDetails(error: unknown) {
  const { stderr, stdout } = error as CommandErrorOutput;
  const output = [stdout, stderr]
    .filter(
      (value): value is string =>
        typeof value === "string" && value.trim() !== "",
    )
    .map((value) => value.trim())
    .join("\n");

  if (output !== "") {
    return `\n${output}`;
  }

  return error instanceof Error ? `\n${error.message}` : "";
}

export async function checkWebJSONFiles(): Promise<void> {
  const jsonFilePaths = await getWebDataJSONFilePaths();

  const fileChecks = jsonFilePaths.map(async (jsonFilePath) => {
    const fileContents = await readFile(jsonFilePath);
    const json: unknown = JSON.parse(fileContents);
    assertObject(json, `A JSON file was not an object: ${jsonFilePath}`);
    checkRecursive(json, jsonFilePath, []);
  });

  await Promise.all(fileChecks);
}

function checkRecursive(
  value: unknown,
  filePath: string,
  propertyPath: ReadonlyArray<string | number>,
) {
  const pathString = propertyPath.length > 0 ? propertyPath.join(".") : "root";

  if (typeof value === "string") {
    if (value !== value.trim()) {
      throw new Error(
        `Property "${pathString}" has leading or trailing whitespace in file "${filePath}": ${value}`,
      );
    }

    if (value.includes("  ")) {
      throw new Error(
        `Property "${pathString}" has a double space in file "${filePath}": ${value}`,
      );
    }
  } else if (isArray(value)) {
    for (const [i, element] of value.entries()) {
      checkRecursive(element, filePath, [...propertyPath, i]);
    }
  } else if (isObject(value)) {
    for (const [key, val] of Object.entries(value)) {
      if (key !== key.trim()) {
        throw new Error(
          `Key "${pathString}" has leading or trailing whitespace in file "${filePath}": ${key}`,
        );
      }

      if (key.includes("-")) {
        throw new Error(
          `Key "${pathString}" has a hyphen in file "${filePath}": ${key}`,
        );
      }

      if (isFirstLetterCapitalized(key)) {
        throw new Error(
          `Key "${pathString}" starts with a capital letter in file "${filePath}": ${key}`,
        );
      }

      if (key === "description") {
        assertString(
          val,
          `A "description" property is not a string in file: ${filePath}`,
        );
        if (!val.endsWith(".") && !val.endsWith(".)") && !val.endsWith("?")) {
          throw new Error(
            `Property "${pathString}" does not end with a period in file "${filePath}": ${val}`,
          );
        }
      }

      checkRecursive(val, filePath, [...propertyPath, key]);
    }
  }
}
