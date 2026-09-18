/**
 * Screen-share quality — one profile for both call paths.
 *
 * Why shares were blurry (researched 2026-09-19):
 * - With no capture limits the browser grabs a high-DPI screen at its native
 *   size (a Retina Mac sends ~3024 px wide, 30 fps), and libwebrtc squeezes
 *   that under its implicit 2.5 Mbps default for any sender without a
 *   maxBitrate. The encoder can only raise quantisation, so text turns to mush.
 * - Capping capture to ≤2560×1440 at ≤15 fps and lifting the bitrate ceiling
 *   gives every pixel several times the bits. 15 fps is plenty for documents,
 *   spreadsheets and the CRM; resolution is what makes text readable, and
 *   "maintain-resolution" makes the encoder drop frames rather than pixels
 *   when bandwidth or CPU runs short.
 *
 * No LiveKit imports here: the 1:1 path uses this module too, and the SDK is
 * only ever loaded lazily for group calls (see livekit-room.ts).
 */

export const SCREEN_SHARE_PROFILE = {
  maxWidth: 2560,
  maxHeight: 1440,
  maxFramerate: 15,
  /** 1:1 calls are peer-to-peer: no per-GB cost, so give text room. */
  p2pMaxBitrate: 5_000_000,
  /** Group calls: the top layer. LiveKit bills downstream data per viewer. */
  sfuMaxBitrate: 4_000_000,
} as const;

/**
 * Safari 17 captures at a LOW resolution when any width/height is passed to
 * getDisplayMedia (WebKit bug 263015; livekit-client skips it for the same
 * reason), so it gets frame-rate limits only.
 */
export function capsBreakCapture(ua = navigator.userAgent): boolean {
  const safari = /Safari\//.test(ua) && !/(Chrome|Chromium|CriOS|Edg|OPR)\//.test(ua);
  return safari && /Version\/17\./.test(ua);
}

/** getDisplayMedia options for the 1:1 path. */
export function displayMediaOptions(): DisplayMediaStreamOptions {
  const p = SCREEN_SHARE_PROFILE;
  const size = capsBreakCapture()
    ? {}
    : { width: { max: p.maxWidth }, height: { max: p.maxHeight } };
  return {
    video: {
      // Offer "Entire Screen" in the picker (the user still chooses).
      displaySurface: "monitor",
      ...size,
      frameRate: { max: p.maxFramerate },
    },
    audio: false,
    // Chrome/Edge picker hints — never offer the call's own tab, and let the
    // sharer switch what they share without stopping. Others ignore them.
    selfBrowserSurface: "exclude",
    surfaceSwitching: "include",
  } as DisplayMediaStreamOptions;
}

// ── 1:1 sender parameters ──────────────────────────────────────────────
// Typed loosely on purpose: `codec`/`codecs`/`degradationPreference` are
// newer than some TypeScript DOM libs and are simply ignored by browsers
// that don't know them.

type CodecLike = {
  mimeType: string;
  clockRate?: number;
  channels?: number;
  sdpFmtpLine?: string;
};
type EncodingLike = {
  maxBitrate?: number;
  maxFramerate?: number;
  scaleResolutionDownBy?: number;
  codec?: CodecLike;
};
type ParamsLike = {
  encodings?: EncodingLike[];
  codecs?: CodecLike[];
  degradationPreference?: string;
};

/** What a sender had before screen settings replaced it. */
export type SavedSenderParams = {
  maxBitrate?: number;
  maxFramerate?: number;
  scaleResolutionDownBy?: number;
  codec?: CodecLike;
  degradationPreference?: string;
};

const isAv1 = (c?: CodecLike) => c?.mimeType.toLowerCase() === "video/av1";

/** The codec the sender uses when none is pinned: the first negotiated media
 *  codec (rtx/red/fec are not codecs you can send with). Only meaningful
 *  BEFORE pinning — Chrome moves a pinned codec to the front of the list. */
function negotiatedDefault(params: ParamsLike): CodecLike | undefined {
  return params.codecs?.find(
    (c) => !/\/(rtx|red|ulpfec|flexfec-03)$/i.test(c.mimeType),
  );
}

/**
 * Point a video sender at screen content: bitrate ceiling, frame-rate cap,
 * full resolution, keep resolution under pressure, and — when both browsers
 * negotiated it — AV1, whose screen-content tools (palette mode, content
 * tuning) are markedly better for text than VP8/H.264. Switching codec this
 * way (encodings[].codec, Chrome 119+/Firefox 142+) needs no renegotiation
 * and can only pick what the peer already accepted, so it is safe with any
 * peer; browsers without it ignore the field.
 *
 * Call it right after getParameters() has encodings, i.e. once the sender has
 * been negotiated. Returns what it replaced (for restoreSenderParams), or
 * null if the sender isn't negotiated yet.
 */
export async function applyScreenShareParams(
  sender: RTCRtpSender,
  maxBitrate: number,
  preferAv1 = true,
): Promise<SavedSenderParams | null> {
  // No await between getParameters and setParameters (transactionId).
  const params = sender.getParameters() as unknown as ParamsLike;
  const enc = params.encodings?.[0];
  if (!enc) return null;
  const saved: SavedSenderParams = {
    maxBitrate: enc.maxBitrate,
    maxFramerate: enc.maxFramerate,
    scaleResolutionDownBy: enc.scaleResolutionDownBy,
    // Recorded now, while the list is still in negotiated order: leaving
    // `codec` out later does NOT undo a pin in Chrome (measured — the camera
    // stayed on AV1), so the restore has to name it.
    codec: enc.codec ?? negotiatedDefault(params),
    degradationPreference: params.degradationPreference,
  };
  enc.maxBitrate = maxBitrate;
  enc.maxFramerate = SCREEN_SHARE_PROFILE.maxFramerate;
  enc.scaleResolutionDownBy = 1;
  // Chrome already does this for contentHint "detail"; Firefox ignores
  // contentHint, so say it explicitly.
  params.degradationPreference = "maintain-resolution";
  const av1 = preferAv1 ? params.codecs?.find(isAv1) : undefined;
  if (av1) enc.codec = av1;
  try {
    await sender.setParameters(params as unknown as RTCRtpSendParameters);
    return saved;
  } catch (err) {
    if (av1) return applyScreenShareParams(sender, maxBitrate, false);
    console.warn("[screen-share] could not apply sender parameters", err);
    return null;
  }
}

/** Put a sender back the way applyScreenShareParams found it. */
export async function restoreSenderParams(
  sender: RTCRtpSender,
  saved: SavedSenderParams,
): Promise<void> {
  const params = sender.getParameters() as unknown as ParamsLike;
  const enc = params.encodings?.[0];
  if (!enc) return;
  setOrDelete(enc, "maxBitrate", saved.maxBitrate);
  setOrDelete(enc, "maxFramerate", saved.maxFramerate);
  setOrDelete(enc, "scaleResolutionDownBy", saved.scaleResolutionDownBy);
  setOrDelete(enc, "codec", saved.codec);
  setOrDelete(params, "degradationPreference", saved.degradationPreference);
  try {
    await sender.setParameters(params as unknown as RTCRtpSendParameters);
  } catch (err) {
    console.warn("[screen-share] could not restore sender parameters", err);
  }
}

function setOrDelete<T extends object, K extends keyof T>(
  obj: T,
  key: K,
  value: T[K] | undefined,
) {
  if (value === undefined) delete obj[key];
  else obj[key] = value;
}

type Stat = {
  type: string;
  id: string;
  kind?: string;
  mimeType?: string;
  codecId?: string;
  qualityLimitationReason?: string;
};

/**
 * While a 1:1 share runs: if AV1 turns out to be too heavy for the sharer's
 * CPU (the encoder keeps reporting a CPU limit), drop back to `fallback` —
 * the default codec applyScreenShareParams recorded. Returns a stop function.
 */
export function watchScreenShareEncoder(
  sender: RTCRtpSender,
  fallback: SavedSenderParams["codec"],
): () => void {
  let cpuStrikes = 0;
  let done = false;
  const timer = setInterval(async () => {
    if (done) return;
    const report = await sender.getStats().catch(() => null);
    if (!report || done) return;
    const found: { out?: Stat } = {};
    const mimeById = new Map<string, string>();
    report.forEach((s: Stat) => {
      if (s.type === "outbound-rtp" && s.kind === "video") found.out = s;
      if (s.type === "codec" && s.mimeType) mimeById.set(s.id, s.mimeType);
    });
    const out = found.out;
    if (!out) return;
    const mime = (out.codecId && mimeById.get(out.codecId)) || "";
    cpuStrikes = out.qualityLimitationReason === "cpu" ? cpuStrikes + 1 : 0;
    if (cpuStrikes < 3 || !/av1/i.test(mime)) return;
    done = true;
    clearInterval(timer);
    const params = sender.getParameters() as unknown as ParamsLike;
    const enc = params.encodings?.[0];
    if (!enc || !fallback || isAv1(fallback)) return;
    enc.codec = fallback; // (deleting `codec` would not switch it back)
    await sender
      .setParameters(params as unknown as RTCRtpSendParameters)
      .then(() =>
        console.info("[screen-share] AV1 was CPU-limited; using the default codec"),
      )
      .catch(() => undefined);
  }, 4000);
  return () => {
    done = true;
    clearInterval(timer);
  };
}

// ── Group calls: which video layer to ask the SFU for ──────────────────

export type LayerChoice = "off" | "low" | "medium" | "high";

/** What the viewer's screen currently shows (reported by the call UI).
 *  `hidden`: tiles scrolled out of view (a big grid, the filmstrip). */
export type GroupView =
  | { layout: "grid"; hidden?: string[] }
  /** focusId null = the viewer is looking at their own share. */
  | { layout: "focus"; focusId: string | null; hidden?: string[] }
  /** Every shared screen side by side (several people sharing at once). */
  | { layout: "screens"; hidden?: string[] }
  /** Minimized: the floating tile shows one participant. */
  | { layout: "mini"; shownId: string | null };

/**
 * Per remote participant, the camera and screen-share layer this viewer
 * needs. A presenter's camera is never on screen while they share (their
 * tile shows the screen), so it is switched off; so is anything the viewer
 * can't see, including tiles scrolled out of view. Only what is shown large
 * gets the top layer — every viewer asking for everyone's top layer is what
 * crowded shares out, froze browsers in 40-person calls (39 HD decodes and
 * ~66 Mbps each) and ran up LiveKit's per-GB data.
 */
export function planGroupVideo(
  peers: { id: string; sharing: boolean }[],
  view: GroupView,
): Map<string, { camera: LayerChoice; screen: LayerChoice }> {
  const plan = new Map<string, { camera: LayerChoice; screen: LayerChoice }>();
  const tiles = peers.length + 1; // + the viewer's own tile
  const size: LayerChoice = tiles <= 2 ? "high" : tiles <= 4 ? "medium" : "low";
  // Screen wall: two screens side by side are still read, 3–4 fit 720p, and
  // a wall of 40 concurrent shares is an overview at the 360p/5 fps layer.
  const sharers = peers.filter((p) => p.sharing).length;
  const wall: LayerChoice = sharers <= 2 ? "high" : sharers <= 4 ? "medium" : "low";
  const hidden = new Set(view.layout === "mini" ? [] : (view.hidden ?? []));

  for (const peer of peers) {
    let shown: LayerChoice;
    if (view.layout === "mini") {
      shown = peer.id === view.shownId ? "low" : "off";
    } else if (view.layout === "focus" && peer.id === view.focusId) {
      shown = "high"; // the big stage
    } else if (hidden.has(peer.id)) {
      shown = "off"; // scrolled out of view
    } else if (view.layout === "focus") {
      shown = "low"; // filmstrip thumbnail
    } else if (view.layout === "screens") {
      shown = peer.sharing ? wall : "off"; // cameras aren't on the wall
    } else {
      // Grid tile. A screen in a tile is unreadable at any size, so it gets
      // no more than a camera would (the focus stage is where it's read).
      shown = size;
    }
    plan.set(
      peer.id,
      peer.sharing
        ? { camera: "off", screen: shown }
        : { camera: shown, screen: "off" },
    );
  }
  return plan;
}
