// Turns raw GSI snapshots into the handful of facts the app actually needs.

import type { GsiItem, GsiPayload } from '../shared/types';

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
  lastSentryPlacedAt: null,
  lastPayloadAt: null,
};

/** Dota reports a hero as being in a match only from the horn onwards. */
const PLAYING_STATES = new Set([
  'DOTA_GAMERULES_STATE_PRE_GAME',
  'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS',
]);

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

export class MatchTracker {
  private state: MatchState = { ...EMPTY_MATCH };

  get current(): MatchState {
    return this.state;
  }

  reset(): void {
    this.state = { ...EMPTY_MATCH };
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
      lastSentryPlacedAt: sentryDropped ? clock : previous.lastSentryPlacedAt,
      lastPayloadAt: Date.now(),
    };

    // a fresh match wipes the "since" markers
    if (playing && clock < previous.clock - 30) {
      this.state.lastSentryPlacedAt = null;
    }

    return this.state;
  }

  markDisconnected(): MatchState {
    this.state = { ...this.state, connected: false, inMatch: false };
    return this.state;
  }
}
