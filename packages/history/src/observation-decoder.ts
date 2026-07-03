import {
  DecodeEncodedSaveError,
  UnrecognizedSaveSchemaError,
  decodeEncodedSave,
  parseDecodedSave,
} from "@silksong-git/core";

import { sha256Hex } from "./hash.ts";
import type { ObservationMetadata } from "./observation.ts";
import type { SemanticUpdateResult, WatcherError } from "./types.ts";

type DecodedObservationResult =
  | {
      readonly status: "decoded";
      readonly decodedJson: string;
      readonly decodedSave: unknown;
      readonly decodedSha256: string;
      readonly decoderVersion: string;
      readonly schema: ObservationMetadata["schema"];
      readonly semanticUpdate: SemanticUpdateResult;
    }
  | {
      readonly status: "watcherError";
      readonly error: WatcherError;
    };

export function decodeObservation(
  encodedBytes: Uint8Array,
): DecodedObservationResult {
  let decoded: ReturnType<typeof decodeEncodedSave>;
  try {
    decoded = decodeEncodedSave(encodedBytes);
  } catch (error) {
    if (error instanceof DecodeEncodedSaveError) {
      return {
        status: "watcherError",
        error: {
          message: error.message,
          reason: "decodeFailure",
        },
      };
    }

    throw error;
  }

  const decodedJson = `${JSON.stringify(decoded.decodedSave, undefined, 2)}\n`;
  const schemaAndSemanticUpdate = classifyDecodedSave(decoded.decodedSave);

  return {
    status: "decoded",
    decodedJson,
    decodedSave: decoded.decodedSave,
    decodedSha256: sha256Hex(decodedJson),
    decoderVersion: decoded.version.decoderVersion,
    ...schemaAndSemanticUpdate,
  };
}

function classifyDecodedSave(decodedSave: unknown): {
  readonly schema: ObservationMetadata["schema"];
  readonly semanticUpdate: SemanticUpdateResult;
} {
  try {
    const parsed = parseDecodedSave(decodedSave);

    return {
      schema: {
        status: "recognized",
        ...parsed.version,
      },
      semanticUpdate: {
        status: "notAvailable",
        reason: "readModelUnavailable",
      },
    };
  } catch (error) {
    if (!(error instanceof UnrecognizedSaveSchemaError)) {
      throw error;
    }

    return {
      schema: {
        status: "unrecognized",
        reason: error.message,
      },
      semanticUpdate: {
        status: "notAvailable",
        reason: "unrecognizedSchema",
      },
    };
  }
}
