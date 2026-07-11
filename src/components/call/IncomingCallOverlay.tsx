"use client";

import { Avatar } from "@/components/Avatar";
import { useCall } from "@/components/call/CallProvider";

/** Full-screen incoming-call prompt. Rings on every page of the app. */
export function IncomingCallOverlay() {
  const { incoming, accept, decline } = useCall();
  if (!incoming) return null;

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-ink/70 p-4 backdrop-blur-sm">
      <div className="w-full max-w-xs rounded-3xl bg-ink-soft p-8 text-center text-white shadow-2xl">
        <div className="relative mx-auto h-24 w-24">
          <span className="absolute inset-0 animate-ping rounded-full bg-brand-400/40 motion-reduce:hidden" />
          <span className="absolute -inset-2 rounded-full border-2 border-brand-400/50" />
          <Avatar
            name={incoming.peerName}
            size="lg"
            className="!h-24 !w-24 !text-2xl relative"
          />
        </div>
        <p className="mt-5 brand-mark text-2xl font-semibold">{incoming.peerName}</p>
        <p className="mt-1 text-[13px] text-white/60">
          Incoming {incoming.video ? "video" : "voice"} call
          {incoming.roomName ? ` · ${incoming.roomName}` : ""}
        </p>

        <div className="mt-8 flex items-center justify-center gap-10">
          <div className="flex flex-col items-center gap-1.5">
            <button
              type="button"
              onClick={decline}
              className="flex h-14 w-14 items-center justify-center rounded-full bg-red-500 text-white shadow-lg transition-transform hover:scale-105 active:scale-95"
              aria-label="Decline call"
            >
              <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" className="rotate-[135deg]">
                <path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1.1-.2 1.2.4 2.5.6 3.8.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.6 21 3 13.4 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.6.6 3.8.1.4 0 .8-.3 1.1L6.6 10.8z" />
              </svg>
            </button>
            <span className="text-[11px] text-white/50">Decline</span>
          </div>
          <div className="flex flex-col items-center gap-1.5">
            <button
              type="button"
              onClick={() => void accept()}
              className="flex h-14 w-14 items-center justify-center rounded-full bg-brand-500 text-white shadow-lg transition-transform hover:scale-105 active:scale-95"
              aria-label="Accept call"
            >
              <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                <path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1.1-.2 1.2.4 2.5.6 3.8.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.6 21 3 13.4 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.6.6 3.8.1.4 0 .8-.3 1.1L6.6 10.8z" />
              </svg>
            </button>
            <span className="text-[11px] text-white/50">Accept</span>
          </div>
        </div>
      </div>
    </div>
  );
}
