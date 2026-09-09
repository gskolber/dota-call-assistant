// The record-your-own-calls dialog. Walks a queue of clips: read the line on
// screen, hold or press record, listen back, save or retake.

import { CLIP_BY_ID } from '../shared/catalog';
import type { ClipId, ClipMeta, Locale, Settings } from '../shared/types';
import { h, mount } from './dom';
import { VoiceRecorder } from './recorder';
import type { ProcessedClip } from './wav';

const LEVEL_CELLS = 28;

type Stage = 'ready' | 'recording' | 'review';

export interface RecordDeps {
  getSettings(): Settings;
  onSaved(id: ClipId, meta: ClipMeta): void;
  toast(message: string): void;
}

export class RecordDialog {
  private recorder = new VoiceRecorder();
  private queue: ClipId[] = [];
  private cursor = 0;
  private stage: Stage = 'ready';
  private level = 0;
  private elapsed = 0;
  private take: ProcessedClip | null = null;
  private takeUrl: string | null = null;
  private busy = false;

  constructor(private host: HTMLElement, private deps: RecordDeps) {}

  get isOpen(): boolean {
    return this.queue.length > 0;
  }

  open(ids: ClipId[]): void {
    if (!ids.length) {
      this.deps.toast('NADA A GRAVAR — TUDO JÁ TEM CLIPE');
      return;
    }
    this.queue = ids;
    this.cursor = 0;
    this.resetTake();
    this.render();
  }

  close(): void {
    this.recorder.cancel();
    this.queue = [];
    this.resetTake();
    mount(this.host);
  }

  /** Space toggles record, Enter saves, Escape closes. */
  handleKey(event: KeyboardEvent): boolean {
    if (!this.isOpen) return false;

    if (event.key === 'Escape') {
      this.close();
      return true;
    }
    if (event.key === ' ') {
      if (this.stage === 'recording') void this.stopRecording();
      else void this.startRecording();
      return true;
    }
    if (event.key === 'Enter' && this.stage === 'review') {
      void this.save();
      return true;
    }
    return false;
  }

  private get currentId(): ClipId | null {
    return this.queue[this.cursor] ?? null;
  }

  private resetTake(): void {
    if (this.takeUrl) URL.revokeObjectURL(this.takeUrl);
    this.takeUrl = null;
    this.take = null;
    this.stage = 'ready';
    this.level = 0;
    this.elapsed = 0;
  }

  private async startRecording(): Promise<void> {
    if (this.busy || this.stage === 'recording') return;
    this.busy = true;
    this.resetTake();
    this.stage = 'recording';
    this.render();

    try {
      await this.recorder.start(this.deps.getSettings().inputDeviceId, {
        onLevel: (level) => {
          this.level = level;
          this.paintLevel();
        },
        onElapsed: (seconds) => {
          const whole = Math.floor(seconds * 10) / 10;
          if (whole !== this.elapsed) {
            this.elapsed = whole;
            this.paintElapsed();
          }
          if (!this.recorder.recording && this.stage === 'recording') void this.stopRecording();
        },
      });
    } catch {
      this.stage = 'ready';
      this.deps.toast('MICROFONE NEGADO OU INDISPONÍVEL');
      this.render();
    } finally {
      this.busy = false;
    }
  }

  private async stopRecording(): Promise<void> {
    if (this.stage !== 'recording') return;
    this.stage = 'review';
    this.render();

    const take = await this.recorder.stop();
    if (!take) {
      this.stage = 'ready';
      this.deps.toast('NADA FOI CAPTURADO — VERIFIQUE O MICROFONE');
      this.render();
      return;
    }

    this.take = take;
    this.takeUrl = URL.createObjectURL(new Blob([take.bytes as BlobPart], { type: 'audio/wav' }));
    this.render();
    void this.playTake();
  }

  private async playTake(): Promise<void> {
    if (!this.takeUrl) return;
    const audio = new Audio(this.takeUrl);
    audio.volume = 1;
    await audio.play().catch(() => undefined);
  }

  private async save(): Promise<void> {
    const id = this.currentId;
    if (!id || !this.take || this.busy) return;
    this.busy = true;

    try {
      const meta = await window.api.clips.save(
        this.deps.getSettings().locale,
        id,
        this.take.bytes,
        this.take.durationMs,
      );
      this.deps.onSaved(id, meta);
      this.next();
    } catch {
      this.deps.toast('NÃO FOI POSSÍVEL SALVAR O CLIPE');
    } finally {
      this.busy = false;
      this.render();
    }
  }

  private next(): void {
    this.resetTake();
    if (this.cursor + 1 >= this.queue.length) {
      this.deps.toast('GRAVAÇÕES CONCLUÍDAS');
      this.close();
      return;
    }
    this.cursor += 1;
  }

  // ── rendering ───────────────────────────────────────────────────────────

  private paintLevel(): void {
    const cells = this.host.querySelectorAll<HTMLElement>('.level__cell');
    const lit = Math.round(this.level * LEVEL_CELLS);
    cells.forEach((cell, index) => {
      const on = index < lit;
      cell.className = `level__cell${on ? (index > LEVEL_CELLS - 4 ? ' level__cell--hot' : ' level__cell--on') : ''}`;
    });
  }

  private paintElapsed(): void {
    const node = this.host.querySelector<HTMLElement>('[data-elapsed]');
    if (node) node.textContent = `${this.elapsed.toFixed(1)}s`;
  }

  private lineFor(id: ClipId, locale: Locale, verbose: boolean): string {
    const entry = CLIP_BY_ID.get(id);
    if (!entry) return id;
    return verbose ? entry.text[locale].verbose : entry.text[locale].dry;
  }

  private render(): void {
    const id = this.currentId;
    if (!id) {
      mount(this.host);
      return;
    }

    const settings = this.deps.getSettings();
    const dry = this.lineFor(id, settings.locale, false);
    const verbose = this.lineFor(id, settings.locale, true);

    mount(
      this.host,
      h(
        'div.overlay',
        {},
        h(
          'div.modal',
          {},
          h(
            'div.modal__head',
            {},
            h('div', { text: `GRAVAR · ${id}` }),
            h('div', { style: 'flex:1' }),
            h('div', { text: `${this.cursor + 1}/${this.queue.length}` }),
          ),
          h(
            'div.modal__body',
            {},
            h('div.label', { text: `DIGA ISTO · ${settings.locale}` }),
            h('div.say', { text: settings.verbose ? verbose : dry }),
            h('div.hint', {
              text: settings.verbose
                ? `Versão curta desta call: "${dry}"`
                : `Versão longa desta call: "${verbose}"`,
            }),
            h(
              'div.level',
              {},
              Array.from({ length: LEVEL_CELLS }, () => h('div.level__cell')),
            ),
            h(
              'div',
              { style: 'display:flex;align-items:center;gap:12px' },
              h('div.label', {
                text: this.stage === 'recording'
                  ? 'GRAVANDO — ESPAÇO PARA PARAR'
                  : this.stage === 'review'
                    ? 'OUÇA E SALVE — ENTER'
                    : 'ESPAÇO PARA GRAVAR · MÁX 5s',
              }),
              h('div', { style: 'flex:1' }),
              h('div', {
                style: 'font-size:12px;font-weight:700;font-variant-numeric:tabular-nums',
                attrs: { 'data-elapsed': 'true' },
                text: `${this.elapsed.toFixed(1)}s`,
              }),
            ),
            this.take
              ? h('div.hint', {
                  text: `Aparado e normalizado para ${(this.take.durationMs / 1000).toFixed(2)}s.`,
                })
              : null,
          ),
          h(
            'div.modal__foot',
            {},
            this.stage === 'recording'
              ? h('button.btn.btn--alert', { text: 'PARAR', onClick: () => void this.stopRecording() })
              : h('button.btn', {
                  text: this.stage === 'review' ? 'REGRAVAR' : 'GRAVAR',
                  onClick: () => void this.startRecording(),
                }),
            this.stage === 'review'
              ? h('button.btn', { text: 'OUVIR', onClick: () => void this.playTake() })
              : null,
            this.stage === 'review'
              ? h('button.btn.btn--on', { text: 'SALVAR', onClick: () => void this.save() })
              : null,
            this.queue.length > 1
              ? h('button.btn', {
                  text: 'PULAR',
                  onClick: () => {
                    this.next();
                    this.render();
                  },
                })
              : null,
            h('button.btn', { text: 'FECHAR', onClick: () => this.close() }),
          ),
        ),
      ),
    );
  }
}
