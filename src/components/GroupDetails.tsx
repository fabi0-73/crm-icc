"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  LogOut,
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
import { MuteToggle } from "@/components/MuteToggle";
import { PresenceDot } from "@/components/PresenceDot";
import { useIsOnline } from "@/components/presence/PresenceProvider";
import { Button } from "@/components/ui/Button";
import { Input, Label } from "@/components/ui/Field";
import { createClient } from "@/lib/supabase/client";
import { uploadGroupAvatar, uploadGroupBackground } from "@/lib/avatars";
import {
  addRoomMember,
  deleteRoom,
  leaveRoom,
  openDm,
  removeRoomMember,
  renameRoom,
  setRoomAvatar,
  setRoomBackground,
  setRoomMemberRole,
} from "@/app/actions/rooms";
import type { Profile, RoomMemberRole, RoomMemberView, RoomType } from "@/lib/types";

type Candidate = Pick<Profile, "id" | "full_name" | "role">;

export function GroupDetails({
  roomId,
  roomName,
  roomType,
  roomAvatarUrl,
  roomBackgroundUrl = null,
  roomCreatedBy,
  members,
  currentUserId,
  currentUserRole,
  myRoomRole,
  onRosterChanged,
  tabs,
}: {
  roomId: string;
  roomName: string;
  roomType: RoomType;
  roomAvatarUrl: string | null;
  roomBackgroundUrl?: string | null;
  roomCreatedBy?: string | null;
  members: RoomMemberView[];
  currentUserId: string;
  currentUserRole: Profile["role"];
  myRoomRole: RoomMemberRole;
  onRosterChanged: () => Promise<void>;
  /** Optional switcher rendered under the header (Members / Media). */
  tabs?: React.ReactNode;
}) {
  const router = useRouter();
  const isGroup = roomType === "group";
  const appManager = currentUserRole === "admin" || currentUserRole === "manager";
  // Group admins run the room; app admins/managers can run any group.
  // Adding members, leaving, removing, renaming, roles, avatar — all
  // group-admin / app-manager actions. A plain assistant member sees none
  // of them (they're placed and removed by an admin).
  const canManage = isGroup && (myRoomRole === "admin" || appManager);
  const canAdd = canManage;
  // The wallpaper is deliberately narrower than canManage: this group's
  // own admins and the Admin role only — not every manager. Mirrors the
  // rule inside set_room_background.
  const canSetBackground =
    isGroup && (myRoomRole === "admin" || currentUserRole === "admin");
  // Deletion: an app admin removes ANY group; a manager or assistant removes
  // only a group they created. Mirrors the server rule in delete_room so the
  // button is never shown to someone the RPC would reject.
  const canDelete =
    isGroup &&
    (currentUserRole === "admin" || roomCreatedBy === currentUserId);

  const addModal = useModal();
  const settingsModal = useModal();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

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
  async function onDelete() {
    setBusy("delete");
    setError(null);
    try {
      const res = await deleteRoom(roomId);
      if (res.error) {
        setError(res.error);
        return;
      }
      router.push("/rooms");
    } catch {
      setError("Something went wrong. Try again.");
    } finally {
      setBusy(null);
    }
  }
  // An agent's only entry point to start a private DM with an assistant
  // they share a workspace with (agents have no sidebar / DM list). Surface
  // the error instead of failing silently if the DM can't be opened.
  async function onMessage(userId: string) {
    const res = await openDm(userId);
    if (res.roomId) {
      router.push(`/rooms/${res.roomId}`);
    } else if (res.error) {
      setError(res.error);
    }
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
      {tabs}

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

        {/* Per-conversation mute (device-local) */}
        <div className="border-b border-line px-2 py-2">
          <MuteToggle roomId={roomId} />
        </div>

        {error && (
          <p className="mx-4 mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/50 dark:text-red-300">
            {error}
          </p>
        )}

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
              onMessage={
                currentUserRole === "agent" &&
                m.role === "assistant" &&
                m.id !== currentUserId
                  ? () => void onMessage(m.id)
                  : undefined
              }
            />
          ))}
        </ul>

        {canManage && (
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
                className="flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
              >
                <LogOut className="size-4" /> Leave group
              </button>
            )}
          </div>
        )}

        {canDelete && (
          <div className="border-t border-line p-3">
            {confirmDelete ? (
              <div className="flex items-center gap-2">
                <span className="flex-1 text-sm text-ink">
                  Delete this group for everyone? This can’t be undone.
                </span>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(false)}
                  className="rounded-md px-3 py-1.5 text-sm text-muted hover:bg-mist"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={onDelete}
                  disabled={busy === "delete"}
                  className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:brightness-110 disabled:opacity-50"
                >
                  {busy === "delete" ? "Deleting…" : "Delete"}
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className="flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
              >
                <Trash2 className="size-4" /> Delete group
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
          initialBackground={roomBackgroundUrl}
          canSetBackground={canSetBackground}
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
  onMessage,
}: {
  member: RoomMemberView;
  self: boolean;
  canManage: boolean;
  onlyAdmin: boolean;
  busy: string | null;
  onRemove: () => void;
  onSetRole: (role: RoomMemberRole) => void;
  onMessage?: () => void;
}) {
  const online = useIsOnline(member.id);
  const isAdmin = member.room_role === "admin";
  const rowBusy =
    busy === `remove:${member.id}` || busy === `role:${member.id}`;

  return (
    <li className="flex items-center gap-3 rounded-xl px-2.5 py-2.5 hover:bg-mist">
      <span className="relative shrink-0">
        <Avatar name={member.full_name} size="sm" userId={member.id} />
        <PresenceDot
          online={online}
          className="absolute -bottom-0.5 -right-0.5 ring-2 ring-paper"
        />
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 truncate text-sm font-medium text-ink">
          {member.full_name}
          {self && <span className="text-[12px] text-muted">(you)</span>}
          {isAdmin && (
            <span className="inline-flex items-center gap-0.5 rounded-full bg-brand-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-brand-700 dark:bg-brand-900/40 dark:text-brand-300">
              <ShieldCheck className="size-3" /> Admin
            </span>
          )}
        </p>
        <p className="text-xs capitalize text-muted">
          {member.role}
          {member.is_active === false && " · deactivated"}
        </p>
      </div>

      {onMessage && !self && (
        <button
          type="button"
          onClick={onMessage}
          className="shrink-0 rounded-md border border-line px-2.5 py-1 text-[12px] font-medium text-brand-700 hover:bg-brand-50 dark:text-brand-300 dark:hover:bg-brand-900/30"
        >
          Message
        </button>
      )}

      {canManage && !self && (
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => onSetRole(isAdmin ? "member" : "admin")}
            disabled={rowBusy || (isAdmin && onlyAdmin)}
            className="rounded-md px-2 py-1 text-[12px] font-medium text-muted hover:bg-brand-50 hover:text-brand-700 disabled:opacity-40 dark:hover:bg-brand-900/30 dark:hover:text-brand-300"
            title={isAdmin ? "Demote to member" : "Make admin"}
          >
            {isAdmin ? "Demote" : "Make admin"}
          </button>
          <button
            type="button"
            onClick={onRemove}
            disabled={rowBusy}
            className="flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-red-50 hover:text-red-600 disabled:opacity-40 dark:hover:bg-red-950/40 dark:hover:text-red-400"
            aria-label={`Remove ${member.full_name}`}
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
          <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/50 dark:text-red-300">
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
  initialBackground = null,
  canSetBackground = false,
  onClose,
}: {
  roomId: string;
  initialName: string;
  initialAvatar: string | null;
  initialBackground?: string | null;
  canSetBackground?: boolean;
  onClose: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(initialAvatar);
  const [backgroundUrl, setBackgroundUrl] = useState<string | null>(
    initialBackground,
  );
  const [uploading, setUploading] = useState(false);
  const [uploadingBg, setUploadingBg] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const bgFileRef = useRef<HTMLInputElement>(null);

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

  async function onPickBackground(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setUploadingBg(true);
    setError(null);
    const res = await uploadGroupBackground(roomId, file);
    setUploadingBg(false);
    if (res.error || !res.url) {
      setError(res.error ?? "Could not upload the image.");
      return;
    }
    setBackgroundUrl(res.url);
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
    if (
      canSetBackground &&
      (backgroundUrl ?? "") !== (initialBackground ?? "")
    ) {
      const res = await setRoomBackground(roomId, backgroundUrl);
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
          <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/50 dark:text-red-300">
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
        {canSetBackground && (
          <div>
            <Label>Chat background</Label>
            <p className="mb-2 text-[12px] text-muted">
              Everyone in this group sees it behind the messages.
            </p>
            <div className="flex items-center gap-3">
              <div
                className="h-14 w-24 shrink-0 rounded-lg border border-line bg-mist bg-cover bg-center"
                style={
                  backgroundUrl
                    ? {
                        backgroundImage: `url("${backgroundUrl.replace(/"/g, "%22")}")`,
                      }
                    : undefined
                }
                aria-hidden
              />
              <div className="min-w-0">
                <button
                  type="button"
                  onClick={() => bgFileRef.current?.click()}
                  disabled={uploadingBg}
                  className="rounded-md border border-line px-3 py-1.5 text-sm font-medium text-ink hover:bg-mist disabled:opacity-50"
                >
                  {uploadingBg
                    ? "Uploading…"
                    : backgroundUrl
                      ? "Change background"
                      : "Add background"}
                </button>
                {backgroundUrl && (
                  <button
                    type="button"
                    onClick={() => setBackgroundUrl(null)}
                    className="ml-2 text-sm text-muted hover:text-ink"
                  >
                    Remove
                  </button>
                )}
                <p className="mt-1 text-[12px] text-muted">
                  JPG, PNG or WEBP. 5 MB or smaller.
                </p>
              </div>
            </div>
            <input
              ref={bgFileRef}
              type="file"
              accept="image/*"
              hidden
              onChange={onPickBackground}
            />
          </div>
        )}
        <Button
          type="button"
          onClick={onSave}
          disabled={pending || uploading}
          className="w-full"
        >
          {pending ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </Modal>
  );
}
