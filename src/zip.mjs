/**
 * 最小可用 ZIP 读写器（零依赖）
 *
 * 读：中央目录解析 + deflate-raw 解压，支持 DOCX / 学习库包解包。
 * 写：deflate-raw 压缩 + 固定 DOS 时间戳，保证同内容多次打包字节一致。
 */

import zlib from 'node:zlib';
import { AgentError } from './errors.mjs';

const EOCD = 0x06054b50;
const CEN = 0x02014b50;
const LOC = 0x04034b50;

let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function findEocd(buf) {
  const min = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD) return i;
  }
  return -1;
}

/**
 * @param {Buffer} buf
 * @returns {Map<string, Buffer>} zip 内路径（统一正斜杠）→ 内容
 */
export function readZip(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) {
    throw new AgentError('LA003', '不是有效的 ZIP 文件');
  }
  const eocd = findEocd(buf);
  if (eocd < 0) throw new AgentError('LA003', 'ZIP 缺少中央目录（文件可能被截断）');
  const count = buf.readUInt16LE(eocd + 10);
  const cenOffset = buf.readUInt32LE(eocd + 16);
  if (cenOffset >= buf.length) throw new AgentError('LA003', 'ZIP 中央目录偏移越界');

  const files = new Map();
  let p = cenOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8').replace(/\\/g, '/');
    p += 46 + nameLen + extraLen + commentLen;

    if (!name || name.endsWith('/')) continue;
    if (name.includes('..')) continue;
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LOC) continue;
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) {
      try {
        data = zlib.inflateRawSync(raw);
      } catch (err) {
        throw new AgentError('LA003', `ZIP 条目解压失败：${name}`, { cause: err });
      }
    } else {
      throw new AgentError('LA003', `不支持的 ZIP 压缩算法 ${method}：${name}`);
    }
    files.set(name, data);
  }
  return files;
}

function dosDateTime(date) {
  const d = date || new Date('1980-01-01T00:00:00Z');
  const time = ((d.getUTCHours() & 0x1f) << 11) | ((d.getUTCMinutes() & 0x3f) << 5) | ((d.getUTCSeconds() / 2) & 0x1f);
  const day = (((d.getUTCFullYear() - 1980) & 0x7f) << 9) | (((d.getUTCMonth() + 1) & 0x0f) << 5) | (d.getUTCDate() & 0x1f);
  return { time, day };
}

/**
 * @param {Map<string, Buffer|string>|Array<{path:string, data:Buffer|string}>} entries
 * @param {{mtime?: Date}} [opts]
 * @returns {Buffer}
 */
export function writeZip(entries, opts = {}) {
  const list = entries instanceof Map
    ? [...entries.entries()].map(([path, data]) => ({ path, data }))
    : entries;
  const { time, day } = dosDateTime(opts.mtime);

  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of list) {
    const name = String(entry.path).replace(/\\/g, '/').replace(/^\/+/, '');
    if (!name || name.includes('..')) {
      throw new AgentError('LA012', `ZIP 条目路径非法：${entry.path}`);
    }
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), 'utf8');
    const compressed = zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOC, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CEN, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0o644 << 16, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + compressed.length;
  }

  const cenBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(list.length, 8);
  eocd.writeUInt16LE(list.length, 10);
  eocd.writeUInt32LE(cenBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, cenBuf, eocd]);
}

export { crc32 };
