import { CLIPS, PALETTE, mmss } from '../shared/catalog';
import type {
  ClipIndex, GsiPayload, GsiStatus, HotkeyName, ScreenId, Settings,
} from '../shared/types';
import { AudioBank, listAudioDevices } from './audio';
import { h, mount } from './dom';
import { CallEngine, paletteByCode, type EngineFlags } from './engine';
import { EMPTY_MATCH, MatchTracker, type MatchState } from './match';
import { RecordDialog } from './record-ui';
import { renderScreen, renderSidebar, type Actions, type Ctx } from './screens';

const SPEAKING_MS = 2200;
const PALETTE_MS = 2600;
/** seconds of clock the engine will replay before giving up and resyncing */
const CATCH_UP = 5;
/** silence after which Dota is considered gone, menu or match alike */
const GSI_TIMEOUT_MS = 12_000;
/** the audio screen owns <select>s that a blind re-render would fight with */
const STATIC_SCREENS = new Set<ScreenId>(['audio']);

const dom = {
  titlebar: document.getElementById('titlebar') as HTMLElement,
  sidebar: document.getElementById('sidebar') as HTMLElement,
  main: document.getElementById('main') as HTMLElement,
  record: document.getElementById('record') as HTMLElement,
  palette: document.getElementById('palette') as HTMLElement,
  toast: document.getElementById('toast') as HTMLElement,
};

const engine = new CallEngine();
const tracker = new MatchTracker();
const audio = new AudioBank();

const state = {
  settings: null as Settings | null,
  gsi: null as GsiStatus | null,
  match: EMPTY_MATCH as MatchState,
  clips: {} as ClipIndex,
  devices: { inputs: [] as MediaDeviceInfo[], outputs: [] as MediaDeviceInfo[] },
  lastPayload: null as GsiPayload | null,
  speaking: null as { text: string; source: string } | null,
  deadOverride: false,
  fight: false,
  maximized: false,
  clock: 0,
  sim: { active: false, playing: false, clock: 0 },
  paletteBuffer: '',
  paletteOpen: false,
  lastMatchId: '',
  capturing: null as HotkeyName | null,
  dirty: true,
};

let speakingTimer = 0;
let paletteTimer = 0;
let toastTimer = 0;
let lastTickedClock: number | null = null;
let simAnchor = 0;

function settings(): Settings {
  if (!state.settings) throw new Error('settings not loaded yet');
  return state.settings;
}

// ── ui plumbing ───────────────────────────────────────────────────────────

function toast(message: string): void {
  mount(dom.toast, h('div.toast', { text: message }));
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => mount(dom.toast), 2400);
}

async function patchSettings(partial: Partial<Settings>): Promise<void> {
  state.settings = await window.api.settings.set(partial);
  applyAudioSettings();
  if (partial.locale) await loadClips();
  state.dirty = true;
}

function applyAudioSettings(): void {
  const s = settings();
  audio.volume = s.volume;
  audio.verbose = s.verbose;
  audio.locale = s.locale;
  audio.ttsFallback = s.ttsFallback;
  audio.outputDeviceId = s.outputDeviceId;
}

async function loadClips(): Promise<void> {
  const locale = settings().locale;
  state.clips = await window.api.clips.list(locale);
  await audio.load(locale, state.clips);
  state.dirty = true;
}

async function refreshDevices(): Promise<void> {
  state.devices = await listAudioDevices();
  state.dirty = true;
}

// ── clock ─────────────────────────────────────────────────────────────────

function flags(): EngineFlags {
  const s = settings();
  return {
    role: s.role,
    budget: s.budget,
    muted: s.muted,
    dead: state.deadOverride || (state.match.inMatch && !state.match.alive),
    fight: state.fight,
    paused: state.match.inMatch && state.match.paused,
    mutedEvents: s.mutedEvents,
  };
}

function currentClock(): number {
  if (state.match.inMatch) return state.match.clock;
  if (state.sim.active) return state.sim.clock;
  return state.clock;
}

function speak(text: string, source: string): void {
  state.speaking = { text, source };
  state.dirty = true;
  window.clearTimeout(speakingTimer);
  speakingTimer = window.setTimeout(() => {
    state.speaking = null;
    state.dirty = true;
  }, SPEAKING_MS);
}

function runEngineTick(clock: number): void {
  const calls = engine.tick(clock, flags(), {
    gold: state.match.gold,
    buybackCost: state.match.buybackCost,
    hasTp: state.match.hasTp,
    alive: !flags().dead,
  });

  for (const call of calls) {
    const result = audio.speak(call.clip);
    if (result.source !== 'silent') speak(result.text, result.source);
  }
  state.dirty = true;
}

/**
 * Runs faster than the clock so a sampling hiccup cannot swallow a second.
 * Every whole second between the last tick and now is replayed; a jump larger
 * than CATCH_UP (a skip, a new match, a reconnect) resyncs instead.
 */
function pump(): void {
  if (!state.settings) return;

  const now = performance.now();
  if (state.sim.active && state.sim.playing && !state.match.inMatch) {
    while (now - simAnchor >= 1000) {
      state.sim.clock += 1;
      simAnchor += 1000;
      state.dirty = true;
    }
  } else {
    simAnchor = now;
  }

  const clock = currentClock();
  state.clock = clock;

  if (lastTickedClock === null || clock < lastTickedClock || clock - lastTickedClock > CATCH_UP) {
    lastTickedClock = clock;
    return;
  }
  while (lastTickedClock < clock) {
    lastTickedClock += 1;
    runEngineTick(lastTickedClock);
  }
}

// ── render ────────────────────────────────────────────────────────────────

function context(): Ctx {
  return {
    settings: settings(),
    clock: state.clock,
    match: state.match,
    gsi: state.gsi,
    engine,
    flags: flags(),
    clips: state.clips,
    speaking: state.speaking,
    sim: { active: state.sim.active, playing: state.sim.playing },
    devices: state.devices,
    lastPayload: state.lastPayload,
    capturing: state.capturing,
    actions,
  };
}

function renderTitlebar(ctx: Ctx): void {
  const connected = !!ctx.gsi?.lastPayloadAt && Date.now() - ctx.gsi.lastPayloadAt < 10_000;
  mount(
    dom.titlebar,
    h('div.titlebar__brand', { text: 'CALL ASSISTANT' }),
    h('div.titlebar__spacer'),
    h('div.titlebar__meta', {
      text: ctx.match.inMatch
        ? `${ctx.match.heroName.toUpperCase() || 'IN MATCH'} · ${mmss(ctx.clock)}`
        : ctx.sim.active
          ? `SIMULATION · ${mmss(ctx.clock)}`
          : 'TIMINGS VALIDATED · PATCH 7.41e',
      style: 'margin-right:12px',
    }),
    h('div', {
      class: ctx.settings.muted ? 'chip chip--alert' : connected ? 'chip' : 'chip chip--off',
      text: ctx.settings.muted ? 'MUTED' : connected ? 'LIVE' : 'LOCAL ONLY',
      style: 'margin-right:8px',
    }),
    h(
      'div.winbtns',
      {},
      h('button.winbtn', { text: '—', onClick: () => void window.api.window.minimize() }),
      h('button.winbtn', {
        text: state.maximized ? '❐' : '▢',
        onClick: () => void window.api.window.maximize(),
      }),
      h('button.winbtn.winbtn--close', { text: '✕', onClick: () => void window.api.window.close() }),
    ),
  );
}

function render(force = false): void {
  if (!state.settings) return;
  const screen = settings().screen;
  if (!force && !state.dirty && STATIC_SCREENS.has(screen)) return;

  const ctx = context();
  renderTitlebar(ctx);
  renderSidebar(dom.sidebar, ctx);
  renderScreen(dom.main, ctx);
  state.dirty = false;
}

// ── quick palette ─────────────────────────────────────────────────────────

function openPalette(): void {
  state.paletteOpen = true;
  state.paletteBuffer = '';
  renderPalette();
  schedulePaletteClose();
}

function schedulePaletteClose(): void {
  window.clearTimeout(paletteTimer);
  paletteTimer = window.setTimeout(closePalette, PALETTE_MS);
}

function closePalette(): void {
  state.paletteOpen = false;
  state.paletteBuffer = '';
  mount(dom.palette);
}

function renderPalette(): void {
  if (!state.paletteOpen) return;
  const locale = settings().locale;

  mount(
    dom.palette,
    h(
      'div.overlay',
      { onClick: () => closePalette() },
      h(
        'div.palette.palette--overlay',
        {},
        h('div.palette__hint', {
          text: state.paletteBuffer
            ? `${state.paletteBuffer}_`
            : 'DIGITE DUAS LETRAS · FECHA SOZINHO',
        }),
        PALETTE.map((entry) =>
          h(
            'div.palette__row',
            {
              class: entry.code.startsWith(state.paletteBuffer) && state.paletteBuffer
                ? 'palette__row--on'
                : '',
            },
            h('div.palette__code', { text: entry.code }),
            h('div.palette__label', { text: entry.label[locale] }),
          ),
        ),
      ),
    ),
  );
}

function paletteKey(key: string): void {
  if (!/^[a-zA-Z]$/.test(key)) return;
  state.paletteBuffer = (state.paletteBuffer + key.toUpperCase()).slice(-2);
  schedulePaletteClose();

  const entry = state.paletteBuffer.length === 2 ? paletteByCode(state.paletteBuffer) : undefined;
  if (entry) {
    engine.addPaletteTimer(entry, currentClock(), settings().locale);
    toast(`${entry.code} · ${entry.label[settings().locale]}`);
    closePalette();
    state.dirty = true;
    return;
  }
  renderPalette();
}

// ── actions ───────────────────────────────────────────────────────────────

const record = new RecordDialog(dom.record, {
  getSettings: settings,
  onSaved: (id, meta) => {
    state.clips = { ...state.clips, [id]: meta };
    void loadClips();
    void refreshDevices();
    toast(`CLIPE ${id} SALVO`);
  },
  toast,
});

const actions: Actions = {
  setScreen: (screen) => void patchSettings({ screen }).then(() => render(true)),
  patch: (partial) => void patchSettings(partial).then(() => render(true)),

  toggleDead: () => {
    state.deadOverride = !state.deadOverride;
    state.dirty = true;
  },
  toggleFight: () => {
    state.fight = !state.fight;
    state.dirty = true;
  },
  toggleMute: () => {
    const muted = !settings().muted;
    if (muted) audio.stop();
    void patchSettings({ muted }).then(() => render(true));
    toast(muted ? 'MUTED' : 'AUDIO ON');
  },

  toggleSim: () => {
    if (state.match.inMatch) {
      toast('PARTIDA AO VIVO — SIMULAÇÃO DESLIGADA');
      return;
    }
    if (!state.sim.active) {
      state.sim = { active: true, playing: true, clock: Math.max(0, state.clock) };
      engine.reset();
    } else {
      state.sim.playing = !state.sim.playing;
    }
    state.dirty = true;
  },
  simSkip: (seconds) => {
    if (state.match.inMatch) return;
    if (!state.sim.active) state.sim = { active: true, playing: false, clock: Math.max(0, state.clock) };
    state.sim.clock += seconds;
    state.dirty = true;
  },

  markRoshan: () => {
    if (engine.getRoshanMark() === null) {
      engine.markRoshan(currentClock());
      toast(`ROSHAN MARCADO ${mmss(currentClock())}`);
    } else {
      engine.clearRoshan();
      toast('ROSHAN LIMPO');
    }
    state.dirty = true;
  },
  openPalette,
  removeTimer: (key) => {
    engine.removeTimer(key);
    state.dirty = true;
  },

  previewClip: (id) => {
    void audio.preview(id).then((result) => {
      if (result.source === 'silent') toast('SEM CLIPE E SEM TTS');
    });
  },
  recordClip: (id) => record.open([id]),
  recordMissing: () => record.open(CLIPS.filter((c) => !state.clips[c.id]).map((c) => c.id)),
  deleteClip: (id) => {
    void window.api.clips.remove(settings().locale, id).then(async () => {
      await loadClips();
      toast(`CLIPE ${id} APAGADO`);
      render(true);
    });
  },
  revealClips: () => void window.api.clips.reveal(settings().locale),

  installGsi: () => {
    void window.api.gsi.install(null).then(async (result) => {
      toast(result.ok ? 'CONFIG ESCRITA — REINICIE O DOTA' : result.error.toUpperCase());
      state.gsi = await window.api.gsi.status();
      render(true);
    });
  },
  chooseFolder: () => {
    void window.api.gsi.chooseFolder().then(async (dir) => {
      if (!dir) return;
      const result = await window.api.gsi.install(dir);
      toast(result.ok ? 'CONFIG ESCRITA — REINICIE O DOTA' : result.error.toUpperCase());
      state.gsi = await window.api.gsi.status();
      render(true);
    });
  },
  captureHotkey: (name) => {
    state.capturing = state.capturing === name ? null : name;
    state.dirty = true;
    render(true);
  },
  clearHotkey: (name) => {
    state.capturing = null;
    void applyHotkey(name, null);
  },

  copy: (text, what) => {
    void window.api.app.copy(text);
    toast(`${what.toUpperCase()} COPIADO`);
  },
};

/** Translates a key press into an Electron accelerator, or null if unusable. */
function acceleratorFor(event: KeyboardEvent): string | null {
  const modifiers: string[] = [];
  if (event.ctrlKey) modifiers.push('Ctrl');
  if (event.altKey) modifiers.push('Alt');
  if (event.shiftKey) modifiers.push('Shift');
  if (event.metaKey) modifiers.push('Super');

  const code = event.code;
  let key: string | null = null;

  if (/^Numpad[0-9]$/.test(code)) key = `num${code.slice(6)}`;
  else if (code === 'NumpadDecimal') key = 'numdec';
  else if (code === 'NumpadAdd') key = 'numadd';
  else if (code === 'NumpadSubtract') key = 'numsub';
  else if (code === 'NumpadMultiply') key = 'nummult';
  else if (code === 'NumpadDivide') key = 'numdiv';
  else if (/^F[0-9]{1,2}$/.test(code)) key = code;
  else if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
  else if (code === 'Space') key = 'Space';
  else if (code === 'Insert' || code === 'Home' || code === 'End') key = code;

  return key ? [...modifiers, key].join('+') : null;
}

async function applyHotkey(name: HotkeyName, accelerator: string | null): Promise<void> {
  await patchSettings({ hotkeys: { ...settings().hotkeys, [name]: accelerator } });
  const registered = await window.api.hotkeys.register();
  if (accelerator && !registered[name]) {
    toast(`${accelerator.toUpperCase()} JÁ ESTÁ EM USO NO WINDOWS`);
    await patchSettings({ hotkeys: { ...settings().hotkeys, [name]: null } });
  } else if (accelerator) {
    toast(`${name.toUpperCase()} · ${accelerator.toUpperCase()}`);
  }
  render(true);
}

// ── wiring ────────────────────────────────────────────────────────────────

function onPayload(payload: GsiPayload): void {
  state.lastPayload = payload;
  const previous = state.match;
  state.match = tracker.apply(payload);

  const matchId = payload.map?.matchid ?? '';
  if (matchId && matchId !== state.lastMatchId) {
    state.lastMatchId = matchId;
    engine.reset();
    lastTickedClock = null;
  }

  if (state.match.inMatch && !previous.inMatch) {
    state.sim.active = false;
    state.deadOverride = false;
    lastTickedClock = null;
    if (settings().screen === 'idle') void patchSettings({ screen: 'live' });
  }
  if (!state.match.inMatch && previous.inMatch && settings().screen === 'live') {
    void patchSettings({ screen: 'idle' });
  }
  state.dirty = true;
}

function onHotkey(name: string): void {
  if (name === 'mute') actions.toggleMute();
  if (name === 'roshan') actions.markRoshan();
  if (name === 'palette') openPalette();
}

function onKeyDown(event: KeyboardEvent): void {
  if (state.capturing) {
    event.preventDefault();
    const name = state.capturing;
    if (event.key === 'Escape') {
      state.capturing = null;
      render(true);
      return;
    }
    const accelerator = acceleratorFor(event);
    if (!accelerator) return;
    state.capturing = null;
    void applyHotkey(name, accelerator);
    return;
  }

  if (record.handleKey(event)) {
    event.preventDefault();
    return;
  }
  if (state.paletteOpen) {
    if (event.key === 'Escape') closePalette();
    else paletteKey(event.key);
    event.preventDefault();
  }
}

async function boot(): Promise<void> {
  state.settings = await window.api.settings.get();
  applyAudioSettings();

  state.gsi = await window.api.gsi.status();
  await loadClips();
  await refreshDevices();

  window.api.gsi.onPayload(onPayload);
  window.api.gsi.onStatus((status) => {
    state.gsi = { ...status, dotaDirs: state.gsi?.dotaDirs, cfgDir: state.gsi?.cfgDir, cfgInstalled: state.gsi?.cfgInstalled };
    state.dirty = true;
  });
  window.api.hotkeys.onPress(onHotkey);
  window.api.window.onState(({ maximized }) => {
    state.maximized = maximized;
    state.dirty = true;
  });

  document.addEventListener('keydown', onKeyDown);
  navigator.mediaDevices?.addEventListener('devicechange', () => void refreshDevices());

  // GSI goes quiet when Dota closes and nothing tells us, so watch the clock.
  // This has to cover the menu too, not just a live match - Dota posts
  // payloads from the main menu, and those stop the same way.
  window.setInterval(() => {
    const last = state.gsi?.lastPayloadAt;
    if (!last || !state.match.connected) return;
    if (Date.now() - last > GSI_TIMEOUT_MS) {
      state.match = tracker.markDisconnected();
      state.dirty = true;
    }
  }, 4000);

  simAnchor = performance.now();
  window.setInterval(pump, 200);
  window.setInterval(() => render(), 250);
  render(true);
}

void boot();
