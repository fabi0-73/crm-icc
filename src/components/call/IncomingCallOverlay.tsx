"use client";

import { Avatar } from "@/components/Avatar";
import { useCall } from "@/components/call/CallProvider";
import { HangUpIcon, PhoneIcon } from "@/components/icons";

/** Full-screen incoming-call prompt. Rings on every page of the app. */
export function IncomingCallOverlay() {
  const { incoming, accept, decline, openIncomingLobby } = useCall();
  if (!incoming) return null;

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-ink/70 p-4 backdrop-blur-sm">
      <div className="w-full max-w-xs rounded-xl bg-ink-soft p-8 text-center text-white shadow-lg">
        <div className="relative mx-auto h-24 w-24">
          <span className="absolute inset-0 animate-ping rounded-full bg-brand-400/40 motion-reduce:hidden" />
          <span className="absolute -inset-2 rounded-full border-2 border-brand-400/50" />
          <Avatar
            name={incoming.peerName}
            size="lg"
            userId={incoming.peerId}
            className="!h-24 !w-24 !text-2xl relative"
          />
        </div>
        <p className="mt-5 text-2xl font-semibold tracking-tight">{incoming.peerName}</p>
        <p className="mt-1 text-[13px] text-white/60">
          Incoming {incoming.video ? "video" : "voice"}
          {incoming.group ? " group" : ""} call
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
              <HangUpIcon />
            </button>
            <span className="text-[11px] text-white/50">Decline</span>
          </div>
          <div className="flex flex-col items-center gap-1.5">
            <button
              type="button"
              onClick={() => {
                if (incoming.group && incoming.video) openIncomingLobby();
                else void accept();
              }}
              className="flex h-14 w-14 items-center justify-center rounded-full bg-brand-500 text-white shadow-lg transition-transform hover:scale-105 active:scale-95"
              aria-label="Accept call"
            >
              <PhoneIcon size={24} />
            </button>
            <span className="text-[11px] text-white/50">Accept</span>
          </div>
        </div>
      </div>
    </div>
  );
}
