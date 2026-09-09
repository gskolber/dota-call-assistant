// Voice packs: one locale's recordings in a .zip, so a player can carry their
// voice to another machine or hand it to a friend.
//
// The zip is written and read here by hand on top of node:zlib. The app has
// zero runtime dependencies and keeps it that way - the same reason the WAV
// encoder in src/renderer/wav.ts is hand-rolled. Only what a voice pack needs
// is implemented: store and deflate, no zip64, no encryption, no directories.
//
// An imported pack is a file from a stranger. Every entry name is checked
// against the clip catalogue, every payload is size-capped and CRC-checked,
// and nothing outside the locale folder can ever be written.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { BrowserWindow, dialog, ipcMain } from 'electron';

import { CLIPS } from '../shared/catalog';
import { translator } from '../shared/i18n';
import type { ClipId, Locale, VoicePackResult } from '../shared/types';
import * as recordings from './recordings';
import * as store from './store';

/** a recorded call is a couple of seconds of mono WAV; 8 MB is already absurd */
const MAX_ENTRY_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 256;

const INDEX_NAME = 'index.json';
const CLIP_NAME = /^([a-z0-9_]{1,48})\.wav$/;

const KNOWN_CLIPS = new Set<string>(CLIPS.map((clip) => clip.id));

// ── zip ───────────────────────────────────────────────────────────────────

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let bit = 0; bit < 8; bit += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** MS-DOS packed date/time, the only timestamp a plain zip entry carries. */
function dosStamp(date: Date): { time: number; date: number } {
  const time =
    ((date.getHours() & 0x1f) << 11) |
    ((date.getMinutes() & 0x3f) << 5) |
    ((date.getSeconds() >> 1) & 0x1f);
  const day =
    ((Math.max(0, date.getFullYear() - 1980) & 0x7f) << 9) |
    (((date.getMonth() + 1) & 0x0f) << 5) |
    (date.getDate() & 0x1f);
  return { time, date: day };
}

interface ZipEntry {
  name: string;
  data: Buffer;
}

function writeZip(entries: ZipEntry[]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  const stamp = dosStamp(new Date());
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const deflated = zlib.deflateRawSync(entry.data, { level: 9 });
    // a short WAV can deflate to more than it started as; store it instead
    const stored = deflated.length >= entry.data.length;
    const body = stored ? entry.data : deflated;
    const method = stored ? 0 : 8;
    const crc = crc32(entry.data);

    const header = Buffer.alloc(30);
    header.writeUInt32LE(LOCAL_SIG, 0);
    header.writeUInt16LE(20, 4); // version needed: 2.0, deflate
    header.writeUInt16LE(0, 6); // no flags: not encrypted, sizes known up front
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(stamp.time, 10);
    header.writeUInt16LE(stamp.date, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(entry.data.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28); // no extra field
    local.push(header, name, body);

    const record = Buffer.alloc(46);
    record.writeUInt32LE(CENTRAL_SIG, 0);
    record.writeUInt16LE(20, 4); // version made by
    record.writeUInt16LE(20, 6); // version needed
    record.writeUInt16LE(0, 8);
    record.writeUInt16LE(method, 10);
    record.writeUInt16LE(stamp.time, 12);
    record.writeUInt16LE(stamp.date, 14);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(body.length, 20);
    record.writeUInt32LE(entry.data.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt16LE(0, 30); // extra
    record.writeUInt16LE(0, 32); // comment
    record.writeUInt16LE(0, 34); // disk number
    record.writeUInt16LE(0, 36); // internal attributes
    record.writeUInt32LE(0, 38); // external attributes
    record.writeUInt32LE(offset, 42);
    central.push(record, name);

    offset += header.length + name.length + body.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(EOCD_SIG, 0);
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // disk with the directory
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // no comment

  return Buffer.concat([...local, directory, end]);
}

/** Scan back for the end-of-central-directory record, past a trailing comment. */
function findEocd(buf: Buffer): number {
  const floor = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= floor; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

function readZip(buf: Buffer): ZipEntry[] {
  if (buf.length < 22) throw new Error('not a zip');
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('no end of central directory');

  const count = buf.readUInt16LE(eocd + 10);
  const size = buf.readUInt32LE(eocd + 12);
  const start = buf.readUInt32LE(eocd + 16);
  if (count > MAX_ENTRIES) throw new Error('too many entries');
  if (start + size > buf.length) throw new Error('central directory out of bounds');

  const entries: ZipEntry[] = [];
  let total = 0;
  let cursor = start;

  for (let i = 0; i < count; i += 1) {
    if (cursor + 46 > buf.length || buf.readUInt32LE(cursor) !== CENTRAL_SIG) {
      throw new Error('bad central directory record');
    }
    const flags = buf.readUInt16LE(cursor + 8);
    const method = buf.readUInt16LE(cursor + 10);
    const crc = buf.readUInt32LE(cursor + 16);
    const compressed = buf.readUInt32LE(cursor + 20);
    const uncompressed = buf.readUInt32LE(cursor + 24);
    const nameLen = buf.readUInt16LE(cursor + 28);
    const extraLen = buf.readUInt16LE(cursor + 30);
    const commentLen = buf.readUInt16LE(cursor + 32);
    const localOffset = buf.readUInt32LE(cursor + 42);
    const name = buf.toString('utf8', cursor + 46, cursor + 46 + nameLen);
    cursor += 46 + nameLen + extraLen + commentLen;

    if (flags & 0x1) throw new Error('encrypted entry');
    if (uncompressed > MAX_ENTRY_BYTES) throw new Error('entry too large');
    total += uncompressed;
    if (total > MAX_TOTAL_BYTES) throw new Error('pack too large');

    // The central directory is the authority on sizes - the local header may
    // carry zeroes when the writer streamed the entry - but the name and
    // extra field lengths there are the ones that locate the payload.
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LOCAL_SIG) {
      throw new Error('bad local header');
    }
    const dataStart =
      localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    if (dataStart + compressed > buf.length) throw new Error('entry out of bounds');
    const body = buf.subarray(dataStart, dataStart + compressed);

    let data: Buffer;
    if (method === 0) data = Buffer.from(body);
    else if (method === 8) data = zlib.inflateRawSync(body, { maxOutputLength: MAX_ENTRY_BYTES });
    else throw new Error(`unsupported compression method ${method}`);

    if (data.length !== uncompressed) throw new Error('size mismatch');
    if (crc32(data) !== crc) throw new Error('checksum mismatch');

    entries.push({ name, data });
  }

  return entries;
}

// ── pack ──────────────────────────────────────────────────────────────────

/** Only `<knownClipId>.wav` and `index.json`, flat. Everything else is dropped. */
function clipIdOf(name: string): ClipId | null {
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return null;
  const match = CLIP_NAME.exec(name);
  const id = match?.[1];
  if (!id || !KNOWN_CLIPS.has(id)) return null;
  return id as ClipId;
}

function isWav(data: Buffer): boolean {
  return (
    data.length > 44 &&
    data.toString('ascii', 0, 4) === 'RIFF' &&
    data.toString('ascii', 8, 12) === 'WAVE'
  );
}

function readDurations(data: Buffer): Partial<Record<ClipId, number>> {
  const out: Partial<Record<ClipId, number>> = {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.toString('utf8')) as unknown;
  } catch {
    return out; // a broken index only costs the durations, not the clips
  }
  if (!parsed || typeof parsed !== 'object') return out;

  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!KNOWN_CLIPS.has(key)) continue;
    const ms = (value as { durationMs?: unknown } | null)?.durationMs;
    if (typeof ms === 'number' && Number.isFinite(ms) && ms >= 0) {
      out[key as ClipId] = Math.round(ms);
    }
  }
  return out;
}

export async function exportPack(
  locale: Locale,
  parent: BrowserWindow | null,
): Promise<VoicePackResult> {
  try {
    // only catalogue clips go in, so a pack never carries a stray file the
    // user dropped in the folder and the import side would refuse anyway
    const ids = (Object.keys(recordings.list(locale)) as ClipId[]).filter((id) => KNOWN_CLIPS.has(id));
    if (ids.length === 0) return { ok: false, detail: 'EMPTY' };

    const title = translator(store.load().uiLanguage)('voicepack.title');
    const options = {
      title,
      defaultPath: `callassistant-voicepack-${locale}.zip`,
      filters: [{ name: title, extensions: ['zip'] }],
    };
    const chosen = parent
      ? await dialog.showSaveDialog(parent, options)
      : await dialog.showSaveDialog(options);
    if (chosen.canceled || !chosen.filePath) return { ok: false, canceled: true };

    const dir = recordings.localeDir(locale);
    const entries: ZipEntry[] = [];
    for (const id of ids) {
      try {
        entries.push({ name: `${id}.wav`, data: recordings.read(locale, id) });
      } catch { /* vanished between listing and reading */ }
    }
    try {
      entries.push({ name: INDEX_NAME, data: fs.readFileSync(path.join(dir, INDEX_NAME)) });
    } catch { /* durations are optional */ }

    fs.writeFileSync(chosen.filePath, writeZip(entries));
    return { ok: true, file: chosen.filePath, count: entries.length };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}

export async function importPack(
  locale: Locale,
  parent: BrowserWindow | null,
): Promise<VoicePackResult> {
  try {
    const title = translator(store.load().uiLanguage)('voicepack.title');
    const options = {
      title,
      properties: ['openFile' as const],
      filters: [{ name: title, extensions: ['zip'] }],
    };
    const chosen = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options);
    const file = chosen.filePaths[0];
    if (chosen.canceled || !file) return { ok: false, canceled: true };

    const stat = fs.statSync(file);
    if (stat.size > MAX_TOTAL_BYTES) return { ok: false, detail: 'TOO LARGE' };

    const entries = readZip(fs.readFileSync(file));
    const durations = entries.find((e) => e.name === INDEX_NAME);
    const incoming = durations ? readDurations(durations.data) : {};

    // recordings.save patches index.json one clip at a time, so every duration
    // already on disk survives; a pack with no index keeps the local numbers
    // rather than zeroing them.
    const current = recordings.list(locale);

    let count = 0;
    for (const entry of entries) {
      const id = clipIdOf(entry.name);
      if (!id || !isWav(entry.data)) continue;
      recordings.save(locale, id, entry.data, incoming[id] ?? current[id]?.durationMs ?? 0);
      count += 1;
    }

    if (count === 0) return { ok: false, detail: 'NO CLIPS' };
    return { ok: true, count, file };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}

/** Called from main.ts in one line so the two files never fight over the same edit. */
export function registerVoicePackIpc(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('voicepack:export', (_e, locale: Locale) => exportPack(locale, getWindow()));
  ipcMain.handle('voicepack:import', (_e, locale: Locale) => importPack(locale, getWindow()));
}
