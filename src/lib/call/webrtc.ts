/** ICE config from env only — no baked-in credentials. Without TURN env
 *  vars the call falls back to STUN-only (works on most networks). */
export function iceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ];
  const host = process.env.NEXT_PUBLIC_TURN_HOST;
  const user = process.env.NEXT_PUBLIC_TURN_USER;
  const pass = process.env.NEXT_PUBLIC_TURN_PASS;
  if (host && user && pass) {
    servers.push({
      urls: [`turn:${host}:3478?transport=udp`, `turn:${host}:3478?transport=tcp`],
      username: user,
      credential: pass,
    });
  }
  return servers;
}

/** Wait until ICE candidates are in the local SDP (avoids lost trickle races). */
export function waitForIceGathering(pc: RTCPeerConnection, timeoutMs = 4000) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = () => {
      pc.removeEventListener("icegatheringstatechange", onChange);
      resolve();
    };
    const onChange = () => {
      if (pc.iceGatheringState === "complete") done();
    };
    pc.addEventListener("icegatheringstatechange", onChange);
    setTimeout(done, timeoutMs);
  });
}
