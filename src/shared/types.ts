// Contracts shared by the main process, the preload bridge and the renderer.

export type Locale = 'pt-BR' | 'en';

export type RoleId = 'POS 1' | 'POS 2' | 'POS 3' | 'POS 4' | 'POS 5';

export type ScreenId = 'live' | 'panel' | 'timers' | 'role' | 'audio' | 'gsi' | 'idle';

/** 1 = chatter, 5 = never drop this one. */
export type Priority = 1 | 2 | 3 | 4 | 5;

export type ClipId =
  | 'stack' | 'pull' | 'bounty' | 'power_rune' | 'wisdom'
  | 'night' | 'day' | 'tier_two' | 'tier_three' | 'tormentor'
  | 'aegis_expira' | 'rosh_possivel' | 'rosh_garantido'
  | 'sem_buyback' | 'sem_tp' | 'glyph_pronto'
  | 'smoke_visto' | 'aegis_inimigo' | 'buyback_inimigo';

export type HotkeyName = 'mute' | 'roshan' | 'palette';

export interface Settings {
  screen: ScreenId;
  role: RoleId;
  verbose: boolean;
  muted: boolean;
  /** max spoken calls per rolling minute */
  budget: number;
  volume: number;
  locale: Locale;
  /** speak with the OS voice when a clip has not been recorded */
  ttsFallback: boolean;
  outputDeviceId: string;
  inputDeviceId: string;
  gsiToken: string;
  dotaCfgDir: string | null;
  hotkeys: Record<HotkeyName, string | null>;
  /** event ids silenced by hand, on top of whatever the role set mutes */
  mutedEvents: string[];
}

export interface ClipMeta {
  id: ClipId;
  bytes: number;
  recordedAt: number;
  durationMs: number | null;
}

export type ClipIndex = Partial<Record<ClipId, ClipMeta>>;

export interface GsiStatus {
  listening: boolean;
  port: number;
  host: string;
  payloads: number;
  rejected: number;
  lastPayloadAt: number | null;
  avgMs: number;
  reconnects: number;
  error: string | null;
  token: string | null;
  /** only present on the ipc `gsi:status` reply, not on pushed updates */
  dotaDirs?: string[];
  cfgDir?: string | null;
  cfgInstalled?: boolean;
}

// ── Dota 2 Game State Integration payload ────────────────────────────────
// Everything is optional: Valve omits blocks depending on game state, and a
// spectator client sends arrays where a player client sends objects.

export interface GsiMap {
  name?: string;
  matchid?: string;
  game_time?: number;
  clock_time?: number;
  daytime?: boolean;
  nightstalker_night?: boolean;
  game_state?: string;
  paused?: boolean;
  win_team?: string;
  radiant_score?: number;
  dire_score?: number;
}

export interface GsiPlayer {
  steamid?: string;
  name?: string;
  activity?: string;
  team_name?: string;
  gold?: number;
  gold_reliable?: number;
  gold_unreliable?: number;
  gpm?: number;
  xpm?: number;
  kills?: number;
  deaths?: number;
  assists?: number;
  last_hits?: number;
  denies?: number;
  buyback_cost?: number;
  buyback_cooldown?: number;
}

export interface GsiHero {
  id?: number;
  name?: string;
  level?: number;
  alive?: boolean;
  respawn_seconds?: number;
  buyback_cost?: number;
  buyback_cooldown?: number;
  health_percent?: number;
  mana_percent?: number;
  smoked?: boolean;
}

export interface GsiItem {
  name?: string;
  purchaser?: number;
  charges?: number;
  item_charges?: number;
  cooldown?: number;
  can_cast?: boolean;
}

export type GsiItems = Record<string, GsiItem>;

export interface GsiPayload {
  provider?: { name?: string; appid?: number; version?: number; timestamp?: number };
  map?: GsiMap;
  player?: GsiPlayer;
  hero?: GsiHero;
  items?: GsiItems;
  previously?: unknown;
  added?: unknown;
  auth?: { token?: string };
}

// ── window.api, as exposed by the preload bridge ─────────────────────────

export type Unsubscribe = () => void;

export interface Api {
  window: {
    minimize(): Promise<void>;
    maximize(): Promise<boolean>;
    close(): Promise<void>;
    onState(handler: (state: { maximized: boolean }) => void): Unsubscribe;
  };
  settings: {
    get(): Promise<Settings>;
    set(partial: Partial<Settings>): Promise<Settings>;
  };
  hotkeys: {
    register(): Promise<Record<HotkeyName, string | null>>;
    onPress(handler: (name: HotkeyName) => void): Unsubscribe;
  };
  clips: {
    list(locale: Locale): Promise<ClipIndex>;
    read(locale: Locale, id: ClipId): Promise<Uint8Array | null>;
    save(locale: Locale, id: ClipId, bytes: Uint8Array, durationMs: number): Promise<ClipMeta>;
    remove(locale: Locale, id: ClipId): Promise<boolean>;
    reveal(locale: Locale): Promise<string>;
  };
  gsi: {
    status(): Promise<GsiStatus>;
    install(dir?: string | null): Promise<{ ok: true; file: string } | { ok: false; error: string }>;
    chooseFolder(): Promise<string | null>;
    onPayload(handler: (payload: GsiPayload) => void): Unsubscribe;
    onStatus(handler: (status: GsiStatus) => void): Unsubscribe;
  };
  app: {
    copy(text: string): Promise<boolean>;
    info(): Promise<{ version: string; userData: string; platform: string; electron: string }>;
  };
}

declare global {
  interface Window {
    api: Api;
  }
}
