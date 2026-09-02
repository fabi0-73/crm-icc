"use client";

import { useEffect, useState } from "react";
import { Modal, useModal } from "@/components/Modal";
import { ActionForm } from "@/components/ActionForm";
import {
  deleteUserAccount,
  describeUserDeletion,
  type DeletionFootprint,
} from "@/app/actions/admin";
import { Input, Label } from "@/components/ui/Field";

/** Plain-language list of what deletion takes with it. */
function consequences(f: DeletionFootprint) {
  const gone: string[] = [];
  if (f.messages > 0) {
    gone.push(
      `${f.messages} message${f.messages === 1 ? "" : "s"} they sent — removed from every conversation`,
    );
  }
  if (f.workspace) {
    gone.push(
      `their workspace “${f.workspace.name}” and its ${f.workspace.messages} message${
        f.workspace.messages === 1 ? "" : "s"
      }`,
    );
  }
  if (f.dmRooms > 0) {
    gone.push(
      `${f.dmRooms} direct chat${f.dmRooms === 1 ? "" : "s"} they were part of`,
    );
  }
  if (f.memberships > 0) {
    gone.push(
      `their place in ${f.memberships} conversation${f.memberships === 1 ? "" : "s"}`,
    );
  }
  if (gone.length === 0) gone.push("nothing — this account never posted anything");
  return gone;
}

export function DeleteUserButton({
  userId,
  name,
}: {
  userId: string;
  name: string;
}) {
  const { open, openModal, closeModal } = useModal();
  const [footprint, setFootprint] = useState<DeletionFootprint | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [typed, setTyped] = useState("");

  // The numbers are fetched when the dialog opens, so the table stays fast.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setFootprint(null);
    setLoadError(null);
    setTyped("");
    void describeUserDeletion(userId).then((res) => {
      if (cancelled) return;
      if (res.error) setLoadError(res.error);
      else setFootprint(res.footprint ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [open, userId]);

  function finish() {
    closeModal();
    // A reload, not router.refresh(): with staleTimes the client router
    // cache serves the old table for 30s and the deleted person never shows.
    window.location.reload();
  }

  return (
    <>
      <button
        type="button"
        onClick={openModal}
        className="font-medium text-red-600 hover:underline"
      >
        Delete
      </button>

      <Modal title={`Delete ${name}`} open={open} onClose={closeModal}>
        {loadError && (
          <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            {loadError}
          </p>
        )}

        {!footprint && !loadError && (
          <p className="py-4 text-sm text-muted">Checking what they own…</p>
        )}

        {footprint?.blockedReason && (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
            {footprint.blockedReason}
          </p>
        )}

        {footprint && !footprint.blockedReason && (
          <ActionForm
            action={deleteUserAccount}
            className="space-y-4"
            onResult={(s) => {
              if (s.success) finish();
            }}
          >
            <input type="hidden" name="user_id" value={userId} />

            <div>
              <p className="text-sm text-muted">
                Permanently deletes the login{" "}
                <span className="font-mono text-[13px] text-ink">
                  {footprint.username}
                </span>
                . This can&rsquo;t be undone.
              </p>
              <ul className="mt-2.5 space-y-1.5 text-[13px] text-ink-soft">
                {consequences(footprint).map((line) => (
                  <li key={line} className="flex gap-2">
                    <span aria-hidden className="text-red-600">
                      &minus;
                    </span>
                    <span>{line}</span>
                  </li>
                ))}
              </ul>
              {(footprint.reassigned > 0 || footprint.auditEntries > 0) && (
                <p className="mt-2.5 text-[13px] text-muted">
                  Kept: shared channels and groups they set up
                  {footprint.reassigned > 0
                    ? ` (${footprint.reassigned} record${
                        footprint.reassigned === 1 ? "" : "s"
                      } move to you)`
                    : ""}
                  {footprint.auditEntries > 0
                    ? `, and ${footprint.auditEntries} audit entr${
                        footprint.auditEntries === 1 ? "y" : "ies"
                      }`
                    : ""}
                  .
                </p>
              )}
              <p className="mt-2.5 text-[13px] text-muted">
                To keep their history readable, use Deactivate instead.
              </p>
            </div>

            {footprint.needsTypedConfirmation && (
              <div>
                <Label htmlFor={`confirm-${userId}`}>
                  Type <span className="font-mono">{footprint.username}</span> to
                  confirm
                </Label>
                <Input
                  id={`confirm-${userId}`}
                  name="confirm"
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  autoComplete="off"
                />
              </div>
            )}

            <button
              type="submit"
              disabled={
                footprint.needsTypedConfirmation &&
                typed.trim().toLowerCase() !== footprint.username.toLowerCase()
              }
              className="h-10 w-full rounded-lg bg-red-600 text-[15px] font-semibold text-white transition-[filter] hover:brightness-110 active:brightness-95 disabled:opacity-40"
            >
              Delete permanently
            </button>
          </ActionForm>
        )}
      </Modal>
    </>
  );
}
