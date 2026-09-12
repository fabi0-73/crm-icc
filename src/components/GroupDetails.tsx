"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Bell,
  BellOff,
  LogOut,
  MessageCircle,
  Settings,
  ShieldCheck,
  Trash2,
  UserMinus,
  UserPlus,
} from "lucide-react";
import {
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/uikit/sheet";
import { Modal, useModal } from "@/components/Modal";
import { Avatar } from "@/components/Avatar";
import { PresenceDot } from "@/components/PresenceDot";
import { useIsOnline } from "@/components/presence/PresenceProvider";
import { Button } from "@/components/ui/Button";
import { Input, Label } from "@/components/ui/Field";
import { createClient } from "@/lib/supabase/client";
import { uploadGroupAvatar } from "@/lib/avatars";
import {
  addRoomMember,
  deleteRoom,
  leaveRoom,
  openDm,
  removeRoomMember,
  renameRoom,
  setRoomAvatar,
  setRoomMemberRole,
} from "@/app/actions/rooms";
import type { Profile, RoomMemberRole, RoomMemberView, RoomType } from "@/lib/types";
import { publicDisplayName } from "@/lib/display-name";
import { useMutes } from "@/components/mute/MuteProvider";

type Candidate = Pick<Profile, "id" | "full_name" | "role">;

export function GroupDetails({
  roomId,
  roomName,
  roomType,
  roomAvatarUrl,
  members,
  currentUserId,
  currentUserRole,
  myRoomRole,
  onRosterChanged,
}: {
  roomId: string;
  roomName: string;
  roomType: RoomType;
  roomAvatarUrl: string | null;
  members: RoomMemberView[];
  currentUserId: string;
  currentUserRole: Profile["role"];
  myRoomRole: RoomMemberRole;
  onRosterChanged: () => Promise<void>;
}) {
  const router = useRouter();
  const isGroup = roomType === "group";
  const appManager = currentUserRole === "admin" || currentUserRole === "manager";
  // Group admins run the room; app admins/managers can run any group.
  const canManage = isGroup && (myRoomRole === "admin" || appManager);
  const canAdd = canManage;
  // Admins delete any channel; managers only the ones they run. Everyone
  // else never sees the control (delete_room re-checks server-side).
  const canDelete =
    isGroup &&
    (currentUserRole === "admin" ||
      (currentUserRole === "manager" && myRoomRole === "admin"));

  const addModal = useModal();
  const settingsModal = useModal();
  const { isRoomMuted, toggleRoomMute, isUserMuted, toggleUserMute } = useMutes();
  const groupMuted = isRoomMuted(roomId);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);

  async function run(key: string, fn: () => Promise<{ error?: string } | void>) {
    setBusy(key);
    setError(null);
    try {
      const res = await fn();
      if (res && "error" in res && res.error) {
        setError(res.error);
        return false;
      }
      await onRosterChanged();
      return true;
    } catch {
      setError("Something went wrong. Try again.");
      return false;
    } finally {
      setBusy(null);
    }
  }

  function fd(pairs: Record<string, string>) {
    const f = new FormData();
    for (const [k, v] of Object.entries(pairs)) f.set(k, v);
    return f;
  }

  async function onRemove(userId: string) {
    await run(`remove:${userId}`, () =>
      removeRoomMember({}, fd({ room_id: roomId, user_id: userId })),
    );
  }
  async function onSetRole(userId: string, role: RoomMemberRole) {
    await run(`role:${userId}`, () =>
      setRoomMemberRole({}, fd({ room_id: roomId, user_id: userId, role })),
    );
  }
  async function onLeave() {
    const ok = await run("leave", () =>
      leaveRoom({}, fd({ room_id: roomId })),
    );
    if (ok) router.push("/rooms");
  }

  const admins = members.filter((m) => m.room_role === "admin").length;

  return (
    <>
      <SheetHeader className="border-b border-line">
        <SheetTitle>Details</SheetTitle>
        <SheetDescription>
          {members.length} {members.length === 1 ? "member" : "members"}
        </SheetDescription>
      </SheetHeader>

      <div className="flex min-h-0 flex-1 flex-col">
        {/* Group identity */}
        <div className="flex items-center gap-3 border-b border-line px-4 py-4">
          {roomAvatarUrl ? (
            <Avatar name={roomName} size="lg" src={roomAvatarUrl} />
          ) : (
            <Avatar name={roomName} size="lg" />
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-[15px] font-semibold text-ink">
              {roomName}
            </p>
            <p className="text-[12px] text-muted">
              {isGroup ? "Group chat" : "Agent workspace"}
            </p>
          </div>
          {canManage && (
            <button
              type="button"
              onClick={settingsModal.openModal}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted hover:bg-mist hover:text-ink"
              aria-label="Group settings"
              title="Group settings"
            >
              <Settings className="size-5" />
            </button>
          )}
        </div>

        {error && (
          <p className="mx-4 mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        )}

        <div className="px-4 pt-3">
            <button
              type="button"
              onClick={() => toggleRoomMute(roomId)}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-line bg-paper px-3 py-2 text-sm font-medium text-ink hover:bg-mist"
            >
              {groupMuted ? (
                <Bell className="size-4" />
              ) : (
                <BellOff className="size-4" />
              )}
              {groupMuted ? "Unmute conversation" : "Mute this conversation"}
            </button>
          </div>

        {canAdd && (
          <div className="px-4 pt-3">
            <button
              type="button"
              onClick={addModal.openModal}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-line bg-paper px-3 py-2 text-sm font-medium text-ink hover:bg-mist"
            >
              <UserPlus className="size-4" /> Add members
            </button>
          </div>
        )}

        <ul className="min-h-0 flex-1 overflow-y-auto p-2">
          {members.map((m) => (
            <MemberItem
              key={m.id}
              member={m}
              self={m.id === currentUserId}
              canManage={canManage}
              onlyAdmin={m.room_role === "admin" && admins === 1}
              busy={busy}
              onRemove={() => onRemove(m.id)}
              onSetRole={(role) => onSetRole(m.id, role)}
              personMuted={m.id !== currentUserId && isUserMuted(m.id)}
              onTogglePersonMute={() => toggleUserMute(m.id)}
              canPrivateMessage={
                m.id !== currentUserId &&
                ((currentUserRole === "agent" && m.role === "assistant") ||
                  (currentUserRole === "assistant" && m.role === "agent"))
              }
            />
          ))}
        </ul>

        {isGroup && (
          <div className="border-t border-line p-3">
            {confirmLeave ? (
              <div className="flex items-center gap-2">
                <span className="flex-1 text-sm text-ink">Leave this group?</span>
                <button
                  type="button"
                  onClick={() => setConfirmLeave(false)}
                  className="rounded-md px-3 py-1.5 text-sm text-muted hover:bg-mist"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={onLeave}
                  disabled={busy === "leave"}
                  className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:brightness-110 disabled:opacity-50"
                >
                  {busy === "leave" ? "Leaving…" : "Leave"}
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmLeave(true)}
                className="flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50"
              >
                <LogOut className="size-4" /> Leave group
              </button>
            )}
          </div>
        )}
      </div>

      {canAdd && addModal.open && (
        <AddMembersModal
          roomId={roomId}
          existingIds={members.map((m) => m.id)}
          onClose={addModal.closeModal}
          onAdded={onRosterChanged}
        />
      )}

      {canManage && settingsModal.open && (
        <GroupSettingsModal
          roomId={roomId}
          initialName={roomName}
          initialAvatar={roomAvatarUrl}
          canDelete={canDelete}
          onClose={settingsModal.closeModal}
        />
      )}
    </>
  );
}

function MemberItem({
  member,
  self,
  canManage,
  onlyAdmin,
  busy,
  onRemove,
  onSetRole,
  personMuted,
  onTogglePersonMute,
  canPrivateMessage,
}: {
  member: RoomMemberView;
  self: boolean;
  canManage: boolean;
  onlyAdmin: boolean;
  busy: string | null;
  onRemove: () => void;
  onSetRole: (role: RoomMemberRole) => void;
  personMuted: boolean;
  onTogglePersonMute: () => void;
  canPrivateMessage: boolean;
}) {
  const router = useRouter();
  const online = useIsOnline(member.id);
  const isAdmin = member.room_role === "admin";
  const rowBusy =
    busy === `remove:${member.id}` || busy === `role:${member.id}`;
  const shownName = publicDisplayName(member);

  return (
    <li className="flex items-center gap-3 rounded-xl px-2.5 py-2.5 hover:bg-mist">
      <span className="relative shrink-0">
        <Avatar
          name={shownName}
          size="sm"
          userId={member.id}
          src={member.avatar_url}
        />
        <PresenceDot
          online={online}
          className="absolute -bottom-0.5 -right-0.5 ring-2 ring-paper"
        />
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 truncate text-sm font-medium text-ink">
          {shownName}
          {self && <span className="text-[12px] text-muted">(you)</span>}
          {isAdmin && (
            <span className="inline-flex items-center gap-0.5 rounded-full bg-brand-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-brand-700">
              <ShieldCheck className="size-3" /> Admin
            </span>
          )}
        </p>
        <p className="text-xs capitalize text-muted">
          {member.role}
          {member.is_active === false && " · deactivated"}
        </p>
      </div>

      {canPrivateMessage && (
        <button
          type="button"
          onClick={() => {
            void openDm(member.id).then((res) => {
              if (res.roomId) router.push(`/rooms/${res.roomId}`);
            });
          }}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted hover:bg-mist"
          aria-label={`Private message ${shownName}`}
          title="Private message"
        >
          <MessageCircle className="size-4" />
        </button>
      )}

      {!self && (
        <button
          type="button"
          onClick={onTogglePersonMute}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted hover:bg-mist"
          aria-label={
            personMuted
              ? `Unmute ${shownName}`
              : `Mute notifications from ${shownName}`
          }
          title={personMuted ? "Unmute this person" : "Mute this person"}
        >
          {personMuted ? (
            <BellOff className="size-4 text-ink" />
          ) : (
            <Bell className="size-4" />
          )}
        </button>
      )}

      {canManage && !self && (
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => onSetRole(isAdmin ? "member" : "admin")}
            disabled={rowBusy || (isAdmin && onlyAdmin)}
            className="rounded-md px-2 py-1 text-[12px] font-medium text-muted hover:bg-brand-50 hover:text-brand-700 disabled:opacity-40"
            title={isAdmin ? "Demote to member" : "Make admin"}
          >
            {isAdmin ? "Demote" : "Make admin"}
          </button>
          <button
            type="button"
            onClick={onRemove}
            disabled={rowBusy}
            className="flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-red-50 hover:text-red-600 disabled:opacity-40"
            aria-label={`Remove ${shownName}`}
            title="Remove from group"
          >
            <UserMinus className="size-4" />
          </button>
        </div>
      )}
    </li>
  );
}

function AddMembersModal({
  roomId,
  existingIds,
  onClose,
  onAdded,
}: {
  roomId: string;
  existingIds: string[];
  onClose: () => void;
  onAdded: () => Promise<void>;
}) {
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const supabase = createClient();
    void supabase
      .from("profiles")
      .select("id, full_name, role")
      .eq("is_active", true)
      .in("role", ["admin", "manager", "assistant"])
      .order("full_name")
      .then(({ data }) => {
        const existing = new Set(existingIds);
        setCandidates(
          ((data ?? []) as Candidate[]).filter((p) => !existing.has(p.id)),
        );
      });
  }, [existingIds]);

  function toggle(id: string) {
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  async function onAdd() {
    setPending(true);
    setError(null);
    for (const userId of selected) {
      const f = new FormData();
      f.set("room_id", roomId);
      f.set("user_id", userId);
      f.set("history_preset", "full");
      const res = await addRoomMember({}, f);
      if (res.error) {
        setError(res.error);
        setPending(false);
        await onAdded();
        return;
      }
    }
    setPending(false);
    await onAdded();
    onClose();
  }

  return (
    <Modal title="Add members" open onClose={onClose}>
      <div className="space-y-4">
        {error && (
          <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        )}
        <ul className="max-h-64 space-y-1 overflow-y-auto rounded-md border border-line p-2">
          {candidates.map((p) => (
            <li key={p.id}>
              <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-ink hover:bg-mist">
                <input
                  type="checkbox"
                  checked={selected.includes(p.id)}
                  onChange={() => toggle(p.id)}
                />
                <span className="flex-1 text-ink">{p.full_name}</span>
                <span className="text-xs capitalize text-muted">{p.role}</span>
              </label>
            </li>
          ))}
          {candidates.length === 0 && (
            <li className="px-2 py-1.5 text-sm text-muted">
              Everyone is already in this group.
            </li>
          )}
        </ul>
        <Button
          type="button"
          onClick={onAdd}
          disabled={pending || selected.length === 0}
          className="w-full"
        >
          {pending
            ? "Adding…"
            : `Add ${selected.length || ""}`.trim() +
              (selected.length ? " to group" : "")}
        </Button>
      </div>
    </Modal>
  );
}

function GroupSettingsModal({
  roomId,
  initialName,
  initialAvatar,
  canDelete,
  onClose,
}: {
  roomId: string;
  initialName: string;
  initialAvatar: string | null;
  canDelete: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [name, setName] = useState(initialName);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(initialAvatar);
  const [uploading, setUploading] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setUploading(true);
    setError(null);
    const res = await uploadGroupAvatar(file);
    setUploading(false);
    if (res.error || !res.url) {
      setError(res.error ?? "Could not upload the image.");
      return;
    }
    setAvatarUrl(res.url);
  }

  async function onSave() {
    setPending(true);
    setError(null);
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Give the group a name.");
      setPending(false);
      return;
    }

    if (trimmed !== initialName) {
      const f = new FormData();
      f.set("room_id", roomId);
      f.set("name", trimmed);
      const res = await renameRoom({}, f);
      if (res.error) {
        setError(res.error);
        setPending(false);
        return;
      }
    }
    if ((avatarUrl ?? "") !== (initialAvatar ?? "")) {
      const f = new FormData();
      f.set("room_id", roomId);
      f.set("avatar_url", avatarUrl ?? "");
      const res = await setRoomAvatar({}, f);
      if (res.error) {
        setError(res.error);
        setPending(false);
        return;
      }
    }
    // Name/avatar show in the header and sidebar, which the client router
    // caches; a reload is the reliable way to reflect them everywhere.
    window.location.reload();
  }

  return (
    <Modal title="Group settings" open onClose={onClose}>
      <div className="space-y-4">
        {error && (
          <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        )}
        <div className="flex items-center gap-3">
          <Avatar name={name || "Group"} size="lg" src={avatarUrl} />
          <div className="min-w-0">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              className="rounded-md border border-line px-3 py-1.5 text-sm font-medium text-ink hover:bg-mist disabled:opacity-50"
            >
              {uploading ? "Uploading…" : avatarUrl ? "Change image" : "Add image"}
            </button>
            {avatarUrl && (
              <button
                type="button"
                onClick={() => setAvatarUrl(null)}
                className="ml-2 text-sm text-muted hover:text-ink"
              >
                Remove
              </button>
            )}
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            hidden
            onChange={onPick}
          />
        </div>
        <div>
          <Label htmlFor="settings-name">Name</Label>
          <Input
            id="settings-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="off"
          />
        </div>
        <Button
          type="button"
          onClick={onSave}
          disabled={pending || uploading}
          className="w-full"
        >
          {pending ? "Saving…" : "Save changes"}
        </Button>

        {canDelete && (
          <div className="border-t border-line pt-4">
            {confirmDelete ? (
              <div className="space-y-2">
                <p className="text-sm text-ink">
                  Delete <span className="font-semibold">{initialName}</span>?
                  Every message and attachment reference in this channel is
                  removed for everyone. This cannot be undone.
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(false)}
                    className="flex-1 rounded-md border border-line px-3 py-2 text-sm text-muted hover:bg-mist"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={deleting}
                    onClick={async () => {
                      setDeleting(true);
                      setError(null);
                      const f = new FormData();
                      f.set("room_id", roomId);
                      const res = await deleteRoom({}, f);
                      if (res.error) {
                        setError(res.error);
                        setDeleting(false);
                        return;
                      }
                      router.push("/rooms");
                      router.refresh();
                    }}
                    className="flex-1 rounded-md bg-red-600 px-3 py-2 text-sm font-medium text-white hover:brightness-110 disabled:opacity-50"
                  >
                    {deleting ? "Deleting…" : "Delete channel"}
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className="flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50"
              >
                <Trash2 className="size-4" /> Delete channel
              </button>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
