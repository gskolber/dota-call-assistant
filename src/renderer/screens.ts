import {
  CLIPS, EVENTS, PALETTE, PHASES, PHASE_FOCUS, ROLES,
  eventAppliesToRole, mmss, phaseFor,
} from '../shared/catalog';
import type {
  ClipId, ClipIndex, GsiPayload, GsiStatus, HotkeyName, Locale, ScreenId, Settings,
} from '../shared/types';
import type { CallEngine, EngineFlags } from './engine';
import type { MatchState } from './match';
import { h, mount } from './dom';

export interface Actions {
  setScreen(screen: ScreenId): void;
  patch(partial: Partial<Settings>): void;
  toggleDead(): void;
  toggleFight(): void;
  toggleMute(): void;
  toggleSim(): void;
  simSkip(seconds: number): void;
  markRoshan(): void;
  openPalette(): void;
  removeTimer(key: string): void;
  previewClip(id: ClipId): void;
  recordClip(id: ClipId): void;
  recordMissing(): void;
  deleteClip(id: ClipId): void;
  revealClips(): void;
  installGsi(): void;
  chooseFolder(): void;
  copy(text: string, label: string): void;
  captureHotkey(name: HotkeyName): void;
  clearHotkey(name: HotkeyName): void;
}

export interface Ctx {
  settings: Settings;
  clock: number;
  match: MatchState;
  gsi: GsiStatus | null;
  engine: CallEngine;
  flags: EngineFlags;
  clips: ClipIndex;
  speaking: { text: string; source: string } | null;
  sim: { active: boolean; playing: boolean };
  devices: { inputs: MediaDeviceInfo[]; outputs: MediaDeviceInfo[] };
  lastPayload: GsiPayload | null;
  /** the hotkey slot currently waiting for a key press, if any */
  capturing: HotkeyName | null;
  actions: Actions;
}

const HOTKEY_LABELS: Record<HotkeyName, string> = {
  mute: 'GLOBAL MUTE',
  roshan: 'MARK ROSHAN',
  palette: 'QUICK PALETTE',
};

const NAV: { id: ScreenId; label: string }[] = [
  { id: 'live', label: '01 · LIVE MATCH' },
  { id: 'panel', label: '02 · ROLE PANEL' },
  { id: 'timers', label: '03 · MANUAL TIMERS' },
  { id: 'role', label: '04 · CALL SET' },
  { id: 'audio', label: '05 · AUDIO' },
  { id: 'gsi', label: '06 · GSI SETUP' },
  { id: 'idle', label: '07 · NO MATCH' },
];

const label = (text: string): HTMLElement => h('div.label', { text });
const panelHead = (text: string, ...extra: HTMLElement[]): HTMLElement =>
  h('div.panel__head', {}, text, ...extra);

function isNight(ctx: Ctx): boolean {
  if (ctx.match.inMatch) return !ctx.match.daytime;
  return Math.floor(Math.max(0, ctx.clock) / 300) % 2 === 1;
}

function flipIn(clock: number): number {
  const next = (Math.floor(Math.max(0, clock) / 300) + 1) * 300;
  return next - clock;
}

function suppressionReason(ctx: Ctx): string | null {
  if (ctx.flags.muted) return 'GLOBAL MUTE';
  if (ctx.flags.paused) return 'GAME PAUSED';
  if (ctx.flags.dead) return 'PLAYER DEAD';
  if (ctx.flags.fight) return 'TEAMFIGHT — P5 ONLY';
  return null;
}

// ── sidebar ───────────────────────────────────────────────────────────────

export function renderSidebar(root: HTMLElement, ctx: Ctx): void {
  const { settings, actions } = ctx;
  const connected = ctx.gsi?.listening && ctx.match.connected;

  mount(
    root,
    h('div.sidebar__head', { text: 'SCREENS' }),
    h(
      'div.nav',
      {},
      NAV.map((item) =>
        h('div.nav__item', {
          text: item.label,
          class: settings.screen === item.id ? 'nav__item--active' : '',
          onClick: () => actions.setScreen(item.id),
        }),
      ),
    ),
    h(
      'div.sim',
      {},
      label('SIMULATION'),
      h(
        'div.sim__row',
        {},
        h('button.btn', {
          text: ctx.sim.active && ctx.sim.playing ? 'PAUSE' : 'PLAY',
          class: ctx.sim.active ? 'btn--on' : '',
          onClick: () => actions.toggleSim(),
        }),
        h('button.btn', { text: '+30s', onClick: () => actions.simSkip(30) }),
      ),
      h('button.btn', {
        text: settings.muted ? 'MUTED — F9' : 'AUDIO ON — F9',
        class: settings.muted ? 'btn--alert' : '',
        onClick: () => actions.toggleMute(),
      }),
      h('div.hint', {
        html: [
          `GLOBAL TOGGLE · ${settings.hotkeys.mute ?? '—'}`,
          `ROSHAN · ${settings.hotkeys.roshan ?? '—'}`,
          `PALETTE · ${settings.hotkeys.palette ?? '—'}`,
        ].join('<br />'),
      }),
    ),
    h(
      'div.sidebar__foot',
      {},
      `GSI ${ctx.gsi?.host ?? '127.0.0.1'}:${ctx.gsi?.port ?? 3000}`,
      h('br'),
      h('span', {
        class: connected ? 'dot' : 'dot--off',
        text: connected ? '● CONNECTED' : ctx.gsi?.listening ? '● WAITING FOR DOTA' : '● OFFLINE',
      }),
    ),
  );
}

// ── 01 live ───────────────────────────────────────────────────────────────

function liveScreen(ctx: Ctx): HTMLElement {
  const { actions, engine, flags, clock } = ctx;
  const queue = engine.queue(clock, flags, 5);
  const next = queue[0];
  const suppressed = suppressionReason(ctx);
  const spoken = engine.spokenInWindow(clock);

  return h(
    'div',
    {},
    h(
      'div.topbar',
      {},
      h('div.topbar__cell.topbar__cell--strong', { text: `ROLE · ${ctx.settings.role}` }),
      h('div.topbar__cell', { text: `MODE · ${ctx.settings.verbose ? 'VERBOSE' : 'DRY'}` }),
      h('div.topbar__cell.topbar__spacer', {}),
      h('button.toggle', {
        text: 'DEAD',
        class: flags.dead ? 'toggle--on' : '',
        onClick: () => actions.toggleDead(),
      }),
      h('button.toggle', {
        text: 'FIGHT',
        class: flags.fight ? 'toggle--on' : '',
        onClick: () => actions.toggleFight(),
      }),
      h('div.toggle', { text: 'PAUSED', class: flags.paused ? 'toggle--on' : '' }),
    ),

    h(
      'div.grid2.grid2--rule.split',
      {},
      h(
        'div.pad',
        {},
        label('CLOCK'),
        h('div.clock', { text: mmss(clock) }),
        h(
          'div.daynight',
          {},
          h('div.tag', { text: isNight(ctx) ? 'NIGHT' : 'DAY' }),
          h('div.muted-note', { text: `FLIP IN ${mmss(flipIn(clock))}` }),
          ctx.match.inMatch && !ctx.match.alive
            ? h('div.muted-note', { text: `RESPAWN ${mmss(ctx.match.respawnSeconds)}` })
            : null,
        ),
      ),
      h(
        'div.pad.next',
        {},
        h(
          'div',
          {},
          label('NEXT CALL'),
          h('div.next__label', { text: next ? next.label : '—' }),
          h('div.next__meta', {
            text: next
              ? `SPEAKS IN ${mmss(next.inSeconds)} · AT ${mmss(next.fireAt)} · P${next.priority}`
              : 'NOTHING SCHEDULED',
          }),
        ),
        ctx.speaking && !suppressed
          ? h('div.speaking', { text: `▶ ${ctx.speaking.text}` })
          : null,
        suppressed ? h('div.silent', { text: `SILENT — ${suppressed}` }) : null,
      ),
    ),

    h(
      'div.grid2.grid2--rule.fill',
      {},
      h(
        'div',
        {},
        panelHead('QUEUE · SORTED BY FIRE TIME'),
        queue.length
          ? queue.map((item) =>
              h(
                'div.row',
                {},
                h('div.row__p', { text: `P${item.priority}` }),
                h('div.row__label', { text: item.label }),
                h('div.row__meta', { text: item.roles }),
                h('div.row__time', { text: mmss(item.inSeconds) }),
              ),
            )
          : h('div.empty', { text: 'NOTHING IN RANGE FOR THIS ROLE' }),
        h(
          'div.budget',
          {},
          h('div', { class: 'label', text: 'BUDGET' }),
          h(
            'div.budget__bar',
            {},
            Array.from({ length: Math.max(1, ctx.settings.budget) }, (_, i) =>
              h('div.budget__cell', { class: i < spoken ? 'budget__cell--on' : '' }),
            ),
          ),
          h('div', { style: 'font-size:11px;font-weight:700', text: `${spoken}/${ctx.settings.budget}` }),
        ),
      ),
      h(
        'div',
        {},
        panelHead('LOG'),
        engine.getLog().length
          ? engine.getLog().slice(0, 8).map((entry) =>
              h(
                'div.row',
                {},
                h('div.row__meta', { style: 'width:44px;font-variant-numeric:tabular-nums', text: entry.at }),
                h('div.row__label', { style: 'font-size:13px', text: entry.label }),
                h('div.state', {
                  class: entry.state === 'SPOKEN' ? 'state--spoken' : '',
                  text: entry.state,
                }),
              ),
            )
          : h('div.empty', { text: 'NO CALLS YET' }),
      ),
    ),
  );
}

// ── 02 role panel ─────────────────────────────────────────────────────────

function panelScreen(ctx: Ctx): HTMLElement {
  const { match, settings, clock } = ctx;
  const phase = phaseFor(Math.max(0, clock));
  const locale = settings.locale;
  const next = ctx.engine.queue(clock, ctx.flags, 1)[0];

  const discipline: { text: string; bad: boolean }[] = [];
  if (match.inMatch) {
    discipline.push({
      text: match.lastSentryPlacedAt === null
        ? 'NO SENTRY PLACED THIS MATCH'
        : `LAST SENTRY PLACED AT ${mmss(match.lastSentryPlacedAt)}`,
      bad: match.lastSentryPlacedAt === null || clock - match.lastSentryPlacedAt > 180,
    });
    discipline.push({
      text: match.smokes ? `SMOKE AVAILABLE · ${match.smokes} IN BAG` : 'NO SMOKE IN BAG',
      bad: !match.smokes,
    });
    discipline.push({
      text: `${match.observers} OBSERVER${match.observers === 1 ? '' : 'S'} CARRIED`,
      bad: match.observers === 0,
    });
    discipline.push({
      text: match.hasTp ? 'TP IN INVENTORY · OK' : 'NO TP IN INVENTORY',
      bad: !match.hasTp,
    });
    discipline.push({
      text: match.buybackCost > 0 && match.gold < match.buybackCost
        ? `NO BUYBACK · ${match.gold}/${match.buybackCost}`
        : `BUYBACK OK · ${match.gold}/${match.buybackCost || '—'}`,
      bad: match.buybackCost > 0 && match.gold < match.buybackCost,
    });
  }

  return h(
    'div',
    {},
    h(
      'div.screen__head',
      {},
      h('div.screen__title', { text: 'ROLE PANEL' }),
      h('div.screen__sub', { text: 'NEVER SPOKEN · READ AT A GLANCE' }),
    ),
    h(
      'div.topbar',
      {},
      PHASES.map((p) =>
        h('div.topbar__cell', {
          text: p.label,
          style: 'flex:1',
          class: p.id === phase ? 'topbar__cell--strong' : '',
          ...(p.id === phase ? { } : {}),
        }),
      ),
    ),
    h(
      'div.grid2.grid2--rule.fill',
      {},
      h(
        'div',
        {},
        panelHead('DISCIPLINE'),
        discipline.length
          ? discipline.map((item) =>
              h('div.row', {}, h('div.row__label', {
                text: item.text,
                style: item.bad ? 'color:var(--alert)' : '',
              })),
            )
          : h('div.empty', { text: 'WAITING FOR A MATCH — ITEM STATE COMES FROM GSI' }),
      ),
      h(
        'div',
        {},
        panelHead(`PHASE FOCUS · ${settings.role}`),
        h('div', {
          style: 'padding:18px;font-size:16px;line-height:1.5;text-wrap:pretty',
          text: PHASE_FOCUS[settings.role][phase][locale],
        }),
        h(
          'div',
          { style: 'border-top:2px solid var(--ink);padding:18px;display:flex;flex-direction:column;gap:10px' },
          label('NEXT WINDOW CLOSES'),
          h('div', {
            style: "font-family:var(--display);font-size:38px;line-height:1",
            text: next ? `${next.label} · ${mmss(next.fireAt + 0)}` : '—',
          }),
        ),
      ),
    ),
  );
}

// ── 03 manual timers ──────────────────────────────────────────────────────

function timersScreen(ctx: Ctx): HTMLElement {
  const { engine, actions, clock, settings } = ctx;
  const mark = engine.getRoshanMark();
  const roshan = engine.getTimers().filter((t) => t.source === 'roshan');
  const manual = engine.getTimers().filter((t) => t.source === 'palette');

  return h(
    'div',
    {},
    h(
      'div.screen__head',
      {},
      h('div.screen__title', { text: 'MANUAL TIMERS' }),
      h('div.screen__sub', { text: 'HOTKEYS LISTEN ONLY · NO INPUT SENT TO DOTA' }),
    ),
    h(
      'div.grid2.grid2--rule.fill',
      { style: 'grid-template-columns:1.1fr 1fr' },
      h(
        'div',
        {},
        panelHead('ROSHAN CHAIN'),
        h(
          'div',
          { style: 'padding:20px 18px' },
          h('button.btn', {
            style: 'width:100%;border-width:4px;padding:16px;font-family:var(--display);font-size:24px',
            class: mark === null ? '' : 'btn--on',
            text: mark === null ? 'START ROSHAN' : `KILLED ${mmss(mark)}`,
            onClick: () => actions.markRoshan(),
          }),
          h('div.hint', {
            style: 'margin-top:8px;text-align:center',
            text: `${settings.hotkeys.roshan ?? '—'} · REMAP EM 05 · AUDIO`,
          }),
          h(
            'div',
            { style: 'margin-top:20px' },
            roshan.length
              ? roshan.map((timer) =>
                  h(
                    'div.row',
                    { style: 'padding-left:0;padding-right:0' },
                    h('div.row__p', { text: `P${timer.priority}` }),
                    h('div.row__label', { text: timer.label }),
                    h('div.row__time', { text: mmss(timer.endsAt - clock) }),
                  ),
                )
              : h('div.empty', { style: 'padding-left:0', text: 'NO ROSHAN MARKED' }),
          ),
        ),
      ),
      h(
        'div',
        {},
        panelHead(`QUICK PALETTE · ${settings.hotkeys.palette ?? '—'}`),
        h(
          'div',
          { style: 'padding:20px 18px' },
          h(
            'div.palette',
            { style: 'width:auto' },
            h('div.palette__hint', { text: 'TYPE TWO LETTERS · AUTO-DISMISS 2s' }),
            PALETTE.map((entry) =>
              h(
                'div.palette__row',
                {},
                h('div.palette__code', { text: entry.code }),
                h('div.palette__label', { text: entry.label[settings.locale] }),
              ),
            ),
          ),
          h('div.label', { style: 'margin-top:20px;margin-bottom:10px', text: 'ACTIVE' }),
          manual.length
            ? manual.map((timer) =>
                h(
                  'div.row',
                  { style: 'padding-left:0;padding-right:0' },
                  h('div.row__label', { text: timer.label }),
                  h('div.row__time', { text: mmss(timer.endsAt - clock) }),
                  h('button.icon.icon--ghost', {
                    text: '✕',
                    onClick: () => actions.removeTimer(timer.key),
                  }),
                ),
              )
            : h('div.empty', { style: 'padding-left:0', text: 'NO MANUAL TIMER RUNNING' }),
          ctx.match.inMatch && !ctx.match.alive
            ? h(
                'div.row',
                { style: 'padding-left:0;padding-right:0' },
                h('div.row__label', { text: 'MY RESPAWN' }),
                h('div.row__time', { text: mmss(ctx.match.respawnSeconds) }),
              )
            : null,
        ),
      ),
    ),
  );
}

// ── 04 call set ───────────────────────────────────────────────────────────

function roleScreen(ctx: Ctx): HTMLElement {
  const { settings, actions } = ctx;
  const inSet = EVENTS.filter((e) => eventAppliesToRole(e.roles, settings.role));
  const outOfSet = EVENTS.filter((e) => !eventAppliesToRole(e.roles, settings.role));

  return h(
    'div',
    {},
    h(
      'div.screen__head',
      {},
      h('div.screen__title', { text: 'CALL SET' }),
      h('div.screen__sub', { text: 'PICK A ROLE · GET A CURATED SET' }),
    ),
    h(
      'div.topbar',
      {},
      ROLES.map((role) =>
        h(
          'div.topbar__cell',
          {
            style: `flex:1;cursor:pointer;${
              settings.role === role.id ? 'background:var(--ink);color:var(--acid)' : ''
            }`,
            onClick: () => actions.patch({ role: role.id }),
          },
          h('div', { style: 'font-family:var(--display);font-size:26px;line-height:1', text: role.id }),
          h('div', {
            style: 'font-size:10px;letter-spacing:0.14em;margin-top:6px',
            text: role.name[settings.locale],
          }),
        ),
      ),
    ),
    h(
      'div.grid2.grid2--rule.fill',
      {},
      h(
        'div',
        {},
        panelHead(`IN THE SET · ${settings.role}`),
        inSet.map((event) => {
          const muted = settings.mutedEvents.includes(event.id);
          return h(
            'div.row.row--center',
            { class: muted ? 'row--dim' : '' },
            h('div', {
              class: muted ? 'box box--off' : 'box',
              style: 'cursor:pointer',
              onClick: () =>
                actions.patch({
                  mutedEvents: muted
                    ? settings.mutedEvents.filter((id) => id !== event.id)
                    : [...settings.mutedEvents, event.id],
                }),
            }),
            h('div.row__label', { text: event.label }),
            h('div.row__meta', {
              text: event.kind === 'absolute'
                ? `AT ${mmss(event.at)}`
                : `${mmss(event.window[0])}–${mmss(event.window[1])}`,
            }),
          );
        }),
      ),
      h(
        'div',
        {},
        panelHead('MUTED FOR THIS ROLE'),
        outOfSet.length
          ? outOfSet.map((event) =>
              h(
                'div.row.row--center.row--dim',
                {},
                h('div.box.box--off'),
                h('div.row__label', { text: event.label }),
              ),
            )
          : h('div.empty', { text: 'THIS ROLE HEARS EVERYTHING' }),
        h('div.note', {
          text: 'Clique no quadrado à esquerda para silenciar um evento individual. O conjunto por função já cobre o normal — ninguém configura trinta caixas no meio da fila.',
        }),
      ),
    ),
  );
}

// ── 05 audio ──────────────────────────────────────────────────────────────

function clipRow(ctx: Ctx, clip: { id: ClipId }, locale: Locale): HTMLElement {
  const meta = ctx.clips[clip.id];
  const text = CLIPS.find((c) => c.id === clip.id)?.text[locale];
  const spoken = ctx.settings.verbose ? text?.verbose : text?.dry;

  return h(
    'div.clip',
    {},
    h('button.icon', { text: '▶', title: 'Ouvir', onClick: () => ctx.actions.previewClip(clip.id) }),
    h(
      'div.clip__id',
      {},
      h('div.clip__name', { text: clip.id }),
      h('div.clip__text', { text: spoken ?? '' }),
    ),
    h('div.clip__len', {
      text: meta ? (meta.durationMs ? `${(meta.durationMs / 1000).toFixed(1)}s` : 'ok') : 'TTS',
      style: meta ? '' : 'color:var(--grey)',
    }),
    h('button.icon.icon--rec', {
      text: '●',
      title: meta ? 'Regravar' : 'Gravar',
      onClick: () => ctx.actions.recordClip(clip.id),
    }),
    meta
      ? h('button.icon.icon--ghost', {
          text: '✕',
          title: 'Apagar gravação',
          onClick: () => ctx.actions.deleteClip(clip.id),
        })
      : null,
  );
}

function audioScreen(ctx: Ctx): HTMLElement {
  const { settings, actions } = ctx;
  const volumeCells = 16;
  const filled = Math.round(settings.volume * volumeCells);
  const recorded = CLIPS.filter((c) => ctx.clips[c.id]).length;

  return h(
    'div',
    {},
    h(
      'div.screen__head',
      {},
      h('div.screen__title', { text: 'AUDIO' }),
      h('div.screen__sub', {
        text: `${recorded}/${CLIPS.length} GRAVADOS · O RESTO SAI NA VOZ DO WINDOWS`,
      }),
    ),
    h(
      'div.grid2.grid2--rule.fill',
      {},
      h(
        'div.stack',
        {},
        h(
          'div',
          {},
          label('CALL VOLUME'),
          h(
            'div.meter',
            {},
            Array.from({ length: volumeCells }, (_, i) =>
              h('div.meter__cell', {
                class: i < filled ? 'meter__cell--on' : '',
                style: `height:${12 + i * 2}px`,
                onClick: () => actions.patch({ volume: (i + 1) / volumeCells }),
              }),
            ),
          ),
          h('div', {
            style: 'font-size:12px;font-weight:700;margin-top:8px',
            text: `${Math.round(settings.volume * 100)}%`,
          }),
        ),
        h(
          'div',
          {},
          label('VERBOSITY'),
          h(
            'div.choices',
            {},
            h('button.choice', {
              style: 'flex:1',
              text: 'DRY · "STACK"',
              class: settings.verbose ? '' : 'choice--on',
              onClick: () => actions.patch({ verbose: false }),
            }),
            h('button.choice', {
              style: 'flex:1',
              text: 'VERBOSE · "STACK EM 5"',
              class: settings.verbose ? 'choice--on' : '',
              onClick: () => actions.patch({ verbose: true }),
            }),
          ),
        ),
        h(
          'div',
          {},
          label('CALL BUDGET · PER MINUTE'),
          h(
            'div.choices',
            {},
            [2, 3, 4, 6, 8].map((n) =>
              h('button.choice.choice--num', {
                text: String(n),
                class: settings.budget === n ? 'choice--on' : '',
                onClick: () => actions.patch({ budget: n }),
              }),
            ),
          ),
        ),
        h(
          'div',
          {},
          label('LOCALE'),
          h(
            'div.choices',
            {},
            (['pt-BR', 'en'] as Locale[]).map((locale) =>
              h('button.choice', {
                text: locale.toUpperCase(),
                class: settings.locale === locale ? 'choice--on' : '',
                onClick: () => actions.patch({ locale }),
              }),
            ),
            h('button.choice', {
              text: settings.ttsFallback ? 'TTS FALLBACK · ON' : 'TTS FALLBACK · OFF',
              class: settings.ttsFallback ? 'choice--on' : '',
              onClick: () => actions.patch({ ttsFallback: !settings.ttsFallback }),
            }),
          ),
        ),
        h(
          'div',
          {},
          label('OUTPUT DEVICE'),
          h(
            'select.select',
            {
              onChange: (event) =>
                actions.patch({ outputDeviceId: (event.target as HTMLSelectElement).value }),
            },
            h('option', { attrs: { value: 'default' }, text: 'Padrão do Windows' }),
            ctx.devices.outputs.map((device) =>
              h('option', {
                attrs: { value: device.deviceId, selected: settings.outputDeviceId === device.deviceId },
                text: device.label || device.deviceId,
              }),
            ),
          ),
        ),
        h(
          'div',
          {},
          label('GLOBAL HOTKEYS'),
          h('div.hint', {
            style: 'margin-bottom:8px',
            text: 'Funcionam com o Dota em foco. O app só escuta — nada é enviado ao jogo.',
          }),
          (Object.keys(HOTKEY_LABELS) as HotkeyName[]).map((name) =>
            h(
              'div.row.row--center',
              { style: 'padding-left:0;padding-right:0' },
              h('div.row__label', { text: HOTKEY_LABELS[name] }),
              h('button.choice', {
                text: ctx.capturing === name
                  ? 'PRESSIONE UMA TECLA'
                  : (settings.hotkeys[name] ?? 'NENHUMA'),
                class: ctx.capturing === name ? 'choice--on' : '',
                onClick: () => actions.captureHotkey(name),
              }),
              h('button.icon.icon--ghost', {
                text: '✕',
                title: 'Remover atalho',
                onClick: () => actions.clearHotkey(name),
              }),
            ),
          ),
        ),
        h(
          'div',
          {},
          label('MICROPHONE'),
          h(
            'select.select',
            {
              onChange: (event) =>
                actions.patch({ inputDeviceId: (event.target as HTMLSelectElement).value }),
            },
            h('option', { attrs: { value: 'default' }, text: 'Padrão do Windows' }),
            ctx.devices.inputs.map((device) =>
              h('option', {
                attrs: { value: device.deviceId, selected: settings.inputDeviceId === device.deviceId },
                text: device.label || device.deviceId,
              }),
            ),
          ),
        ),
      ),
      h(
        'div',
        {},
        panelHead(
          `CLIP LIBRARY · ${settings.locale}`,
          h('button.btn.btn--tight', { text: 'GRAVAR FALTANTES', onClick: () => actions.recordMissing() }),
          h('button.btn.btn--tight', { text: 'PASTA', onClick: () => actions.revealClips() }),
        ),
        CLIPS.map((clip) => clipRow(ctx, clip, settings.locale)),
      ),
    ),
  );
}

// ── 06 gsi ────────────────────────────────────────────────────────────────

function gsiScreen(ctx: Ctx): HTMLElement {
  const { gsi, actions } = ctx;
  const connected = !!gsi?.lastPayloadAt && Date.now() - gsi.lastPayloadAt < 10_000;
  const since = gsi?.lastPayloadAt ? ((Date.now() - gsi.lastPayloadAt) / 1000).toFixed(1) : '—';

  const diagnostics: [string, string][] = [
    ['LISTEN ADDRESS', `${gsi?.host ?? '127.0.0.1'}:${gsi?.port ?? 3000}`],
    ['AUTH TOKEN', gsi?.token ? `${gsi.token.slice(0, 4)}…${gsi.token.slice(-4)}` : '—'],
    ['PAYLOADS RECEIVED', String(gsi?.payloads ?? 0)],
    ['REJECTED', String(gsi?.rejected ?? 0)],
    ['AVG RESPONSE', gsi?.avgMs ? `${gsi.avgMs.toFixed(1)} ms` : '—'],
    ['RECONNECTS', String(gsi?.reconnects ?? 0)],
  ];

  return h(
    'div',
    {},
    h(
      'div.screen__head',
      {},
      h('div.screen__title', { text: 'GSI SETUP' }),
      h('div.screen__sub', { text: 'OFFICIAL VALVE INTEGRATION' }),
    ),
    h(
      'div.grid2.grid2--rule.fill',
      {},
      h(
        'div',
        {},
        h(
          'div.status',
          {},
          h('div', { class: connected ? 'status__lamp' : 'status__lamp status__lamp--off' }),
          h('div.status__title', { text: connected ? 'CONNECTED' : gsi?.listening ? 'WAITING' : 'OFFLINE' }),
          h('div', { style: 'flex:1' }),
          h('div.row__meta', { text: connected ? `LAST PAYLOAD ${since}s AGO` : (gsi?.error ?? 'NO PAYLOAD YET') }),
        ),
        h(
          'div',
          { style: 'padding:18px;display:flex;flex-direction:column;gap:18px' },
          h(
            'div',
            {},
            h('div.label', {
              style: 'margin-bottom:8px',
              text: gsi?.cfgInstalled ? 'STEP 1 · CONFIG WRITTEN' : 'STEP 1 · CONFIG MISSING',
            }),
            h('div.path', {
              text: gsi?.cfgDir
                ? `${gsi.cfgDir}\\gamestate_integration_callassistant.cfg`
                : 'Pasta do Dota 2 não encontrada automaticamente.',
            }),
            h(
              'div.choices',
              { style: 'margin-top:8px' },
              h('button.btn.btn--tight', {
                text: gsi?.cfgInstalled ? 'REWRITE' : 'WRITE CONFIG',
                onClick: () => actions.installGsi(),
              }),
              h('button.btn.btn--tight', { text: 'CHOOSE FOLDER', onClick: () => actions.chooseFolder() }),
            ),
          ),
          h(
            'div',
            {},
            h('div.label', { style: 'margin-bottom:8px', text: 'STEP 2 · YOU MUST DO THIS ONE' }),
            h('div', {
              style: 'font-size:13px;line-height:1.5;margin-bottom:8px;text-wrap:pretty',
              text: 'Adicione isto nas opções de inicialização do Dota 2 no Steam. O app não pode fazer isso por você.',
            }),
            h(
              'div.launch',
              {},
              h('div.launch__value', { text: '-gamestateintegration' }),
              h('button.launch__copy', {
                text: 'COPY',
                onClick: () => actions.copy('-gamestateintegration', 'launch option'),
              }),
            ),
          ),
          h(
            'div',
            {},
            h('div.label', { style: 'margin-bottom:8px', text: 'STEP 3 · RESTART DOTA' }),
            h('div.hint', {
              text: 'O Dota lê os arquivos de GSI só na inicialização. Se o app já estava aberto, feche e abra o jogo de novo.',
            }),
          ),
        ),
      ),
      h(
        'div',
        {},
        panelHead('DIAGNOSTICS'),
        diagnostics.map(([key, value]) =>
          h(
            'div.row',
            {},
            h('div', { style: 'flex:1;font-size:12px;letter-spacing:0.08em;color:var(--dark)', text: key }),
            h('div', { style: 'font-size:13px;font-weight:700', text: value }),
          ),
        ),
        h(
          'div',
          { style: 'padding:18px' },
          h('div.label', { style: 'margin-bottom:8px', text: 'LAST PAYLOAD' }),
          h('div.payload', {
            text: ctx.lastPayload
              ? JSON.stringify(
                  { map: ctx.lastPayload.map, player: ctx.lastPayload.player, hero: ctx.lastPayload.hero },
                  null,
                  2,
                )
              : 'nada recebido ainda',
          }),
        ),
      ),
    ),
  );
}

// ── 07 idle ───────────────────────────────────────────────────────────────

function idleScreen(ctx: Ctx): HTMLElement {
  const { gsi, settings } = ctx;
  return h(
    'div.idle',
    {},
    h(
      'div.idle__body',
      {},
      h('div.idle__title', { html: 'NO<br />MATCH' }),
      h('div', {
        style: 'font-size:14px;letter-spacing:0.1em;color:var(--dark)',
        text: `LISTENING ON ${gsi?.host ?? '127.0.0.1'}:${gsi?.port ?? 3000} · ${
          gsi?.listening ? 'IDLE' : 'OFFLINE'
        }`,
      }),
      h(
        'div.choices',
        { style: 'margin-top:6px' },
        h('div.tag', { text: `ROLE · ${settings.role}` }),
        h('div.tag.tag--outline', { text: settings.verbose ? 'VERBOSE' : 'DRY' }),
        h('div.tag.tag--outline', { text: `BUDGET ${settings.budget}/MIN` }),
      ),
    ),
    h(
      'div.idle__foot',
      {},
      h('div.hint', { html: 'HOTKEYS ONLY LISTEN.<br />NO INPUT IS SENT TO DOTA.' }),
      h('div.hint', { html: 'NO ACCOUNT. NO TELEMETRY.<br />NOTHING LEAVES THIS MACHINE.' }),
      h('div', { style: 'flex:1' }),
      h('div.hint', { html: 'TIMINGS VALIDATED<br />PATCH 7.41e' }),
    ),
  );
}

// ── router ────────────────────────────────────────────────────────────────

export function renderScreen(root: HTMLElement, ctx: Ctx): void {
  const screens: Record<ScreenId, (c: Ctx) => HTMLElement> = {
    live: liveScreen,
    panel: panelScreen,
    timers: timersScreen,
    role: roleScreen,
    audio: audioScreen,
    gsi: gsiScreen,
    idle: idleScreen,
  };
  mount(root, screens[ctx.settings.screen](ctx));
}
