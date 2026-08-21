import { SOUND_EVENTS, type Prefs, type SoundEvent } from "@/lib/prefs/prefs";

/**
 * WebAudio event-sound player (B2.6). All buffers are fetched and decoded on
 * the first user gesture — playback is then a pre-decoded buffer start,
 * comfortably under the 30ms input→audio budget. Never autoplays before a
 * gesture; hard-respects the mute toggle and per-event mutes.
 */

export type PlayableSound =
  | SoundEvent
  | "class-brilliant"
  | "class-great"
  | "class-good"
  | "class-mistake"
  | "class-blunder";

const ALL_SOUNDS: PlayableSound[] = [
  ...SOUND_EVENTS,
  "class-brilliant",
  "class-great",
  "class-good",
  "class-mistake",
  "class-blunder",
];

class SoundPlayer {
  private ctx: AudioContext | null = null;
  private buffers = new Map<PlayableSound, AudioBuffer>();
  private loading: Promise<void> | null = null;

  /** Call from a user-gesture handler; idempotent. */
  ensureLoaded(): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      this.ctx = new AudioContext();
      if (this.ctx.state === "suspended") await this.ctx.resume().catch(() => undefined);
      await Promise.all(
        ALL_SOUNDS.map(async (name) => {
          try {
            const response = await fetch(`/sounds/gambit/${name}.wav`);
            const data = await response.arrayBuffer();
            const buffer = await this.ctx!.decodeAudioData(data);
            this.buffers.set(name, buffer);
          } catch {
            // A missing sound must never break the game loop.
          }
        })
      );
    })();
    return this.loading;
  }

  play(sound: PlayableSound, prefs: Prefs): void {
    if (!this.ctx || prefs.sound.muted || prefs.sound.master <= 0) return;
    if (prefs.sound.perEventMuted[sound as SoundEvent]) return;
    const buffer = this.buffers.get(sound);
    if (!buffer) return;
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    const gain = this.ctx.createGain();
    gain.gain.value = prefs.sound.master;
    source.connect(gain).connect(this.ctx.destination);
    source.start();
  }
}

let singleton: SoundPlayer | null = null;

export function soundPlayer(): SoundPlayer {
  singleton ??= new SoundPlayer();
  return singleton;
}
