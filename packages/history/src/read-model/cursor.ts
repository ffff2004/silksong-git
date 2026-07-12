import { InvalidReadModelCursorError } from "../errors.ts";

export interface ReadModelCursor {
  readonly afterObservationSequence: number;
  readonly eventIndex: number;
}

interface EncodedReadModelCursor extends ReadModelCursor {
  readonly version: number;
  readonly context: string;
}

export function parseCursor(
  cursor: string | undefined,
  context: string,
  order: "asc" | "desc",
): ReadModelCursor {
  if (cursor === undefined) {
    return {
      afterObservationSequence:
        order === "asc" ? Number.MIN_SAFE_INTEGER : Number.MAX_SAFE_INTEGER,
      eventIndex:
        order === "asc" ? Number.MIN_SAFE_INTEGER : Number.MAX_SAFE_INTEGER,
    };
  }

  let parsed: EncodedReadModelCursor;

  try {
    // Buffer is required until this package's TypeScript lib includes the Uint8Array base64 API.
    // eslint-disable-next-line unicorn/prefer-uint8array-base64
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");

    parsed = JSON.parse(decoded) as EncodedReadModelCursor;
  } catch (error) {
    throw new InvalidReadModelCursorError({ cause: error });
  }

  if (
    parsed.version !== 1
    || parsed.context !== context
    || !Number.isSafeInteger(parsed.afterObservationSequence)
    || !Number.isSafeInteger(parsed.eventIndex)
  ) {
    throw new InvalidReadModelCursorError();
  }

  return {
    afterObservationSequence: parsed.afterObservationSequence,
    eventIndex: parsed.eventIndex,
  };
}

export function createCursor(cursor: ReadModelCursor, context: string): string {
  const encoded = Buffer.from(
    JSON.stringify({ version: 1, context, ...cursor }),
  );

  // Buffer is required until this package's TypeScript lib includes the Uint8Array base64 API.
  // eslint-disable-next-line unicorn/prefer-uint8array-base64
  return encoded.toString("base64url");
}
