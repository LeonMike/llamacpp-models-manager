import * as fs from 'node:fs/promises';

export type SyntheticKvEntry =
  | { key: string; type: 'string'; value: string }
  | { key: string; type: 'uint32'; value: number }
  | { key: string; type: 'bool'; value: boolean }
  | { key: string; type: 'float32'; value: number }
  | { key: string; type: 'string_array'; value: string[] };

/**
 * Builds a valid GGUF v3 binary header Buffer for testing `readGgufHeader` and `inspectGgufFile`.
 */
export function buildSyntheticGgufBuffer(
  entries: SyntheticKvEntry[],
  options: { version?: number; tensorCount?: bigint } = {}
): Buffer {
  const version = options.version ?? 3;
  const tensorCount = options.tensorCount ?? 42n;
  const chunks: Buffer[] = [];

  // 1. Magic "GGUF" (0x46554747 LE)
  const header = Buffer.alloc(24);
  header.write('GGUF', 0, 4, 'ascii');
  header.writeUInt32LE(version, 4);
  header.writeBigUInt64LE(tensorCount, 8);
  header.writeBigUInt64LE(BigInt(entries.length), 16);
  chunks.push(header);

  const writeString = (str: string): Buffer => {
    const strBytes = Buffer.from(str, 'utf8');
    const lenBuf = Buffer.alloc(8);
    lenBuf.writeBigUInt64LE(BigInt(strBytes.length), 0);
    return Buffer.concat([lenBuf, strBytes]);
  };

  for (const entry of entries) {
    chunks.push(writeString(entry.key));
    const typeBuf = Buffer.alloc(4);

    if (entry.type === 'string') {
      typeBuf.writeUInt32LE(8, 0); // GgufValueType.STRING = 8
      chunks.push(typeBuf, writeString(entry.value));
    } else if (entry.type === 'uint32') {
      typeBuf.writeUInt32LE(4, 0); // GgufValueType.UINT32 = 4
      const valBuf = Buffer.alloc(4);
      valBuf.writeUInt32LE(entry.value, 0);
      chunks.push(typeBuf, valBuf);
    } else if (entry.type === 'bool') {
      typeBuf.writeUInt32LE(7, 0); // GgufValueType.BOOL = 7
      const valBuf = Buffer.alloc(1);
      valBuf.writeUInt8(entry.value ? 1 : 0, 0);
      chunks.push(typeBuf, valBuf);
    } else if (entry.type === 'float32') {
      typeBuf.writeUInt32LE(6, 0); // GgufValueType.FLOAT32 = 6
      const valBuf = Buffer.alloc(4);
      valBuf.writeFloatLE(entry.value, 0);
      chunks.push(typeBuf, valBuf);
    } else if (entry.type === 'string_array') {
      typeBuf.writeUInt32LE(9, 0); // GgufValueType.ARRAY = 9
      const arrHeader = Buffer.alloc(12);
      arrHeader.writeUInt32LE(8, 0); // Element type: STRING = 8
      arrHeader.writeBigUInt64LE(BigInt(entry.value.length), 4);
      chunks.push(typeBuf, arrHeader);
      for (const s of entry.value) {
        chunks.push(writeString(s));
      }
    }
  }

  return Buffer.concat(chunks);
}

export async function writeSyntheticGgufFile(
  filePath: string,
  entries: SyntheticKvEntry[]
): Promise<void> {
  const buf = buildSyntheticGgufBuffer(entries);
  await fs.writeFile(filePath, buf);
}

