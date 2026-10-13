"use client";

import { useEffect, useMemo, useState } from "react";
import { ClipboardList, Pencil, X } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Input, Label, Textarea } from "@/components/ui/Field";

/** The group's template, in its order and its words. */
const FIELDS = [
  { key: "pick_ups", label: "Pick ups" },
  { key: "appts", label: "Appt" },
  { key: "callbacks", label: "Callbacks" },
  { key: "hung_ups", label: "Hung ups" },
  { key: "others", label: "Others" },
  { key: "wrong_numbers", label: "Wrong number" },
] as const;
type FieldKey = (typeof FIELDS)[number]["key"];
type Values = Record<FieldKey, string>;
const EMPTY: Values = {
  pick_ups: "",
  appts: "",
  callbacks: "",
  hung_ups: "",
  others: "",
  wrong_numbers: "",
};

/**
 * "New report" in a report group (rooms.report_form, migration 0027): the
 * shift's numbers, each stored as typed for the totals and the Excel file,
 * plus free-text comments. The same call posts the readable message. As
 * with appointments, nothing is posted before the preview is confirmed.
 *
 * With `editMessageId` it corrects a sent report (update_shift_report).
 */
export function ReportForm({
  roomId,
  editMessageId,
  onClose,
}: {
  roomId: string;
  editMessageId?: string;
  onClose: () => void;
}) {
  const supabase = useMemo(() => createClient(), []);
  const editing = Boolean(editMessageId);
  const [values, setValues] = useState<Values>(EMPTY);
  const [comments, setComments] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadingEdit, setLoadingEdit] = useState(editing);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!editMessageId) return;
    let live = true;
    void (async () => {
      const { data, error: rpcError } = await supabase.rpc("shift_report_for_message", {
        p_message: editMessageId,
      });
      if (!live) return;
      setLoadingEdit(false);
      const r = (data as (Record<FieldKey, number> & { comments: string | null })[] | null)?.[0];
      if (rpcError || !r) {
        setError("Could not load this report.");
        return;
      }
      setValues(
        Object.fromEntries(FIELDS.map((f) => [f.key, String(r[f.key])])) as Values,
      );
      setComments(r.comments ?? "");
    })();
    return () => {
      live = false;
    };
  }, [supabase, editMessageId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setReviewing(true);
  };

  const confirm = async () => {
    setBusy(true);
    setError(null);
    const n = (k: FieldKey) => Number(values[k]);
    const args = {
      p_pick_ups: n("pick_ups"),
      p_appts: n("appts"),
      p_callbacks: n("callbacks"),
      p_hung_ups: n("hung_ups"),
      p_others: n("others"),
      p_wrong: n("wrong_numbers"),
      p_comments: comments,
    };
    const { error: rpcError } = editMessageId
      ? await supabase.rpc("update_shift_report", { p_message: editMessageId, ...args })
      : await supabase.rpc("create_shift_report", { p_room: roomId, ...args });
    setBusy(false);
    if (rpcError) {
      setError(rpcError.message || "Could not save the report.");
      return;
    }
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-[110] flex items-end justify-center bg-ink/60 sm:items-center sm:p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form
        onSubmit={submit}
        className="max-h-[92dvh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-paper p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-lift sm:rounded-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="report-title"
      >
        <div className="mb-4 flex items-center gap-2.5">
          <span className="flex size-9 items-center justify-center rounded-full bg-brand-50 text-brand-700 dark:bg-brand-950 dark:text-brand-300">
            <ClipboardList className="size-[18px]" />
          </span>
          <h2 id="report-title" className="flex-1 text-[17px] font-semibold text-ink">
            {reviewing ? "Preview" : editing ? "Edit report" : "New report"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex size-8 items-center justify-center rounded-full text-muted hover:bg-mist hover:text-ink"
          >
            <X className="size-[18px]" />
          </button>
        </div>

        {reviewing ? (
          <div>
            <p className="mb-2.5 text-[13px] text-muted">
              {editing
                ? "Check it before the change is saved."
                : "Check it before it goes to the group."}
            </p>
            <dl className="divide-y divide-line rounded-xl border border-line bg-mist/40 text-[14px]">
              {FIELDS.map((f) => (
                <div key={f.key} className="flex gap-3 px-3.5 py-2.5">
                  <dt className="w-32 shrink-0 text-muted">{f.label}</dt>
                  <dd className="min-w-0 flex-1 font-medium tabular-nums text-ink">
                    {Number(values[f.key])}
                  </dd>
                </div>
              ))}
              <div className="flex gap-3 px-3.5 py-2.5">
                <dt className="w-32 shrink-0 text-muted">Comments</dt>
                <dd className="min-w-0 flex-1 whitespace-pre-wrap break-words font-medium text-ink">
                  {comments.trim() || "—"}
                </dd>
              </div>
            </dl>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3.5 sm:grid-cols-3">
            {FIELDS.map((f, i) => (
              <div key={f.key}>
                <Label htmlFor={`report-${f.key}`}>{f.label}</Label>
                <Input
                  id={`report-${f.key}`}
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={100000}
                  step={1}
                  placeholder="0"
                  autoFocus={i === 0 && !editing}
                  value={values[f.key]}
                  onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                  required
                  disabled={loadingEdit}
                />
              </div>
            ))}
            <div className="col-span-2 sm:col-span-3">
              <Label htmlFor="report-comments">
                Comments <span className="font-normal text-muted">(optional)</span>
              </Label>
              <Textarea
                id="report-comments"
                value={comments}
                onChange={(e) => setComments(e.target.value)}
                maxLength={2000}
                rows={3}
                disabled={loadingEdit}
                className="resize-y"
              />
            </div>
          </div>
        )}

        {error && (
          <p className="mt-3.5 rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-700 dark:bg-red-950/50 dark:text-red-300">
            {error}
          </p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          {reviewing ? (
            <>
              <button
                type="button"
                onClick={() => setReviewing(false)}
                disabled={busy}
                className="flex h-10 items-center gap-1.5 rounded-full px-4 text-[14px] font-medium text-ink hover:bg-mist disabled:opacity-50"
              >
                <Pencil className="size-4" />
                Edit
              </button>
              <button
                type="button"
                autoFocus
                onClick={() => void confirm()}
                disabled={busy}
                className="h-10 rounded-full bg-brand-600 px-5 text-[14px] font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
              >
                {busy
                  ? editing
                    ? "Saving…"
                    : "Posting…"
                  : editing
                    ? "Save changes"
                    : "Confirm & post"}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={onClose}
                className="h-10 rounded-full px-4 text-[14px] font-medium text-muted hover:bg-mist hover:text-ink"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={loadingEdit}
                className="h-10 rounded-full bg-brand-600 px-5 text-[14px] font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
              >
                Review
              </button>
            </>
          )}
        </div>
      </form>
    </div>
  );
}
