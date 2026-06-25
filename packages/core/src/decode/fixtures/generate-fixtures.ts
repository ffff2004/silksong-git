import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import CryptoJS from "crypto-js";

const CSHARP_HEADER = new Uint8Array([
  0, 1, 0, 0, 0, 255, 255, 255, 255, 1, 0, 0, 0, 0, 0, 0, 0, 6, 1, 0, 0, 0,
]);

const AES_KEY_STRING = "UKu52ePUBwetZ9wNX88o54dnfKRu0T1l";

const currentDirectory = import.meta.dirname;
const decodedFixturePath = path.join(
  currentDirectory,
  "minimal-valid-save.decoded.json",
);
const encodedFixturePath = path.join(
  currentDirectory,
  "minimal-valid-save.dat",
);
const textEncoder = new TextEncoder();

function encode7BitLength(length: number): Uint8Array {
  const bytes: number[] = [];
  let value = length;

  while (value >= 0x80) {
    // eslint-disable-next-line no-bitwise
    bytes.push((value & 0x7f) | 0x80);
    // eslint-disable-next-line no-bitwise
    value >>= 7;
  }

  bytes.push(value);
  return new Uint8Array(bytes);
}

function encodeSilksongSave(jsonString: string): Uint8Array {
  const key = CryptoJS.enc.Utf8.parse(AES_KEY_STRING);
  const encrypted = CryptoJS.AES.encrypt(jsonString, key, {
    mode: CryptoJS.mode.ECB,
    padding: CryptoJS.pad.Pkcs7,
  });
  const base64 = encrypted.ciphertext.toString(CryptoJS.enc.Base64);
  const base64Bytes = textEncoder.encode(base64);
  const lengthPrefix = encode7BitLength(base64Bytes.length);

  const encoded = new Uint8Array(
    CSHARP_HEADER.length + lengthPrefix.length + base64Bytes.length + 1,
  );
  encoded.set(CSHARP_HEADER);
  encoded.set(lengthPrefix, CSHARP_HEADER.length);
  encoded.set(base64Bytes, CSHARP_HEADER.length + lengthPrefix.length);

  return encoded;
}

const decodedJson = await readFile(decodedFixturePath, "utf8");
await writeFile(encodedFixturePath, encodeSilksongSave(decodedJson));
