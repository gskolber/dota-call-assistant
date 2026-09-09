// One JSON file per match, in
//   %APPDATA%/Call Assistant/matches/<startedAt>-<matchId>.json
//
// The renderer accumulates the record while the match runs and hands the whole
// thing over every few seconds, so every write is an upsert of one file. The
// name carries `startedAt` first because a demo or custom game reports matchid
// "0": the id alone would make every demo overwrite the last one, and the
// timestamp is also what makes the directory listing sort chronologically
// without opening anything.
//
// matchid is a string Dota puts in a JSON payload. It never reaches a path
// without being stripped to a short, boring set of characters first.

import fs from 'node:fs';
import path from 'node:path';
import { app, ipcMain, shell } from 'electron';

import type {
  MatchCallRecord, MatchDiscipline, MatchRecord, MatchSummary, RoleId, Team,
} from '../shared/types';

/** A player runs thousands of games; this folder is a report, not an archive. */
const MAX_MATCHES = 50;
const DEFAULT_LIMIT = 20;

const NAME = /^\d{13,}-[0-9A-Za-z_-]{1,32}\.json$/;
const TMP_SUFFIX = '.tmp';
/** a temp file older than this outlived the write that made it, i.e. a crash */
const STALE_TMP_MS = 60_000;

/** MatchCallRecord.state for a call that was actually spoken. */
const SPOKEN = 'SPOKEN';

const ROLES: readonly RoleId[] = ['POS 1', 'POS 2', 'POS 3', 'POS 4', 'POS 5'];

export function root(): string {
  return path.join(app.getPath('userData'), 'matches');
}

// ── naming ────────────────────────────────────────────────────────────────

function safeMatchId(matchId: unknown): string {
  const raw = typeof matchId === 'string' ? matchId : '';
  const cleaned = raw.replace(/[^0-9A-Za-z_-]/g, '').slice(0, 32);
  return cleaned || 'unknown';
}

/**
 * Epoch milliseconds, left-padded, so a plain string sort over the directory is
 * a sort by time. Thirteen digits covers every date until the year 2286.
 */
function stamp(startedAt: unknown): string {
  const ms = typeof startedAt === 'number' && Number.isFinite(startedAt)
    ? Math.max(0, Math.floor(startedAt))
    : 0;
  return String(ms).padStart(13, '0');
}

function fileName(matchId: unknown, startedAt: unknown): string {
  return `${stamp(startedAt)}-${safeMatchId(matchId)}.json`;
}

// ── reading ───────────────────────────────────────────────────────────────
// Every file here is user-visible and hand-editable. A broken one costs its own
// record and nothing else.

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function parseCalls(value: unknown): MatchCallRecord[] {
  if (!Array.isArray(value)) return [];
  const out: MatchCallRecord[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const call = item as Record<string, unknown>;
    out.push({
      clock: asNumber(call.clock, 0),
      id: asString(call.id, ''),
      label: asString(call.label, ''),
      priority: asNumber(call.priority, 0),
      state: asString(call.state, ''),
    });
  }
  return out;
}

function parseDiscipline(value: unknown): MatchDiscipline {
  const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  return {
    secondsWithoutTp: asNumber(raw.secondsWithoutTp, 0),
    secondsWithoutBuyback: asNumber(raw.secondsWithoutBuyback, 0),
    sentriesPlaced: asNumber(raw.sentriesPlaced, 0),
    observersPlaced: asNumber(raw.observersPlaced, 0),
    smokesUsed: asNumber(raw.smokesUsed, 0),
    deaths: asNumber(raw.deaths, 0),
    deathsWithoutBuyback: asNumber(raw.deathsWithoutBuyback, 0),
    peakGold: asNumber(raw.peakGold, 0),
    secondsGoldIdle: asNumber(raw.secondsGoldIdle, 0),
  };
}

function parseRecord(text: string): MatchRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const raw = parsed as Record<string, unknown>;

  // identity is the one thing that cannot be defaulted into existence
  if (typeof raw.matchId !== 'string') return null;
  if (typeof raw.startedAt !== 'number' || !Number.isFinite(raw.startedAt)) return null;

  const role = ROLES.find((known) => known === raw.role) ?? 'POS 5';
  const team: Team | null = raw.team === 'radiant' || raw.team === 'dire' ? raw.team : null;
  const endedAt = typeof raw.endedAt === 'number' && Number.isFinite(raw.endedAt)
    ? raw.endedAt
    : null;

  return {
    matchId: raw.matchId,
    startedAt: raw.startedAt,
    endedAt,
    hero: asString(raw.hero, ''),
    team,
    role,
    duration: asNumber(raw.duration, 0),
    calls: parseCalls(raw.calls),
    discipline: parseDiscipline(raw.discipline),
  };
}

function readRecord(file: string): MatchRecord | null {
  try {
    return parseRecord(fs.readFileSync(file, 'utf8'));
  } catch {
    return null; // vanished, unreadable, or a directory someone dropped in
  }
}

/** Record file names, newest first. Names sort by time by construction. */
function names(): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(root());
  } catch {
    return []; // nothing recorded yet
  }
  return entries.filter((name) => NAME.test(name)).sort().reverse();
}

function summarise(record: MatchRecord): MatchSummary {
  let spoken = 0;
  for (const call of record.calls) if (call.state === SPOKEN) spoken += 1;
  return {
    matchId: record.matchId,
    startedAt: record.startedAt,
    hero: record.hero,
    team: record.team,
    role: record.role,
    duration: record.duration,
    endedAt: record.endedAt,
    spoken,
    dropped: record.calls.length - spoken,
  };
}

// ── api ───────────────────────────────────────────────────────────────────

/**
 * Upsert: the renderer sends the accumulated record over and over as the match
 * runs. The write lands on a temp file in the same directory and is renamed
 * over the target, so a crash halfway through leaves the previous good record
 * intact rather than a truncated one.
 */
export function record(entry: MatchRecord): void {
  const dir = root();
  fs.mkdirSync(dir, { recursive: true });

  const target = path.join(dir, fileName(entry.matchId, entry.startedAt));
  const temp = `${target}.${process.pid}${TMP_SUFFIX}`;
  try {
    fs.writeFileSync(temp, JSON.stringify(entry), 'utf8');
    fs.renameSync(temp, target);
  } catch (err) {
    try {
      fs.unlinkSync(temp);
    } catch { /* never written */ }
    throw err;
  }
  prune();
}

/**
 * Newest first. The name gives away the ordering, so only the `limit` most
 * recent files are opened - but a summary needs the hero, the role and the call
 * counts, and those live inside the record.
 */
export function list(limit = DEFAULT_LIMIT): MatchSummary[] {
  const capped = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : DEFAULT_LIMIT;
  const dir = root();
  const out: MatchSummary[] = [];

  for (const name of names()) {
    if (out.length >= capped) break;
    const parsed = readRecord(path.join(dir, name));
    if (parsed) out.push(summarise(parsed));
  }
  return out;
}

export function get(matchId: string, startedAt: number): MatchRecord | null {
  return readRecord(path.join(root(), fileName(matchId, startedAt)));
}

export async function reveal(): Promise<string> {
  const dir = root();
  fs.mkdirSync(dir, { recursive: true });
  await shell.openPath(dir);
  return dir;
}

/** Drop everything past the newest MAX_MATCHES, plus temp files a crash left. */
function prune(): void {
  const dir = root();
  const ordered = names();

  for (const name of ordered.slice(MAX_MATCHES)) {
    try {
      fs.unlinkSync(path.join(dir, name));
    } catch { /* already gone */ }
  }

  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  const now = Date.now();
  for (const name of entries) {
    if (!name.endsWith(TMP_SUFFIX)) continue;
    const file = path.join(dir, name);
    try {
      if (now - fs.statSync(file).mtimeMs > STALE_TMP_MS) fs.unlinkSync(file);
    } catch { /* in flight, or already gone */ }
  }
}

/** Called from main.ts in one line so the two files never fight over the same edit. */
export function registerMatchIpc(): void {
  ipcMain.handle('matches:record', (_e, entry: MatchRecord) => {
    try {
      record(entry);
    } catch (err) {
      // this fires every few seconds during a match; a full disk must not
      // start throwing errors back into the renderer's tick
      console.error('[matchlog] write failed:', (err as Error).message);
    }
  });
  ipcMain.handle('matches:list', (_e, limit?: number) => list(limit ?? DEFAULT_LIMIT));
  ipcMain.handle('matches:get', (_e, matchId: string, startedAt: number) => get(matchId, startedAt));
  ipcMain.handle('matches:reveal', () => reveal());
}
