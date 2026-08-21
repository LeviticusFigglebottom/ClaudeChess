/**
 * GAMBIT synthesized sound set (B2.6). Eleven-plus short event sounds
 * generated procedurally — original, attributable to nobody's library, and
 * regenerable from this script. Output: public/sounds/gambit/*.wav
 * (44.1kHz 16-bit mono, committed).
 *
 * Tonal palette: wooden ticks (filtered noise + low sine) for board contact,
 * restrained chime dyads for game state, one heavy thud reserved for the
 * blunder reveal — the audio counterpart of --flag.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const SR = 44100;

function render(durationSec, fn) {
  const n = Math.floor(SR * durationSec);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = fn(i / SR, i);
  return out;
}

function envExp(t, decay) {
  return Math.exp(-t / decay);
}

/** One-pole lowpass over white noise for wooden transients. */
function noiseBurst(durationSec, cutoffHz, gain = 1) {
  const n = Math.floor(SR * durationSec);
  const out = new Float32Array(n);
  const alpha = 1 - Math.exp((-2 * Math.PI * cutoffHz) / SR);
  let y = 0;
  let seed = 12345;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const white = (seed / 0x3fffffff - 1) * gain;
    y += alpha * (white - y);
    out[i] = y * envExp(i / SR, durationSec / 4);
  }
  return out;
}

function tone(freq, durationSec, { decay = durationSec / 3, gain = 1, glideTo = freq, harmonics = [] } = {}) {
  return render(durationSec, (t) => {
    const f = freq + (glideTo - freq) * (t / durationSec);
    let sample = Math.sin(2 * Math.PI * f * t);
    for (const [mult, hGain] of harmonics) {
      sample += hGain * Math.sin(2 * Math.PI * f * mult * t);
    }
    return sample * envExp(t, decay) * gain;
  });
}

function mix(...parts) {
  const n = Math.max(...parts.map((p) => p.samples.length + Math.floor((p.at ?? 0) * SR)));
  const out = new Float32Array(n);
  for (const part of parts) {
    const offset = Math.floor((part.at ?? 0) * SR);
    for (let i = 0; i < part.samples.length; i++) {
      out[offset + i] += part.samples[i] * (part.gain ?? 1);
    }
  }
  return out;
}

function normalize(samples, peak = 0.85) {
  let max = 0;
  for (const sample of samples) max = Math.max(max, Math.abs(sample));
  if (max === 0) return samples;
  const scale = peak / max;
  return samples.map((sample) => sample * scale);
}

function toWav(samples) {
  const n = samples.length;
  const buffer = Buffer.alloc(44 + n * 2);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + n * 2, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(SR, 24);
  buffer.writeUInt32LE(SR * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    buffer.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2);
  }
  return buffer;
}

const woodTick = (pitch = 180, size = 1) =>
  mix(
    { samples: noiseBurst(0.02 * size, 2200), gain: 0.5 },
    { samples: tone(pitch, 0.09 * size, { decay: 0.03 * size }), gain: 0.9 }
  );

const SOUNDS = {
  // Board contact — wooden, quiet, sub-100ms.
  move: woodTick(190, 1),
  capture: mix(
    { samples: noiseBurst(0.03, 1400), gain: 0.7 },
    { samples: tone(130, 0.13, { decay: 0.045, harmonics: [[2, 0.25]] }), gain: 1 }
  ),
  castle: mix(
    { samples: woodTick(200, 0.9) },
    { samples: woodTick(170, 1), at: 0.075 }
  ),
  check: mix(
    { samples: tone(660, 0.12, { decay: 0.05 }), gain: 0.7 },
    { samples: tone(880, 0.16, { decay: 0.06 }), at: 0.09, gain: 0.7 }
  ),
  promote: mix(
    { samples: tone(440, 0.1, { decay: 0.05 }), gain: 0.6 },
    { samples: tone(554, 0.1, { decay: 0.05 }), at: 0.07, gain: 0.6 },
    { samples: tone(659, 0.22, { decay: 0.1 }), at: 0.14, gain: 0.7 }
  ),
  "premove-set": mix({ samples: noiseBurst(0.015, 3000), gain: 0.35 }, { samples: tone(1200, 0.04, { decay: 0.015 }), gain: 0.3 }),
  illegal: tone(110, 0.11, { decay: 0.05, harmonics: [[3, 0.4]], gain: 0.8 }),
  "low-time": mix({ samples: noiseBurst(0.012, 4000), gain: 0.6 }, { samples: tone(1500, 0.03, { decay: 0.012 }), gain: 0.5 }),
  // Game state — restrained chimes.
  "game-start": mix(
    { samples: tone(523, 0.4, { decay: 0.18 }), gain: 0.6 },
    { samples: tone(784, 0.4, { decay: 0.2 }), at: 0.02, gain: 0.45 }
  ),
  "game-end-win": mix(
    { samples: tone(523, 0.15, { decay: 0.08 }), gain: 0.55 },
    { samples: tone(659, 0.15, { decay: 0.09 }), at: 0.11, gain: 0.55 },
    { samples: tone(784, 0.4, { decay: 0.2 }), at: 0.22, gain: 0.6 }
  ),
  "game-end-draw": tone(440, 0.45, { decay: 0.22, gain: 0.55, harmonics: [[2, 0.15]] }),
  "game-end-loss": mix(
    { samples: tone(659, 0.16, { decay: 0.09 }), gain: 0.5 },
    { samples: tone(523, 0.42, { decay: 0.2, glideTo: 494 }), at: 0.12, gain: 0.5 }
  ),
  // Classification reveals (review surfaces; distinct per class).
  "class-brilliant": mix(
    { samples: tone(880, 0.09, { decay: 0.05 }), gain: 0.45 },
    { samples: tone(1108, 0.09, { decay: 0.05 }), at: 0.06, gain: 0.45 },
    { samples: tone(1318, 0.22, { decay: 0.12 }), at: 0.12, gain: 0.5 }
  ),
  "class-great": tone(988, 0.16, { decay: 0.08, gain: 0.55 }),
  "class-good": tone(660, 0.1, { decay: 0.05, gain: 0.4 }),
  "class-mistake": tone(220, 0.16, { decay: 0.07, gain: 0.6, harmonics: [[2, 0.2]] }),
  // The audio counterpart of --flag: heavy, used for BLUNDER reveal and flagfall.
  "class-blunder": mix(
    { samples: noiseBurst(0.04, 500), gain: 0.8 },
    { samples: tone(90, 0.3, { decay: 0.12, harmonics: [[2, 0.3]] }), gain: 1 }
  ),
};

const outDir = path.resolve("public/sounds/gambit");
mkdirSync(outDir, { recursive: true });
let bytes = 0;
for (const [name, samples] of Object.entries(SOUNDS)) {
  const wav = toWav(normalize(samples));
  writeFileSync(path.join(outDir, `${name}.wav`), wav);
  bytes += wav.length;
}
console.log(
  `sounds: wrote ${Object.keys(SOUNDS).length} files (${(bytes / 1024).toFixed(0)}KB) to public/sounds/gambit`
);
