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
  /**
   * 1080p, deliberately not 1440p. Sharpness is bits per pixel, not pixel
   * count: at the 4 Mbps ceiling below, 2560×1440 leaves 0.07 bits/pixel —
   * less than livekit's own stock 1080p screen preset gets — and shared text
   * came out mushy. The same ceiling over 1920×1080 is 0.13, nearly double,
   * and it roughly halves the encoding work the sharer's machine does.
   */
  maxWidth: 1920,
  maxHeight: 1080,
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

/** H.264 as every hardware codec takes it: packetization-mode 1, and the
 *  constrained-baseline profile (42e01f) when it was offered. */
function pickH264(codecs?: CodecLike[]): CodecLike | undefined {
  const h264 = (codecs ?? []).filter(
    (c) =>
      c.mimeType.toLowerCase() === "video/h264" &&
      /packetization-mode=1/.test(c.sdpFmtpLine ?? ""),
  );
  return h264.find((c) => /profile-level-id=42e01f/i.test(c.sdpFmtpLine ?? "")) ?? h264[0];
}

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
 * negotiated it — H.264. Screen shares used to prefer AV1 for its text
 * tools, but AV1 is encoded on the processor everywhere and decoded there
 * on most office PCs, while nearly every PC has had H.264 in its graphics
 * chip for a decade. Measured 2026-09-29 at 1080p: VP8 took ~17 ms of CPU per frame
 * to decode and managed 5 fps; H.264 took ~1 ms, held 13 fps and read
 * sharper. After the CPU complaints from 2026-09-27 that decided it.
 * Switching codec this way (encodings[].codec, Chrome 119+/Firefox 142+)
 * needs no renegotiation and can only pick what the peer already accepted,
 * so it is safe with any peer; browsers without it ignore the field.
 *
 * Call it right after getParameters() has encodings, i.e. once the sender has
 * been negotiated. Returns what it replaced (for restoreSenderParams), or
 * null if the sender isn't negotiated yet.
 */
export async function applyScreenShareParams(
  sender: RTCRtpSender,
  maxBitrate: number,
  preferH264 = true,
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
    // stayed on the screen's codec), so the restore has to name it.
    codec: enc.codec ?? negotiatedDefault(params),
    degradationPreference: params.degradationPreference,
  };
  enc.maxBitrate = maxBitrate;
  enc.maxFramerate = SCREEN_SHARE_PROFILE.maxFramerate;
  enc.scaleResolutionDownBy = 1;
  // Chrome already does this for contentHint "detail"; Firefox ignores
  // contentHint, so say it explicitly.
  params.degradationPreference = "maintain-resolution";
  const h264 = preferH264 ? pickH264(params.codecs) : undefined;
  if (h264) enc.codec = h264;
  try {
    await sender.setParameters(params as unknown as RTCRtpSendParameters);
    return saved;
  } catch (err) {
    if (h264) return applyScreenShareParams(sender, maxBitrate, false);
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
      // Filmstrip thumbnail. A screen there is a 1080p decode for a picture
      // 112 px wide, so it is paused and the tile says who is sharing.
      shown = peer.sharing ? "off" : "low";
    } else if (view.layout === "screens") {
      shown = peer.sharing ? "high" : "off"; // cameras aren't on the wall
    } else {
      // Grid tile: cameras follow the tile count.
      shown = size;
    }
    // A shared screen that plays is always requested at full size — stage,
    // grid, wall or minimized tile — however many people are in the call.
    // Screens are published as a single 1080p layer (see
    // screenSharePublishOptions), so there is nothing smaller to fall back
    // to. Screens beyond what this device can decode at once arrive in
    // `hidden` (see shareDecodeBudget) and are paused like off-screen tiles.
    if (peer.sharing && shown !== "off") shown = "high";
    plan.set(
      peer.id,
      peer.sharing
        ? { camera: "off", screen: shown }
        : { camera: shown, screen: "off" },
    );
  }
  return plan;
}

/**
 * How many 1080p shares this device plays at once before the rest wait for
 * a click. Where H.264 is decoded by the graphics chip there is no limit: a
 * supervisor watches every screen in the call at once (asked for by the
 * team). In software every decode is the processor's job, and a wall of
 * them is what pinned CPUs at 100% and crashed tabs ("Aw, Snap!"), so such
 * a device plays two. Resolved once per page; unknown counts as software.
 */
let budget: Promise<number> | null = null;
export function shareDecodeBudget(): Promise<number> {
  budget ??= (async () => {
    try {
      const info = await navigator.mediaCapabilities.decodingInfo({
        type: "webrtc",
        video: {
          contentType: "video/H264",
          width: SCREEN_SHARE_PROFILE.maxWidth,
          height: SCREEN_SHARE_PROFILE.maxHeight,
          bitrate: SCREEN_SHARE_PROFILE.sfuMaxBitrate,
          framerate: SCREEN_SHARE_PROFILE.maxFramerate,
        },
      });
      return info.supported && info.powerEfficient ? Infinity : 2;
    } catch {
      return 2;
    }
  })();
  return budget;
}
