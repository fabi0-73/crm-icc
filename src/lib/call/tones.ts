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

type ToneSpec = { freqs: number[]; onMs: number; periodMs: number };

/** US-style dual ringtone for the callee: 440+480 Hz, 1s on / 2s off. */
const RINGTONE: ToneSpec = { freqs: [440, 480], onMs: 1000, periodMs: 3000 };
/** Ringback for the caller: 425 Hz, 1s on / 3s off. */
const RINGBACK: ToneSpec = { freqs: [425], onMs: 1000, periodMs: 4000 };

class TonePlayer {
  private timer: ReturnType<typeof setInterval> | null = null;

  private burst(spec: ToneSpec, vibrate: boolean) {
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
          gain.gain.linearRampToValueAtTime(0.07, t + 0.02);
          gain.gain.setValueAtTime(0.07, t + spec.onMs / 1000 - 0.04);
          gain.gain.linearRampToValueAtTime(0, t + spec.onMs / 1000);
          osc.connect(gain).connect(c.destination);
          osc.start(t);
          osc.stop(t + spec.onMs / 1000 + 0.05);
        }
      }
    }
    if (vibrate && typeof navigator !== "undefined") {
      navigator.vibrate?.([400, 200, 400]);
    }
  }

  start(spec: ToneSpec, vibrate: boolean) {
    this.stop();
    this.burst(spec, vibrate);
    this.timer = setInterval(() => this.burst(spec, vibrate), spec.periodMs);
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
  player.start(RINGTONE, true);
}

export function startRingback() {
  player.start(RINGBACK, false);
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
