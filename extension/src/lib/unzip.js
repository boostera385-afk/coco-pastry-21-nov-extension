// Minimal ZIP reader (stored + deflate) on the browser's built-in DecompressionStream — no library needed.
// Used by the one-click updater to unpack the extension zip published on the dashboard.

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** @returns {Promise<{ name: string, data: Uint8Array }[]>} files only (folders skipped) */
export async function unzip(buffer) {
  const b = new Uint8Array(buffer);
  // end of central directory: scan back from the end (comment up to 64 KB)
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i--) if (u32(b, i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip file');
  const count = u16(b, eocd + 10);
  let p = u32(b, eocd + 16);
  const files = [];
  const dec = new TextDecoder();
  for (let k = 0; k < count; k++) {
    if (u32(b, p) !== 0x02014b50) throw new Error('bad zip directory');
    const method = u16(b, p + 10);
    const csize = u32(b, p + 20);
    const size = u32(b, p + 24);
    const nlen = u16(b, p + 28); const xlen = u16(b, p + 30); const clen = u16(b, p + 32);
    const local = u32(b, p + 42);
    const name = dec.decode(b.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    if (name.endsWith('/')) continue;
    if (u32(b, local) !== 0x04034b50) throw new Error('bad zip entry');
    const start = local + 30 + u16(b, local + 26) + u16(b, local + 28);
    const raw = b.subarray(start, start + csize);
    const data = method === 0 ? raw.slice() : method === 8 ? await inflateRaw(raw) : null;
    if (!data) throw new Error(`unsupported zip method ${method}`);
    if (data.length !== size) throw new Error(`zip entry ${name} is damaged`);
    files.push({ name, data });
  }
  return files;
}
