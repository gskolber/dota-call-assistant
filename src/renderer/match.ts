// Turns raw GSI snapshots into the handful of facts the app actually needs.

import type { GsiAbilities, GsiAbility, GsiItem, GsiPayload } from '../shared/types';

export interface MatchState {
  connected: boolean;
  inMatch: boolean;
  /** map.clock_time - negative before the horn */
  clock: number;
  paused: boolean;
  daytime: boolean;
  gameState: string;
  heroName: string;
  alive: boolean;
  respawnSeconds: number;
  gold: number;
  buybackCost: number;
  hasTp: boolean;
  observers: number;
  sentries: number;
  smokes: number;
  dusts: number;
  /** ultimate is levelled, off cooldown and castable right now */
  ultimateReady: boolean;
  /** clock second the ultimate last came back from a cooldown worth a call */
  ultimateReadyAt: number | null;
  /** same, per watched item name */
  itemsReadyAt: Record<string, number>;
  /** clock second at which the carried sentry count last went down */
  lastSentryPlacedAt: number | null;
  lastPayloadAt: number | null;
}

export const EMPTY_MATCH: MatchState = {
  connected: false,
  inMatch: false,
  clock: 0,
  paused: false,
  daytime: true,
  gameState: '',
  heroName: '',
  alive: true,
  respawnSeconds: 0,
  gold: 0,
  buybackCost: 0,
  hasTp: false,
  observers: 0,
  sentries: 0,
  smokes: 0,
  dusts: 0,
  ultimateReady: false,
  ultimateReadyAt: null,
  itemsReadyAt: {},
  lastSentryPlacedAt: null,
  lastPayloadAt: null,
};

/** Dota reports a hero as being in a match only from the horn onwards. */
const PLAYING_STATES = new Set([
  'DOTA_GAMERULES_STATE_PRE_GAME',
  'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS',
]);

/** Items whose downtime changes what the team can do; the rest is noise. */
const WATCHED_ITEMS = [
  'item_black_king_bar',
  'item_blink',
  'item_glimmer_cape',
  'item_force_staff',
  'item_ghost',
  'item_pipe',
];

/**
 * A shorter downtime than this is not worth interrupting the player for: an
 * ultimate reads as cooldown 0 the instant it is levelled, and the blink's
 * damage lockout is over before anyone could act on the call.
 */
const ULTIMATE_MIN_COOLDOWN = 30;
const ITEM_MIN_COOLDOWN = 12;

function charges(item: GsiItem | undefined): number {
  if (!item) return 0;
  const raw = item.charges ?? item.item_charges;
  return typeof raw === 'number' ? raw : 1;
}

function countItem(items: Record<string, GsiItem> | undefined, name: string): number {
  if (!items) return 0;
  let total = 0;
  for (const [slot, item] of Object.entries(items)) {
    if (slot.startsWith('stash')) continue;
    if (item?.name === name) total += charges(item);
  }
  return total;
}

function hasItem(items: Record<string, GsiItem> | undefined, names: string[]): boolean {
  if (!items) return false;
  return Object.entries(items).some(
    ([slot, item]) => !slot.startsWith('stash') && !!item?.name && names.includes(item.name),
  );
}

function findItem(items: Record<string, GsiItem> | undefined, name: string): GsiItem | undefined {
  if (!items) return undefined;
  for (const [slot, item] of Object.entries(items)) {
    if (slot.startsWith('stash')) continue;
    if (item?.name === name) return item;
  }
  return undefined;
}

function ultimateOf(abilities: GsiAbilities | undefined): GsiAbility | undefined {
  if (!abilities) return undefined;
  return Object.values(abilities).find((ability) => ability?.ultimate === true);
}

export class MatchTracker {
  private state: MatchState = { ...EMPTY_MATCH };

  /** Longest cooldown seen in the run each key is currently serving. */
  private cooldownPeak = new Map<string, number>();

  get current(): MatchState {
    return this.state;
  }

  reset(): void {
    this.state = { ...EMPTY_MATCH };
    this.cooldownPeak.clear();
  }

  /**
   * Marks the clock second a thing came back up, but only after a downtime
   * long enough to matter - the peak is remembered until the thing is usable
   * again, so a full cooldown followed by an empty mana bar still counts.
   */
  private readyMark(
    key: string,
    cooldown: number,
    usable: boolean,
    minimum: number,
    clock: number,
    previous: number | null,
  ): number | null {
    const peak = Math.max(this.cooldownPeak.get(key) ?? 0, cooldown);
    if (cooldown > 0 || !usable) {
      this.cooldownPeak.set(key, peak);
      return previous;
    }
    this.cooldownPeak.delete(key);
    return peak >= minimum ? clock : previous;
  }

  /** Returns the new state; `inMatch` flips false when Dota is at the menu. */
  apply(payload: GsiPayload): MatchState {
    const previous = this.state;
    const map = payload.map;
    const hero = payload.hero;
    const player = payload.player;
    const items = payload.items;

    // A spectator client sends arrays here; we only support playing.
    const playing = !!map && PLAYING_STATES.has(map.game_state ?? '') && !Array.isArray(hero);

    const observers = countItem(items, 'item_ward_observer')
      + countItem(items, 'item_ward_dispenser');
    const sentries = countItem(items, 'item_ward_sentry');

    const clock = map?.clock_time ?? 0;
    const sentryDropped = playing && previous.inMatch && sentries < previous.sentries;

    const ultimate = playing ? ultimateOf(payload.abilities) : undefined;
    const ultimateReady = !!ultimate
      && (ultimate.level ?? 0) > 0
      && (ultimate.cooldown ?? 0) === 0
      && ultimate.can_cast !== false;
    const ultimateReadyAt = ultimate
      ? this.readyMark(
        'ultimate', ultimate.cooldown ?? 0, ultimateReady,
        ULTIMATE_MIN_COOLDOWN, clock, previous.ultimateReadyAt,
      )
      : previous.ultimateReadyAt;

    const itemsReadyAt = { ...previous.itemsReadyAt };
    for (const name of WATCHED_ITEMS) {
      const item = playing ? findItem(items, name) : undefined;
      // an item that is gone from the bag starts its next cooldown from scratch
      if (!item) {
        this.cooldownPeak.delete(name);
        continue;
      }
      const cooldown = item.cooldown ?? 0;
      const mark = this.readyMark(
        name, cooldown, cooldown === 0 && item.can_cast !== false,
        ITEM_MIN_COOLDOWN, clock, itemsReadyAt[name] ?? null,
      );
      if (mark !== null) itemsReadyAt[name] = mark;
    }

    this.state = {
      connected: true,
      inMatch: playing,
      clock,
      paused: map?.paused ?? false,
      daytime: map?.daytime ?? true,
      gameState: map?.game_state ?? '',
      heroName: (hero?.name ?? '').replace('npc_dota_hero_', ''),
      alive: hero?.alive ?? true,
      respawnSeconds: hero?.respawn_seconds ?? 0,
      gold: player?.gold ?? 0,
      buybackCost: hero?.buyback_cost ?? player?.buyback_cost ?? 0,
      hasTp: hasItem(items, ['item_tpscroll', 'item_travel_boots', 'item_travel_boots_2']),
      observers,
      sentries,
      smokes: countItem(items, 'item_smoke_of_deceit'),
      dusts: countItem(items, 'item_dust'),
      ultimateReady,
      ultimateReadyAt,
      itemsReadyAt,
      lastSentryPlacedAt: sentryDropped ? clock : previous.lastSentryPlacedAt,
      lastPayloadAt: Date.now(),
    };

    // a fresh match wipes the "since" markers
    if (playing && clock < previous.clock - 30) {
      this.state.lastSentryPlacedAt = null;
      this.state.ultimateReadyAt = null;
      this.state.itemsReadyAt = {};
      this.cooldownPeak.clear();
    }

    return this.state;
  }

  markDisconnected(): MatchState {
    this.state = { ...this.state, connected: false, inMatch: false };
    return this.state;
  }
}
