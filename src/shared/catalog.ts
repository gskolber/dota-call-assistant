import type { MessageKey } from './i18n';
import type { ClipId, Locale, Priority, RoleId } from './types';

export interface CallText {
  /** short form, spoken when verbosity is DRY */
  dry: string;
  /** long form, spoken when verbosity is VERBOSE */
  verbose: string;
}

interface EventBase {
  id: string;
  /** uppercase display label */
  label: string;
  /** how many seconds before the event fires the call is spoken */
  lead: number;
  roles: RoleId[] | 'ALL';
  priority: Priority;
  clip: ClipId;
  text: Record<Locale, CallText>;
}

export interface CyclicEvent extends EventBase {
  kind: 'cyclic';
  /** period in seconds */
  every: number;
  /** offset inside the period */
  at: number;
  /**
   * Offset on the Dire side, when the mirrored map moves it. The towers are
   * not the same distance apart on both halves, so a pull that works at :44
   * for Radiant needs :45 for Dire.
   */
  atDire?: number;
  /** takes its offset from this setting instead of `at`, because there is no
   *  single correct second for it */
  atSetting?: 'stackSecond';
  /** [from, to] clock range in which the event is relevant */
  window: [number, number];
}

export interface AbsoluteEvent extends EventBase {
  kind: 'absolute';
  /** clock time in seconds */
  at: number;
}

export type ScheduledEvent = CyclicEvent | AbsoluteEvent;

const ALL = 'ALL' as const;
const SUPPORTS: RoleId[] = ['POS 4', 'POS 5'];

/**
 * Timings follow patch 7.41e. Clock is Dota's `map.clock_time`, i.e. the
 * horn is 0:00 and pre-horn values are negative.
 */
export const EVENTS: ScheduledEvent[] = [
  {
    // Ten seconds of lead is what it takes to leave the lane and reach the
    // camp; five never was. The window opens at 1:00 because the camps are
    // empty until then — the first creeps spawn at 1:00, so the first camp
    // that can be pulled out of its box is the 2:00 one.
    // The second itself is a setting: guides put it anywhere from 52 to 56
    // depending on camp size and on whether the camp is already stacked, and
    // the app cannot know which camp you are walking to.
    id: 'stack', label: 'STACK', kind: 'cyclic', every: 60, at: 53, atSetting: 'stackSecond',
    lead: 10, window: [60, 1800], roles: ['POS 1', 'POS 4', 'POS 5'], priority: 2, clip: 'stack',
    text: {
      'pt-BR': { dry: 'Stack', verbose: 'Stack em dez' },
      en: { dry: 'Stack', verbose: 'Stack in ten' },
    },
  },
  {
    id: 'pull', label: 'PULL', kind: 'cyclic', every: 60, at: 14, lead: 6,
    window: [60, 900], roles: SUPPORTS, priority: 2, clip: 'pull',
    text: {
      'pt-BR': { dry: 'Pull', verbose: 'Pull em seis' },
      en: { dry: 'Pull', verbose: 'Pull in six' },
    },
  },
  {
    // The second pull of the minute, and the one place the mirrored map bites:
    // the gap between the towers differs, so Dire pulls a second later.
    id: 'pull_second', label: 'SECOND PULL', kind: 'cyclic', every: 60, at: 44, atDire: 45,
    lead: 6, window: [60, 900], roles: SUPPORTS, priority: 2, clip: 'pull',
    text: {
      'pt-BR': { dry: 'Pull', verbose: 'Segundo pull em seis' },
      en: { dry: 'Pull', verbose: 'Second pull in six' },
    },
  },
  {
    id: 'bounty', label: 'BOUNTY RUNE', kind: 'cyclic', every: 180, at: 0, lead: 10,
    window: [0, 3600], roles: ALL, priority: 3, clip: 'bounty',
    text: {
      'pt-BR': { dry: 'Bounty', verbose: 'Bounty em dez' },
      en: { dry: 'Bounty', verbose: 'Bounty in ten' },
    },
  },
  {
    id: 'power_rune', label: 'POWER RUNE', kind: 'cyclic', every: 120, at: 0, lead: 15,
    window: [360, 3600], roles: ALL, priority: 3, clip: 'power_rune',
    text: {
      'pt-BR': { dry: 'Runa de poder', verbose: 'Runa de poder em quinze' },
      en: { dry: 'Power rune', verbose: 'Power rune in fifteen' },
    },
  },
  {
    id: 'wisdom', label: 'WISDOM RUNE', kind: 'cyclic', every: 420, at: 0, lead: 20,
    window: [420, 3600], roles: ['POS 2', 'POS 4', 'POS 5'], priority: 3, clip: 'wisdom',
    text: {
      'pt-BR': { dry: 'Wisdom', verbose: 'Wisdom em vinte' },
      en: { dry: 'Wisdom', verbose: 'Wisdom in twenty' },
    },
  },
  {
    id: 'night', label: 'NIGHT', kind: 'cyclic', every: 600, at: 300, lead: 10,
    window: [300, 4800], roles: ALL, priority: 2, clip: 'night',
    text: {
      'pt-BR': { dry: 'Noite', verbose: 'Noite em dez' },
      en: { dry: 'Night', verbose: 'Night in ten' },
    },
  },
  {
    id: 'day', label: 'DAY', kind: 'cyclic', every: 600, at: 600, lead: 10,
    window: [600, 4800], roles: ALL, priority: 2, clip: 'day',
    text: {
      'pt-BR': { dry: 'Dia', verbose: 'Dia em dez' },
      en: { dry: 'Day', verbose: 'Day in ten' },
    },
  },
  {
    id: 'tier_two', label: 'NEUTRAL TIER 2', kind: 'absolute', at: 1050, lead: 10,
    roles: ALL, priority: 2, clip: 'tier_two',
    text: {
      'pt-BR': { dry: 'Tier dois', verbose: 'Neutros tier dois em dez' },
      en: { dry: 'Tier two', verbose: 'Tier two neutrals in ten' },
    },
  },
  {
    id: 'tier_three', label: 'NEUTRAL TIER 3', kind: 'absolute', at: 1650, lead: 10,
    roles: ALL, priority: 2, clip: 'tier_three',
    text: {
      'pt-BR': { dry: 'Tier três', verbose: 'Neutros tier três em dez' },
      en: { dry: 'Tier three', verbose: 'Tier three neutrals in ten' },
    },
  },
  {
    id: 'tormentor', label: 'TORMENTOR', kind: 'absolute', at: 1200, lead: 30,
    roles: ALL, priority: 4, clip: 'tormentor',
    text: {
      'pt-BR': { dry: 'Tormentor', verbose: 'Tormentor em trinta' },
      en: { dry: 'Tormentor', verbose: 'Tormentor in thirty' },
    },
  },
];

/** Chain that unrolls from a manually marked Roshan kill. */
export interface RoshanStep {
  id: string;
  label: string;
  /** seconds after the kill */
  offset: number;
  lead: number;
  priority: Priority;
  clip: ClipId;
  text: Record<Locale, CallText>;
}

export const ROSHAN_CHAIN: RoshanStep[] = [
  {
    id: 'aegis_expira', label: 'AEGIS EXPIRES', offset: 300, lead: 10, priority: 4, clip: 'aegis_expira',
    text: {
      'pt-BR': { dry: 'Aegis expira', verbose: 'Aegis expira em dez' },
      en: { dry: 'Aegis expires', verbose: 'Aegis expires in ten' },
    },
  },
  {
    id: 'rosh_possivel', label: 'ROSH POSSIBLE', offset: 480, lead: 10, priority: 4, clip: 'rosh_possivel',
    text: {
      'pt-BR': { dry: 'Rosh possível', verbose: 'Rosh possível em dez' },
      en: { dry: 'Rosh possible', verbose: 'Rosh possible in ten' },
    },
  },
  {
    id: 'rosh_garantido', label: 'ROSH GUARANTEED', offset: 660, lead: 10, priority: 5, clip: 'rosh_garantido',
    text: {
      'pt-BR': { dry: 'Rosh garantido', verbose: 'Rosh garantido em dez' },
      en: { dry: 'Rosh guaranteed', verbose: 'Rosh guaranteed in ten' },
    },
  },
];

/** Two-letter quick palette, opened with the palette hotkey. */
export interface PaletteEntry {
  code: string;
  id: string;
  label: Record<Locale, string>;
  /** countdown length in seconds */
  seconds: number;
  lead: number;
  priority: Priority;
  clip: ClipId;
  text: Record<Locale, CallText>;
}

export const PALETTE: PaletteEntry[] = [
  {
    code: 'AE', id: 'aegis_inimigo', seconds: 300, lead: 10, priority: 4, clip: 'aegis_inimigo',
    label: { 'pt-BR': 'INIMIGO PEGOU AEGIS', en: 'ENEMY TOOK AEGIS' },
    text: {
      'pt-BR': { dry: 'Aegis inimigo caindo', verbose: 'Aegis inimigo expira em dez' },
      en: { dry: 'Enemy aegis dropping', verbose: 'Enemy aegis expires in ten' },
    },
  },
  {
    code: 'GL', id: 'glyph_pronto', seconds: 300, lead: 10, priority: 3, clip: 'glyph_pronto',
    label: { 'pt-BR': 'GLYPH INIMIGO USADO', en: 'ENEMY GLYPH USED' },
    text: {
      'pt-BR': { dry: 'Glyph voltando', verbose: 'Glyph inimigo pronto em dez' },
      en: { dry: 'Glyph coming back', verbose: 'Enemy glyph ready in ten' },
    },
  },
  {
    code: 'BB', id: 'buyback_inimigo', seconds: 480, lead: 10, priority: 3, clip: 'buyback_inimigo',
    label: { 'pt-BR': 'BUYBACK INIMIGO USADO', en: 'ENEMY BUYBACK USED' },
    text: {
      'pt-BR': { dry: 'Buyback inimigo voltando', verbose: 'Buyback inimigo pronto em dez' },
      en: { dry: 'Enemy buyback back', verbose: 'Enemy buyback ready in ten' },
    },
  },
  {
    code: 'SM', id: 'smoke_visto', seconds: 40, lead: 5, priority: 4, clip: 'smoke_visto',
    label: { 'pt-BR': 'SMOKE AVISTADO', en: 'SMOKE SPOTTED' },
    text: {
      'pt-BR': { dry: 'Smoke acabando', verbose: 'Smoke inimigo acaba em cinco' },
      en: { dry: 'Smoke running out', verbose: 'Enemy smoke ends in five' },
    },
  },
];

/** Calls raised by reading the live GSI state rather than the clock. */
export interface StateCall {
  id: string;
  label: string;
  priority: Priority;
  clip: ClipId;
  /** minimum seconds between two of these */
  cooldown: number;
  text: Record<Locale, CallText>;
}

export const STATE_CALLS: Record<
  'sem_buyback' | 'sem_tp' | 'ult_pronta' | 'item_pronto',
  StateCall
> = {
  sem_buyback: {
    id: 'sem_buyback', label: 'NO BUYBACK', priority: 3, clip: 'sem_buyback', cooldown: 180,
    text: {
      'pt-BR': { dry: 'Sem buyback', verbose: 'Você está sem buyback' },
      en: { dry: 'No buyback', verbose: 'You have no buyback' },
    },
  },
  sem_tp: {
    id: 'sem_tp', label: 'NO TP', priority: 3, clip: 'sem_tp', cooldown: 120,
    text: {
      'pt-BR': { dry: 'Sem TP', verbose: 'Você está sem TP' },
      en: { dry: 'No TP', verbose: 'You have no TP' },
    },
  },
  ult_pronta: {
    id: 'ult_pronta', label: 'ULTIMATE READY', priority: 3, clip: 'ult_pronta', cooldown: 30,
    text: {
      'pt-BR': { dry: 'Ult pronta', verbose: 'Sua ultimate está pronta' },
      en: { dry: 'Ult ready', verbose: 'Your ultimate is ready' },
    },
  },
  // One clip for the whole watched list: naming the item would cost the user
  // six more recordings to say something the inventory already shows.
  item_pronto: {
    id: 'item_pronto', label: 'ITEM READY', priority: 3, clip: 'item_pronto', cooldown: 30,
    text: {
      'pt-BR': { dry: 'Item pronto', verbose: 'Seu item chave está pronto' },
      en: { dry: 'Item ready', verbose: 'Your key item is ready' },
    },
  },
};

export const ROLES: { id: RoleId; name: Record<Locale, string> }[] = [
  { id: 'POS 1', name: { 'pt-BR': 'SAFELANE', en: 'SAFELANE' } },
  { id: 'POS 2', name: { 'pt-BR': 'MID', en: 'MID' } },
  { id: 'POS 3', name: { 'pt-BR': 'OFFLANE', en: 'OFFLANE' } },
  { id: 'POS 4', name: { 'pt-BR': 'ROAM', en: 'ROAM' } },
  { id: 'POS 5', name: { 'pt-BR': 'HARD SUP', en: 'HARD SUP' } },
];

/** Every clip the user can record, in the order the record-all flow walks. */
export const CLIPS: { id: ClipId; text: Record<Locale, CallText> }[] = (() => {
  const out: { id: ClipId; text: Record<Locale, CallText> }[] = [];
  const seen = new Set<ClipId>();
  const push = (id: ClipId, text: Record<Locale, CallText>) => {
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ id, text });
  };
  for (const e of EVENTS) push(e.clip, e.text);
  for (const r of ROSHAN_CHAIN) push(r.clip, r.text);
  for (const p of PALETTE) push(p.clip, p.text);
  for (const s of Object.values(STATE_CALLS)) push(s.clip, s.text);
  return out;
})();

export const CLIP_BY_ID: Map<ClipId, { id: ClipId; text: Record<Locale, CallText> }> =
  new Map(CLIPS.map((c) => [c.id, c]));

export function eventAppliesToRole(roles: RoleId[] | 'ALL', role: RoleId): boolean {
  return roles === 'ALL' || roles.includes(role);
}

export function mmss(seconds: number): string {
  const sign = seconds < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(seconds));
  return `${sign}${Math.floor(abs / 60)}:${String(abs % 60).padStart(2, '0')}`;
}

// ── role panel ────────────────────────────────────────────────────────────
// Read at a glance, never spoken.

export type Phase = 'LANING' | 'TRANSITION' | 'MID' | 'LATE';

export const PHASES: { id: Phase; labelKey: MessageKey; from: number; to: number }[] = [
  { id: 'LANING', labelKey: 'phase.laning', from: 0, to: 600 },
  { id: 'TRANSITION', labelKey: 'phase.transition', from: 600, to: 1200 },
  { id: 'MID', labelKey: 'phase.mid', from: 1200, to: 2100 },
  { id: 'LATE', labelKey: 'phase.late', from: 2100, to: Number.MAX_SAFE_INTEGER },
];

export function phaseFor(clock: number): Phase {
  return PHASES.find((p) => clock >= p.from && clock < p.to)?.id ?? 'LATE';
}

export const PHASE_FOCUS: Record<RoleId, Record<Phase, Record<Locale, string>>> = {
  'POS 1': {
    LANING: {
      'pt-BR': 'Não perca last hit por causa de trade. Peça o stack antes de cada minuto cheio e some da lane se o suporte inimigo sumiu.',
      en: 'Do not trade last hits away. Ask for the stack before each full minute and leave the lane the moment the enemy support disappears.',
    },
    TRANSITION: {
      'pt-BR': 'Farme os stacks que já estão prontos antes de girar. Item de fuga antes de item de dano se o mapa está sem visão.',
      en: 'Clear the stacks that are already waiting before rotating. Escape item before damage item while the map has no vision.',
    },
    MID: {
      'pt-BR': 'Só apareça em luta com buyback ou com o time inteiro junto. Empurre a lane oposta ao objetivo do time.',
      en: 'Only show up to a fight with buyback or with the whole team. Push the lane opposite the team objective.',
    },
    LATE: {
      'pt-BR': 'Não morra sem buyback. Cada morte sua custa mais que qualquer objetivo que o time pegue no lugar.',
      en: 'Do not die without buyback. Your death costs more than any objective the team trades for it.',
    },
  },
  'POS 2': {
    LANING: {
      'pt-BR': 'Runa de poder a cada dois minutos é sua. Chegue com dez segundos de antecedência ou não vá.',
      en: 'Every two-minute power rune is yours. Arrive ten seconds early or do not go at all.',
    },
    TRANSITION: {
      'pt-BR': 'Use a vantagem de nível agora. Wisdom rune aos 7 e 14 vale mais que uma wave.',
      en: 'Spend the level lead now. The wisdom rune at 7 and 14 beats a wave of creeps.',
    },
    MID: {
      'pt-BR': 'Você é quem inicia. Segure TP e não gaste a ultimate em wave antes do Tormentor.',
      en: 'You are the initiator. Hold a TP and do not spend the ultimate on a wave before Tormentor.',
    },
    LATE: {
      'pt-BR': 'Rotacione com o time nos objetivos. Farme solo só com visão do lado inimigo.',
      en: 'Move with the team on objectives. Farm solo only with vision on the enemy side.',
    },
  },
  'POS 3': {
    LANING: {
      'pt-BR': 'Aguente a lane. Puxe a onda para a torre quando estiver perdendo e negue o máximo que der.',
      en: 'Hold the lane. Pull the wave under tower while behind and deny everything you can.',
    },
    TRANSITION: {
      'pt-BR': 'Pressione a torre 1 assim que a wave estiver do seu lado. Você compra espaço, não farm.',
      en: 'Pressure tier one the moment the wave is on your side. You buy space, not farm.',
    },
    MID: {
      'pt-BR': 'Inicie com visão, não no escuro. Tormentor aos 20 é seu com o time perto.',
      en: 'Initiate with vision, never blind. The 20:00 Tormentor is yours with the team nearby.',
    },
    LATE: {
      'pt-BR': 'Você é a linha de frente do buyback. Morra por último e sempre com a ultimate usada.',
      en: 'You are the buyback frontline. Die last and never with your ultimate unspent.',
    },
  },
  'POS 4': {
    LANING: {
      'pt-BR': 'Some da lane antes do minuto cheio para stackar ou pegar bounty. Anote o smoke inimigo.',
      en: 'Leave lane before the full minute to stack or grab a bounty. Track the enemy smoke.',
    },
    TRANSITION: {
      'pt-BR': 'Gank com a runa de poder. Deixe uma sentry na aproximação do Roshan antes dos 20.',
      en: 'Gank off the power rune. Drop a sentry on the Roshan approach before the twenty minute mark.',
    },
    MID: {
      'pt-BR': 'Visão profunda antes de qualquer objetivo. Smoke em estoque vale mais que um item pequeno.',
      en: 'Deep vision before any objective. A smoke in stock beats a small item.',
    },
    LATE: {
      'pt-BR': 'Negue visão nas entradas da base inimiga. Nunca inicie sozinho sem detecção.',
      en: 'Deny vision at the enemy entrances. Never initiate alone without detection.',
    },
  },
  'POS 5': {
    LANING: {
      'pt-BR': 'Pull no :15 sempre que a lane estiver empurrada. Regen para o carry antes do seu próprio item.',
      en: 'Pull at :15 whenever the lane is pushed in. Regen for the carry before your own item.',
    },
    TRANSITION: {
      'pt-BR': 'Rotacione para fora da lane. Negue visão na aproximação do Roshan antes do Tormentor dos 20. Stack para o carry só com a lane segura.',
      en: 'Rotate off the lane. Deny vision on the Roshan approach before the 20:00 Tormentor. Stack for the carry only while the lane is safe.',
    },
    MID: {
      'pt-BR': 'Visão antes de agrupar. Não fique sem sentry com Roshan em pé.',
      en: 'Vision before grouping. Never run out of sentries with Roshan alive.',
    },
    LATE: {
      'pt-BR': 'Fique vivo para o buyback do time. Ward de retorno depois de cada luta ganha.',
      en: 'Stay alive for the team buyback. Re-ward after every fight you win.',
    },
  },
};
