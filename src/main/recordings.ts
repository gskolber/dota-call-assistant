// User-recorded voice lines live in
//   %APPDATA%/Call Assistant/recordings/<locale>/<clipId>.wav
// next to an index.json holding the duration the renderer measured - nothing
// in the main process decodes audio.

import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

import type { ClipId, ClipIndex, ClipMeta, Locale } from '../shared/types';

const SAFE_ID = /^[a-z0-9_]{1,48}$/;
const SAFE_LOCALE = /^[a-zA-Z-]{2,10}$/;

export function root(): string {
  return path.join(app.getPath('userData'), 'recordings');
}

export function localeDir(locale: Locale): string {
  if (!SAFE_LOCALE.test(locale)) throw new Error('locale inválido');
  return path.join(root(), locale);
}

function clipFile(locale: Locale, id: ClipId): string {
  if (!SAFE_ID.test(id)) throw new Error('clip id inválido');
  return path.join(localeDir(locale), `${id}.wav`);
}

function indexFile(locale: Locale): string {
  return path.join(localeDir(locale), 'index.json');
}

type DurationIndex = Partial<Record<ClipId, { durationMs: number }>>;

function readIndex(locale: Locale): DurationIndex {
  try {
    return JSON.parse(fs.readFileSync(indexFile(locale), 'utf8')) as DurationIndex;
  } catch {
    return {};
  }
}

function writeIndex(locale: Locale, data: DurationIndex): void {
  fs.mkdirSync(localeDir(locale), { recursive: true });
  fs.writeFileSync(indexFile(locale), JSON.stringify(data, null, 2), 'utf8');
}

export function list(locale: Locale): ClipIndex {
  const durations = readIndex(locale);
  const out: ClipIndex = {};

  let names: string[];
  try {
    names = fs.readdirSync(localeDir(locale));
  } catch {
    return out;
  }

  for (const name of names) {
    if (!name.endsWith('.wav')) continue;
    const id = name.slice(0, -'.wav'.length) as ClipId;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(path.join(localeDir(locale), name));
    } catch {
      continue;
    }
    out[id] = {
      id,
      bytes: stat.size,
      recordedAt: stat.mtimeMs,
      durationMs: durations[id]?.durationMs ?? null,
    };
  }
  return out;
}

export function read(locale: Locale, id: ClipId): Buffer {
  return fs.readFileSync(clipFile(locale, id));
}

export function save(locale: Locale, id: ClipId, bytes: Buffer, durationMs: number): ClipMeta {
  fs.mkdirSync(localeDir(locale), { recursive: true });
  fs.writeFileSync(clipFile(locale, id), bytes);

  const durations = readIndex(locale);
  durations[id] = { durationMs: Math.round(durationMs || 0) };
  writeIndex(locale, durations);

  const stat = fs.statSync(clipFile(locale, id));
  return { id, bytes: stat.size, recordedAt: stat.mtimeMs, durationMs: durations[id].durationMs };
}

export function remove(locale: Locale, id: ClipId): void {
  try {
    fs.unlinkSync(clipFile(locale, id));
  } catch { /* already gone */ }
  const durations = readIndex(locale);
  delete durations[id];
  writeIndex(locale, durations);
}
