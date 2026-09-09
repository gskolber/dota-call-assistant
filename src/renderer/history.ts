// Builds the record of a match while it is being played. Everything in here
// is something GSI states outright; nothing is inferred. What the game does
// not report - whether a camp was actually stacked, where a ward went, who
// the enemy was - simply has no field.

import { EVENTS, PALETTE, ROSHAN_CHAIN, STATE_CALLS } from '../shared/catalog';
import type { MatchRecord, RoleId } from '../shared/types';
import type { LogEntry } from './engine';
import type { MatchState } from './match';

/** Unspent gold above this is an item that should already be in the bag. */
const GOLD_IDLE = 1500;

/** The two state calls only start after these, and so does the accounting. */
const TP_FROM = 120;
const BUYBACK_FROM = 1200;

/**
 * A clock that fell back further than this is a different match: a demo
 * restarted, or a reconnect landing on another game. Counting a transition
 * across that gap would credit the new match with the old one's inventory.
 */
const RESTART_JUMP = 30;

/**
 * The engine log carries the display label, not the id. Every label in the
 * app comes from the catalogue, so the id is a lookup rather than a guess -
 * palette entries are registered under both locales, because the timer took
 * its label from whichever was current when it was created.
 */
const ID_BY_LABEL: Map<string, string> = (() => {
  const map = new Map<string, string>();
  for (const event of EVENTS) map.set(event.label, event.id);
  for (const step of ROSHAN_CHAIN) map.set(step.label, step.id);
  for (const call of Object.values(STATE_CALLS)) map.set(call.label, call.id);
  for (const entry of PALETTE) {
    for (const label of Object.values(entry.label)) map.set(label, entry.id);
  }
  return map;
})();

/** The subset of a tick that later ticks are compared against. */
interface Sample {
  clock: number;
  alive: boolean;
  sentries: number;
  observers: number;
  smokes: number;
}

/**
 * Buyback is out of reach for two reasons and GSI reports both: the gold, and
 * the cooldown left over from the last one. Having the money while the
 * cooldown runs is still having no buyback. A cost of zero means the game has
 * not said yet, which is not the same as being able to afford it.
 */
function outOfBuyback(match: MatchState): boolean {
  if (match.buybackCooldown > 0) return true;
  return match.buybackCost > 0 && match.gold < match.buybackCost;
}

/**
 * Wards and smokes leave the bag by being used, so a count that fell is that
 * many placed. A count that rose is a purchase and means nothing here. The
 * caller is responsible for not comparing across a match boundary, where the
 * fall to zero is the inventory being replaced rather than spent.
 */
function consumed(before: number, after: number): number {
  return after < before ? before - after : 0;
}

function emptyRecord(matchId: string, match: MatchState, role: RoleId): MatchRecord {
  return {
    matchId: matchId || '0',
    startedAt: Date.now(),
    endedAt: null,
    hero: match.heroName,
    team: match.team,
    role,
    duration: match.clock,
    calls: [],
    discipline: {
      secondsWithoutTp: 0,
      secondsWithoutBuyback: 0,
      sentriesPlaced: 0,
      observersPlaced: 0,
      smokesUsed: 0,
      deaths: 0,
      deathsWithoutBuyback: 0,
      peakGold: 0,
      secondsGoldIdle: 0,
    },
  };
}

/** Detached copy, so what crosses IPC cannot keep changing behind the write. */
function copy(record: MatchRecord): MatchRecord {
  return {
    ...record,
    calls: record.calls.map((call) => ({ ...call })),
    discipline: { ...record.discipline },
  };
}

export class MatchHistory {
  private record: MatchRecord | null = null;

  private previous: Sample | null = null;

  /** Newest log entry already copied into the record, held by identity. */
  private lastCall: LogEntry | null = null;

  /** The record being built, or null between matches. */
  get current(): MatchRecord | null {
    return this.record;
  }

  /**
   * Opens a record. The current log head is remembered rather than read: a
   * second hero demo reports the same matchid as the first, so the engine is
   * not reset between them and its log still holds the previous demo's calls.
   */
  begin(matchId: string, match: MatchState, role: RoleId, log: readonly LogEntry[]): void {
    this.record = emptyRecord(matchId, match, role);
    this.previous = null;
    this.lastCall = log[0] ?? null;
  }

  /** One clock second of the match. Called once per engine tick, in a match. */
  observe(clock: number, match: MatchState, role: RoleId, log: readonly LogEntry[]): void {
    const record = this.record;
    if (!record) return;

    // hero and side are still blank in the first payloads of a match
    if (match.heroName) record.hero = match.heroName;
    if (match.team) record.team = match.team;
    record.role = role;
    record.duration = clock;

    this.captureCalls(log);

    const discipline = record.discipline;

    if (match.alive) {
      if (clock > TP_FROM && !match.hasTp) discipline.secondsWithoutTp += 1;
      if (clock > BUYBACK_FROM && outOfBuyback(match)) discipline.secondsWithoutBuyback += 1;
    }

    discipline.peakGold = Math.max(discipline.peakGold, match.gold);
    if (match.gold > GOLD_IDLE) discipline.secondsGoldIdle += 1;

    const previous = this.previous;
    if (previous && clock >= previous.clock - RESTART_JUMP) {
      discipline.sentriesPlaced += consumed(previous.sentries, match.sentries);
      discipline.observersPlaced += consumed(previous.observers, match.observers);
      discipline.smokesUsed += consumed(previous.smokes, match.smokes);

      // The death is the transition, not the seconds that follow it; whether
      // buyback was there is read at the moment of dying, which is the only
      // moment it mattered.
      if (previous.alive && !match.alive) {
        discipline.deaths += 1;
        if (outOfBuyback(match)) discipline.deathsWithoutBuyback += 1;
      }
    }

    this.previous = {
      clock,
      alive: match.alive,
      sentries: match.sentries,
      observers: match.observers,
      smokes: match.smokes,
    };
  }

  /** Stamps the end and hands the record over; the next match starts clean. */
  end(): MatchRecord | null {
    const record = this.record;
    if (!record) return null;
    record.endedAt = Date.now();
    this.record = null;
    this.previous = null;
    this.lastCall = null;
    return copy(record);
  }

  /** What to write mid-match, with `endedAt` still open. */
  snapshot(): MatchRecord | null {
    return this.record ? copy(this.record) : null;
  }

  /**
   * The engine keeps only the last 40 entries and unshifts new ones, so the
   * record has to take them as they appear instead of reading the log at the
   * end. Everything ahead of the entry taken last time is new; when that entry
   * is gone the log was reset with the match, and all of it is new. Being
   * called every tick, no more than one second of calls is ever in between.
   */
  private captureCalls(log: readonly LogEntry[]): void {
    const record = this.record;
    if (!record) return;

    const seen = this.lastCall === null ? -1 : log.indexOf(this.lastCall);
    const fresh = seen === -1 ? log.slice() : log.slice(0, seen);
    // the log is newest first; the record reads in the order things happened
    for (let i = fresh.length - 1; i >= 0; i -= 1) {
      const entry = fresh[i];
      if (!entry) continue;
      record.calls.push({
        clock: entry.clock,
        id: ID_BY_LABEL.get(entry.label) ?? '',
        label: entry.label,
        priority: entry.priority,
        state: entry.state,
      });
    }

    this.lastCall = log[0] ?? this.lastCall;
  }
}
