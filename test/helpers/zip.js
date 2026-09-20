'use strict';

/**
 * 最小 zip 构造器，只在测试里用。
 *
 * 刻意手写而不是拉依赖：解包逻辑要验证的正是「中央目录偏移、本地文件头、
 * 压缩方法」这几件事，用同一个库生成再解析等于自己验证自己。
 */

const zlib = require('node:zlib');

const LFH = 0x04034b50;
const CDFH = 0x02014b50;
const EOCD = 0x06054b50;

/**
 * @param {Array<{name:string, data:Buffer|string, method?:0|8}>} entries
 * @returns {Buffer}
 */
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), 'utf8');
    const method = entry.method === 8 ? 8 : 0;
    const payload = method === 8 ? zlib.deflateRawSync(raw) : raw;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LFH, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(0, 14); // crc32：读取端不校验，测试里省掉
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    locals.push(local, nameBuf, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CDFH, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);

    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + payload.length;
  }

  const localBuf = Buffer.concat(locals);
  const centralBuf = Buffer.concat(centrals);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([localBuf, centralBuf, eocd]);
}

/** 造一个合法的 .moc3 头部：魔数 + 版本号 + 填充。 */
function makeMoc3(version, padding = 32) {
  const buf = Buffer.alloc(5 + padding);
  buf.write('MOC3', 0, 'latin1');
  buf[4] = version;
  return buf;
}

/** 造一个满足 buildPack 全部引用的标准 Live2D 包清单。 */
function makeManifest(modelName) {
  return JSON.stringify(
    {
      Version: 3,
      FileReferences: {
        Moc: `${modelName}.moc3`,
        Textures: [`${modelName}.2048/texture_00.png`],
        Physics: `${modelName}.physics3.json`,
        Motions: { Idle: [{ File: 'motions/idle.motion3.json' }] },
        Expressions: [{ Name: 'f01', File: 'expressions/f01.exp3.json' }],
      },
    },
    null,
    2
  );
}

module.exports = { makeZip, makeMoc3, makeManifest };
