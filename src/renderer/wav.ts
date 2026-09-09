// Recording post-processing: trim the silence around the take, normalise the
// peak, and write a mono 16-bit WAV. Calls have to land the instant they fire,
// so a clip that starts with half a second of room tone is a bug.

export interface ProcessedClip {
  bytes: Uint8Array;
  durationMs: number;
  /** peak of the raw take, 0..1 - used to warn about a dead microphone */
  peak: number;
}

/** -45 dBFS: quiet enough to keep breath, loud enough to cut room tone. */
const SILENCE_FLOOR = 0.0056;
const PAD_SECONDS = 0.06;
const TARGET_PEAK = 0.89;

function toMono(buffer: AudioBuffer): Float32Array {
  const channels = buffer.numberOfChannels;
  const mono = new Float32Array(buffer.length);
  for (let c = 0; c < channels; c += 1) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i += 1) mono[i] = (mono[i] ?? 0) + (data[i] ?? 0) / channels;
  }
  return mono;
}

function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);

  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);          // PCM header size
  view.setUint16(20, 1, true);           // format: PCM
  view.setUint16(22, 1, true);           // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);           // block align
  view.setUint16(34, 16, true);          // bits per sample
  ascii(36, 'data');
  view.setUint32(40, samples.length * 2, true);

  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(44 + i * 2, Math.round(clamped * 32767), true);
  }
  return bytes;
}

export async function processRecording(blob: Blob): Promise<ProcessedClip | null> {
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(await blob.arrayBuffer());
    const mono = toMono(decoded);
    const rate = decoded.sampleRate;

    let peak = 0;
    for (const sample of mono) peak = Math.max(peak, Math.abs(sample));
    if (peak < SILENCE_FLOOR) return null;

    let first = 0;
    while (first < mono.length && Math.abs(mono[first] ?? 0) < SILENCE_FLOOR) first += 1;
    let last = mono.length - 1;
    while (last > first && Math.abs(mono[last] ?? 0) < SILENCE_FLOOR) last -= 1;

    const pad = Math.round(PAD_SECONDS * rate);
    const from = Math.max(0, first - pad);
    const to = Math.min(mono.length, last + pad);

    const gain = TARGET_PEAK / peak;
    const trimmed = new Float32Array(to - from);
    for (let i = 0; i < trimmed.length; i += 1) trimmed[i] = (mono[from + i] ?? 0) * gain;

    return {
      bytes: encodeWav(trimmed, rate),
      durationMs: Math.round((trimmed.length / rate) * 1000),
      peak,
    };
  } catch {
    return null;
  } finally {
    void context.close();
  }
}
