import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

/**
 * Scanner del artefacto (BLOCK 10.1 §3 y §10).
 *
 * El APK es un ZIP, y los strings viven comprimidos: hay que descomprimir cada
 * entrada para que la busqueda sea real. Un grep sobre el .apk crudo no
 * encontraria nada y el gate seria decorativo.
 */

export type ArtifactFinding = {
  readonly entryName: string;
  readonly rule: string;
  readonly detail: string;
};

export type ZipEntry = { readonly name: string; readonly data: Uint8Array };

function readUint16(source: Uint8Array, offset: number): number {
  return source[offset]! | (source[offset + 1]! << 8);
}

function readUint32(source: Uint8Array, offset: number): number {
  return (
    (source[offset]! |
      (source[offset + 1]! << 8) |
      (source[offset + 2]! << 16) |
      (source[offset + 3]! << 24)) >>>
    0
  );
}

const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x0605_4b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x0201_4b50;

/** Lector de ZIP minimo: end-of-central-directory + central directory + inflate. */
export function readZipEntryList(apkBuffer: Buffer): ZipEntry[] {
  let endOffset = -1;
  for (let offset = apkBuffer.length - 22; offset >= 0; offset -= 1) {
    if (readUint32(apkBuffer, offset) === END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) {
    throw new Error('no es un ZIP valido: falta el end of central directory');
  }

  const entryCount = readUint16(apkBuffer, endOffset + 10);
  let cursor = readUint32(apkBuffer, endOffset + 16);
  const entryList: ZipEntry[] = [];

  for (let index = 0; index < entryCount; index += 1) {
    if (readUint32(apkBuffer, cursor) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new Error(`directorio central invalido en la entrada ${index}`);
    }
    const compressionMethod = readUint16(apkBuffer, cursor + 10);
    const compressedSize = readUint32(apkBuffer, cursor + 20);
    const uncompressedSize = readUint32(apkBuffer, cursor + 24);
    const nameLength = readUint16(apkBuffer, cursor + 28);
    const extraLength = readUint16(apkBuffer, cursor + 30);
    const commentLength = readUint16(apkBuffer, cursor + 32);
    const localHeaderOffset = readUint32(apkBuffer, cursor + 42);
    const name = apkBuffer
      .subarray(cursor + 46, cursor + 46 + nameLength)
      .toString('utf8');

    const localNameLength = readUint16(apkBuffer, localHeaderOffset + 26);
    const localExtraLength = readUint16(apkBuffer, localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const rawData = apkBuffer.subarray(dataStart, dataStart + compressedSize);

    let data: Uint8Array;
    if (compressionMethod === 0) {
      data = rawData;
    } else if (compressionMethod === 8) {
      data = inflateRawSync(rawData, { maxOutputLength: Math.max(uncompressedSize, 1) });
    } else {
      throw new Error(
        `metodo de compresion no soportado ${compressionMethod} en ${name}`,
      );
    }

    entryList.push({ name, data });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entryList;
}

/**
 * Los valores que jamas pueden estar dentro del bundle. Son los secrets de
 * desarrollo que el repo usa para los smokes: si alguno aparece en el APK, el
 * secret se compileo.
 */
export const FORBIDDEN_SECRET_VALUE_LIST = [
  'block-8-2-smoke-device-secret',
  'block-8-2-smoke-dashboard-secret',
];

const SECRET_ASSIGNMENT_PATTERN =
  /(DEVICE_SHARED_SECRET|DASHBOARD_SHARED_SECRET|MOBILE_SHARED_SECRET)["']?\s*[:=]\s*["'][^"']{6,}["']/;
const HARDCODED_TOKEN_URL_PATTERN = /[?&]token=[A-Za-z0-9._-]{8,}/;
const SECRET_FIELD_PATTERN =
  /(DEVICE|DASHBOARD|MOBILE)_SHARED_SECRET[\s\S]{0,24}["'][^"']{6,}["']/;

function decodeLatin1(source: Uint8Array): string {
  return Buffer.from(source).toString('latin1');
}

export function scanApkBuffer(apkBuffer: Buffer): ArtifactFinding[] {
  const findingList: ArtifactFinding[] = [];
  const entryList = readZipEntryList(apkBuffer);

  for (const entry of entryList) {
    const text = decodeLatin1(entry.data);
    const isScannableEntry =
      entry.name.endsWith('.dex') ||
      entry.name.endsWith('.arsc') ||
      entry.name.endsWith('.xml');
    if (isScannableEntry) {
      for (const secretValue of FORBIDDEN_SECRET_VALUE_LIST) {
        if (text.includes(secretValue)) {
          findingList.push({
            entryName: entry.name,
            rule: 'known_development_secret',
            detail: secretValue,
          });
        }
      }
      const assignment = text.match(SECRET_ASSIGNMENT_PATTERN);
      if (assignment !== null) {
        findingList.push({
          entryName: entry.name,
          rule: 'secret_assignment',
          detail: assignment[0],
        });
      }
      const tokenUrl = text.match(HARDCODED_TOKEN_URL_PATTERN);
      if (tokenUrl !== null) {
        findingList.push({
          entryName: entry.name,
          rule: 'hardcoded_token_url',
          detail: tokenUrl[0],
        });
      }
      const secretField = text.match(SECRET_FIELD_PATTERN);
      if (secretField !== null) {
        findingList.push({
          entryName: entry.name,
          rule: 'secret_field_with_value',
          detail: secretField[0],
        });
      }
    }
  }
  return findingList;
}

export function scanApkFile(apkPath: string): ArtifactFinding[] {
  return scanApkBuffer(readFileSync(apkPath));
}

/**
 * Constructor de ZIP minimo para probar el scanner sin depender de un APK
 * construido. Appendear bytes al final de un ZIP real no sirve: el lector busca
 * el end-of-central-directory hacia atras y las entradas originales quedan antes
 * del payload inyectado, asi que nunca se leerian.
 */
export function buildSyntheticApk(
  entryNameList: readonly string[],
  entryContentList: readonly string[],
): Buffer {
  const localPartList: Buffer[] = [];
  const centralPartList: Buffer[] = [];
  let offset = 0;

  for (let index = 0; index < entryNameList.length; index += 1) {
    const entryName = entryNameList[index] as string;
    const content = Buffer.from(entryContentList[index] as string, 'utf8');
    const nameBuffer = Buffer.from(entryName, 'utf8');
    const checksum = 0;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x0403_4b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(content.length, 18);
    localHeader.writeUInt32LE(content.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(CENTRAL_DIRECTORY_SIGNATURE, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(content.length, 20);
    centralHeader.writeUInt32LE(content.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt32LE(offset, 42);

    localPartList.push(localHeader, nameBuffer, content);
    centralPartList.push(centralHeader, nameBuffer);
    offset += localHeader.length + nameBuffer.length + content.length;
  }

  const centralDirectory = Buffer.concat(centralPartList);
  const endOfCentralDirectory = Buffer.alloc(22);
  endOfCentralDirectory.writeUInt32LE(END_OF_CENTRAL_DIRECTORY_SIGNATURE, 0);
  endOfCentralDirectory.writeUInt16LE(entryNameList.length, 8);
  endOfCentralDirectory.writeUInt16LE(entryNameList.length, 10);
  endOfCentralDirectory.writeUInt32LE(centralDirectory.length, 12);
  endOfCentralDirectory.writeUInt32LE(offset, 16);

  return Buffer.concat([...localPartList, centralDirectory, endOfCentralDirectory]);
}
