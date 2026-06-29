import CryptoJS from "crypto-js";

import type { DecodedEncodedSave } from "../types.ts";

const decoderVersion = "silksong-save-decoder-v1";

const CSHARP_HEADER = new Uint8Array([
  0, 1, 0, 0, 0, 255, 255, 255, 255, 1, 0, 0, 0, 0, 0, 0, 0, 6, 1, 0, 0, 0,
]);

const AES_KEY_STRING = "UKu52ePUBwetZ9wNX88o54dnfKRu0T1l";

export class DecodeEncodedSaveError extends Error {
  public constructor(options?: ErrorOptions) {
    super("Failed to decode the Silksong save file.", options);
    this.name = "DecodeEncodedSaveError";
  }
}

export function decodeEncodedSave(
  encodedSave: ArrayBuffer | Uint8Array,
): DecodedEncodedSave {
  try {
    return {
      decodedSave: decodeEncodedSaveUnsafe(encodedSave),
      version: {
        decoderVersion,
      },
    };
  } catch (error) {
    throw new DecodeEncodedSaveError({ cause: error });
  }
}

function decodeEncodedSaveUnsafe(
  encodedSave: ArrayBuffer | Uint8Array,
): unknown {
  const bytes =
    encodedSave instanceof Uint8Array
      ? encodedSave
      : new Uint8Array(encodedSave);
  const bytesWithoutHeader = removeHeader(bytes);
  const base64 = bytesToString(bytesWithoutHeader);
  const encryptedWords = CryptoJS.enc.Base64.parse(base64);
  const cipherParams = CryptoJS.lib.CipherParams.create({
    ciphertext: encryptedWords,
  });
  const key = CryptoJS.enc.Utf8.parse(AES_KEY_STRING);

  const decrypted = CryptoJS.AES.decrypt(cipherParams, key, {
    mode: CryptoJS.mode.ECB,
    padding: CryptoJS.pad.Pkcs7,
  });

  const jsonString = CryptoJS.enc.Utf8.stringify(decrypted);
  return JSON.parse(jsonString);
}

function removeHeader(bytes: Uint8Array): Uint8Array {
  const withoutHeader = bytes.subarray(CSHARP_HEADER.length, -1);

  let lengthCount = 0;
  for (let i = 0; i < 5; i++) {
    lengthCount++;
    const byte = withoutHeader[i];
    // eslint-disable-next-line no-bitwise
    if (byte !== undefined && (byte & 0x80) === 0) {
      break;
    }
  }

  return withoutHeader.subarray(lengthCount);
}

function bytesToString(bytes: Uint8Array): string {
  let value = "";
  const chunkSize = 0x80_00;

  for (let i = 0; i < bytes.length; i += chunkSize) {
    value += String.fromCodePoint(...bytes.slice(i, i + chunkSize));
  }

  return value;
}
