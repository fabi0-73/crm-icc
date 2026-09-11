/**
 * Ring tones via WebAudio oscillators — no audio assets, no external hosts.
 *
 * Browser autoplay policy: an AudioContext starts suspended until the page
 * has had a user gesture. installAutoResume() unlocks it on the first
 * pointer/key interaction anywhere in the app (the login click usually
 * covers it). If the user has truly never interacted, the ring stays
 * silent and we fall back to vibration + the visual overlay.
 */

let ctx: AudioContext | null = null;

function ensureCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
  }
  return ctx;
}

let autoResumeInstalled = false;

export function installAutoResume() {
  if (autoResumeInstalled || typeof window === "undefined") return;
  autoResumeInstalled = true;
  const resume = () => {
    const c = ensureCtx();
    if (c && c.state === "suspended") void c.resume().catch(() => undefined);
  };
  window.addEventListener("pointerdown", resume, { capture: true, passive: true });
  window.addEventListener("keydown", resume, { capture: true });
}

type ToneSpec = {
  freqs: number[];
  onMs: number;
  periodMs: number;
  /** Per-oscillator peak gain. The incoming ring is deliberately loud — it
   *  has to carry across a room like a phone call, not blend in like a
   *  message chime. */
  gain: number;
  vibrate: number[];
};

/**
 * Incoming call: classic 440+480 Hz dual tone, but loud and with a short gap
 * so it reads as an insistent phone ring rather than a polite beep.
 */
const RINGTONE: ToneSpec = {
  freqs: [440, 480],
  onMs: 1200,
  periodMs: 2600,
  gain: 0.22,
  vibrate: [600, 250, 600, 250],
};
/** Ringback for the caller: 425 Hz, quiet — it's only feedback in your ear. */
const RINGBACK: ToneSpec = {
  freqs: [425],
  onMs: 1000,
  periodMs: 4000,
  gain: 0.08,
  vibrate: [],
};

class TonePlayer {
  private timer: ReturnType<typeof setInterval> | null = null;

  private burst(spec: ToneSpec) {
    const c = ensureCtx();
    if (c) {
      if (c.state === "suspended") void c.resume().catch(() => undefined);
      if (c.state === "running") {
        const t = c.currentTime;
        for (const f of spec.freqs) {
          const osc = c.createOscillator();
          const gain = c.createGain();
          osc.type = "sine";
          osc.frequency.value = f;
          gain.gain.setValueAtTime(0, t);
          gain.gain.linearRampToValueAtTime(spec.gain, t + 0.02);
          gain.gain.setValueAtTime(spec.gain, t + spec.onMs / 1000 - 0.04);
          gain.gain.linearRampToValueAtTime(0, t + spec.onMs / 1000);
          osc.connect(gain).connect(c.destination);
          osc.start(t);
          osc.stop(t + spec.onMs / 1000 + 0.05);
        }
      }
    }
    if (spec.vibrate.length > 0 && typeof navigator !== "undefined") {
      navigator.vibrate?.(spec.vibrate);
    }
  }

  start(spec: ToneSpec) {
    this.stop();
    this.burst(spec);
    this.timer = setInterval(() => this.burst(spec), spec.periodMs);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (typeof navigator !== "undefined") navigator.vibrate?.(0);
  }
}

const player = new TonePlayer();

export function startRingtone() {
  player.start(RINGTONE);
}

export function startRingback() {
  player.start(RINGBACK);
}

export function stopTones() {
  player.stop();
}

let lastChimeAt = 0;
/** A burst of arrivals gets one chime, not a drum roll. */
const CHIME_MIN_GAP_MS = 1500;

/**
 * Short two-note chime for a message landing in a room you are not
 * looking at. Same autoplay story as the ring tones: silent until the
 * page has seen a gesture, never throws, no assets.
 */
export function playMessageChime() {
  const now = Date.now();
  if (now - lastChimeAt < CHIME_MIN_GAP_MS) return;
  lastChimeAt = now;

  const c = ensureCtx();
  if (!c) return;
  if (c.state === "suspended") void c.resume().catch(() => undefined);
  if (c.state !== "running") return;

  const t = c.currentTime;
  const notes: Array<[number, number]> = [
    [880, 0], // A5
    [1174.66, 0.09], // D6
  ];
  for (const [freq, offset] of notes) {
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    const start = t + offset;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(0.05, start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0005, start + 0.22);
    osc.connect(gain).connect(c.destination);
    osc.start(start);
    osc.stop(start + 0.25);
  }
}
