// Microphone capture for the "record your own calls" flow.

import { processRecording, type ProcessedClip } from './wav';

/** Nobody needs a five second call; the cap also bounds memory. */
const MAX_SECONDS = 5;

export interface RecorderHandlers {
  /** 0..1, roughly 30 times a second, for the level meter */
  onLevel(level: number): void;
  onElapsed(seconds: number): void;
}

export class VoiceRecorder {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private context: AudioContext | null = null;
  private raf = 0;
  private startedAt = 0;

  get recording(): boolean {
    return this.recorder?.state === 'recording';
  }

  async start(deviceId: string, handlers: RecorderHandlers): Promise<void> {
    if (this.recording) return;

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId && deviceId !== 'default' ? { exact: deviceId } : undefined,
        echoCancellation: false,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    this.chunks = [];
    this.recorder = new MediaRecorder(this.stream, { mimeType: pickMimeType() });
    this.recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.chunks.push(event.data);
    };
    this.recorder.start();
    this.startedAt = performance.now();

    this.meter(handlers);
  }

  /** Stops and returns the trimmed, normalised clip - or null if it was silent. */
  async stop(): Promise<ProcessedClip | null> {
    const recorder = this.recorder;
    if (!recorder) return null;

    const blob = await new Promise<Blob>((resolve) => {
      recorder.onstop = () => resolve(new Blob(this.chunks, { type: recorder.mimeType }));
      if (recorder.state !== 'inactive') recorder.stop();
      else resolve(new Blob(this.chunks, { type: recorder.mimeType }));
    });

    this.teardown();
    return processRecording(blob);
  }

  cancel(): void {
    if (this.recorder && this.recorder.state !== 'inactive') {
      this.recorder.onstop = null;
      this.recorder.stop();
    }
    this.teardown();
  }

  private meter(handlers: RecorderHandlers): void {
    if (!this.stream) return;

    this.context = new AudioContext();
    const analyser = this.context.createAnalyser();
    analyser.fftSize = 1024;
    this.context.createMediaStreamSource(this.stream).connect(analyser);

    const samples = new Float32Array(analyser.fftSize);
    const frame = (): void => {
      if (!this.recorder || this.recorder.state !== 'recording') return;

      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) sum += sample * sample;
      handlers.onLevel(Math.min(1, Math.sqrt(sum / samples.length) * 4));

      const elapsed = (performance.now() - this.startedAt) / 1000;
      handlers.onElapsed(elapsed);
      if (elapsed >= MAX_SECONDS) {
        this.recorder.stop();
        return;
      }
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  private teardown(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.recorder = null;
    void this.context?.close();
    this.context = null;
  }
}

function pickMimeType(): string {
  for (const type of ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return '';
}
