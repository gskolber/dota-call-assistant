// Plays the calls. A call is either a clip the user recorded with their own
// voice, or - when nothing was recorded for it - the OS speech synthesiser.

import { CLIP_BY_ID } from '../shared/catalog';
import type { ClipId, ClipIndex, Locale } from '../shared/types';

export type SpeakSource = 'clip' | 'tts' | 'silent';

export interface SpeakResult {
  source: SpeakSource;
  text: string;
}

export class AudioBank {
  private urls = new Map<ClipId, string>();
  private queue: (() => Promise<void>)[] = [];
  private draining = false;
  private element = new Audio();

  locale: Locale = 'pt-BR';
  volume = 0.7;
  verbose = false;
  ttsFallback = true;
  outputDeviceId = 'default';

  constructor() {
    this.element.preload = 'auto';
  }

  has(clip: ClipId): boolean {
    return this.urls.has(clip);
  }

  /** Pulls every recorded clip for `locale` into memory as blob URLs. */
  async load(locale: Locale, index: ClipIndex): Promise<void> {
    this.release();
    this.locale = locale;

    for (const id of Object.keys(index) as ClipId[]) {
      const bytes = await window.api.clips.read(locale, id);
      if (!bytes) continue;
      const blob = new Blob([bytes as BlobPart], { type: 'audio/wav' });
      this.urls.set(id, URL.createObjectURL(blob));
    }
  }

  release(): void {
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
  }

  textFor(clip: ClipId): string {
    const entry = CLIP_BY_ID.get(clip);
    if (!entry) return '';
    const text = entry.text[this.locale];
    return this.verbose ? text.verbose : text.dry;
  }

  /** Queues a call so two of them never talk over each other. */
  speak(clip: ClipId): SpeakResult {
    const text = this.textFor(clip);
    const url = this.urls.get(clip);

    if (url) {
      this.enqueue(() => this.playUrl(url));
      return { source: 'clip', text };
    }
    if (this.ttsFallback && text) {
      this.enqueue(() => this.playTts(text));
      return { source: 'tts', text };
    }
    return { source: 'silent', text };
  }

  /** Plays one clip immediately, for the audition buttons in the UI. */
  async preview(clip: ClipId): Promise<SpeakResult> {
    const text = this.textFor(clip);
    const url = this.urls.get(clip);
    if (url) {
      await this.playUrl(url);
      return { source: 'clip', text };
    }
    if (text) {
      await this.playTts(text);
      return { source: 'tts', text };
    }
    return { source: 'silent', text };
  }

  async previewBlobUrl(url: string): Promise<void> {
    await this.playUrl(url);
  }

  stop(): void {
    this.queue = [];
    this.element.pause();
    window.speechSynthesis?.cancel();
  }

  private enqueue(task: () => Promise<void>): void {
    this.queue.push(task);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    while (this.queue.length) {
      const task = this.queue.shift();
      if (!task) break;
      try {
        await task();
      } catch {
        // a device that vanished mid-call must not stall the queue
      }
    }
    this.draining = false;
  }

  private async playUrl(url: string): Promise<void> {
    const el = this.element;
    el.pause();
    el.src = url;
    el.volume = this.volume;
    await this.applySink(el);

    await new Promise<void>((resolve) => {
      const done = (): void => {
        el.removeEventListener('ended', done);
        el.removeEventListener('error', done);
        resolve();
      };
      el.addEventListener('ended', done);
      el.addEventListener('error', done);
      void el.play().catch(done);
    });
  }

  private async applySink(el: HTMLAudioElement): Promise<void> {
    const withSink = el as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
    if (!withSink.setSinkId || this.outputDeviceId === 'default') return;
    try {
      await withSink.setSinkId(this.outputDeviceId);
    } catch {
      // device unplugged - fall back to the system default
    }
  }

  private playTts(text: string): Promise<void> {
    const synth = window.speechSynthesis;
    if (!synth) return Promise.resolve();

    return new Promise<void>((resolve) => {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = this.locale === 'pt-BR' ? 'pt-BR' : 'en-US';
      utterance.volume = this.volume;
      utterance.rate = 1.15;

      const voice = synth.getVoices().find((v) => v.lang.replace('_', '-') === utterance.lang)
        ?? synth.getVoices().find((v) => v.lang.startsWith(utterance.lang.slice(0, 2)));
      if (voice) utterance.voice = voice;

      utterance.onend = () => resolve();
      utterance.onerror = () => resolve();
      synth.speak(utterance);
    });
  }
}

export async function listAudioDevices(): Promise<{
  inputs: MediaDeviceInfo[];
  outputs: MediaDeviceInfo[];
}> {
  // Chromium also reports synthetic "default"/"communications" entries; the UI
  // offers its own default option, so listing them again just confuses things.
  const real = (device: MediaDeviceInfo, kind: MediaDeviceKind): boolean =>
    device.kind === kind && device.deviceId !== 'default' && device.deviceId !== 'communications';

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return {
      inputs: devices.filter((d) => real(d, 'audioinput')),
      outputs: devices.filter((d) => real(d, 'audiooutput')),
    };
  } catch {
    return { inputs: [], outputs: [] };
  }
}
