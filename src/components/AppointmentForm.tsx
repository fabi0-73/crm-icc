"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarPlus, ListChecks, Pencil, Plus, Trash2, X } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Input, Label, Select } from "@/components/ui/Field";

/** The client's time zone, as dialers already write it. */
const ZONES = ["EST", "CST", "MST", "PST", "AKST", "HST"];
type Agent = { id: string; name: string };

/** "Wed, Oct 1, 2026 · 3:30 PM EST" — how create_appointment writes it. */
function whenText(date: string, time: string, tz: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const day = new Date(y, m - 1, d).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  const clock = `${h12}:${String(mm).padStart(2, "0")} ${hh < 12 ? "AM" : "PM"}`;
  return `${day} · ${clock}${tz ? ` ${tz}` : ""}`;
}

/**
 * "New appointment": the only way an appointment reaches the Excel export.
 * Each field is stored as typed (create_appointment, migration 0023), and
 * the same call posts the usual readable message in the group. Nothing is
 * posted until the person has seen the preview and confirmed it.
 *
 * The agent is picked from a shared list (migration 0025) so one agent is
 * never spelled three ways; admins and managers keep that list from here.
 */
export function AppointmentForm({
  roomId,
  dialerName,
  canManageAgents = false,
  onClose,
}: {
  roomId: string;
  /** Prefilled: the person filling the form is normally the dialer. */
  dialerName: string;
  /** Admins and managers: may add and remove names on the agent list. */
  canManageAgents?: boolean;
  onClose: () => void;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [agent, setAgent] = useState("");
  const [policy, setPolicy] = useState("");
  const [client, setClient] = useState("");
  const [phone, setPhone] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [tz, setTz] = useState("EST");
  const [busy, setBusy] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [managing, setManaging] = useState(false);
  const [newAgent, setNewAgent] = useState("");
  const [listBusy, setListBusy] = useState(false);

  const loadAgents = useCallback(async () => {
    const { data, error: rpcError } = await supabase.rpc("appointment_agent_names");
    if (rpcError) {
      setError("Could not load the agent list.");
      return;
    }
    setAgents((data ?? []) as Agent[]);
  }, [supabase]);

  useEffect(() => {
    void loadAgents();
  }, [loadAgents]);

  const addAgent = async () => {
    const name = newAgent.trim();
    if (!name || listBusy) return;
    setListBusy(true);
    setError(null);
    const { error: rpcError } = await supabase.rpc("add_appointment_agent", {
      p_name: name,
    });
    if (rpcError) setError(rpcError.message || "Could not add that name.");
    else setNewAgent("");
    await loadAgents();
    setListBusy(false);
  };

  const removeAgent = async (a: Agent) => {
    if (listBusy) return;
    setListBusy(true);
    setError(null);
    const { error: rpcError } = await supabase.rpc("remove_appointment_agent", {
      p_id: a.id,
    });
    if (rpcError) setError(rpcError.message || "Could not remove that name.");
    else if (agent === a.name) setAgent("");
    await loadAgents();
    setListBusy(false);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // First submit (the browser has checked the required fields): show the
  // preview. Confirm on the preview is what actually posts.
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setReviewing(true);
  };

  const confirm = async () => {
    setBusy(true);
    setError(null);
    const { error: rpcError } = await supabase.rpc("create_appointment", {
      p_room: roomId,
      p_dialer: dialerName,
      p_agent: agent,
      p_policy: policy,
      p_client: client,
      p_phone: phone,
      p_date: date,
      p_time: time,
      p_tz: tz,
    });
    setBusy(false);
    if (rpcError) {
      setError(rpcError.message || "Could not save the appointment.");
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
        aria-labelledby="appt-title"
      >
        <div className="mb-4 flex items-center gap-2.5">
          <span className="flex size-9 items-center justify-center rounded-full bg-brand-50 text-brand-700 dark:bg-brand-950 dark:text-brand-300">
            <CalendarPlus className="size-[18px]" />
          </span>
          <h2 id="appt-title" className="flex-1 text-[17px] font-semibold text-ink">
            {managing ? "Agent list" : reviewing ? "Preview" : "New appointment"}
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

        {managing ? (
          <div>
            <p className="mb-2.5 text-[13px] text-muted">
              Dialers pick the agent from this list. Removing a name keeps the
              appointments already booked with it.
            </p>
            <div className="flex gap-2">
              <Input
                aria-label="New agent name"
                placeholder="Agent's full name"
                value={newAgent}
                onChange={(e) => setNewAgent(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void addAgent();
                  }
                }}
                maxLength={200}
                autoFocus
              />
              <button
                type="button"
                onClick={() => void addAgent()}
                disabled={listBusy || !newAgent.trim()}
                className="flex h-10 shrink-0 items-center gap-1.5 self-center rounded-full bg-brand-600 px-4 text-[14px] font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
              >
                <Plus className="size-4" />
                Add
              </button>
            </div>
            <ul className="mt-3 max-h-[45dvh] divide-y divide-line overflow-y-auto rounded-xl border border-line">
              {(agents ?? []).map((a) => (
                <li key={a.id} className="flex items-center gap-2 py-1.5 pl-3.5 pr-1.5 text-[14px] text-ink">
                  <span className="min-w-0 flex-1 truncate">{a.name}</span>
                  <button
                    type="button"
                    onClick={() => void removeAgent(a)}
                    disabled={listBusy}
                    aria-label={`Remove ${a.name}`}
                    title="Remove from the list"
                    className="flex size-8 items-center justify-center rounded-full text-muted hover:bg-red-50 hover:text-red-600 disabled:opacity-50 dark:hover:bg-red-950/50"
                  >
                    <Trash2 className="size-4" />
                  </button>
                </li>
              ))}
              {agents?.length === 0 && (
                <li className="px-3.5 py-3 text-[13px] text-muted">No agents yet.</li>
              )}
            </ul>
          </div>
        ) : reviewing ? (
          <div>
            <p className="mb-2.5 text-[13px] text-muted">
              Check it before it goes to the group.
            </p>
            <dl className="divide-y divide-line rounded-xl border border-line bg-mist/40 text-[14px]">
              {(
                [
                  ["Dialer", dialerName],
                  ["Agent", agent.trim()],
                  ["Policy #", policy.trim() || "—"],
                  ["Client", client.trim()],
                  ["Phone", phone.trim()],
                  ["When", whenText(date, time, tz)],
                ] as const
              ).map(([k, v]) => (
                <div key={k} className="flex gap-3 px-3.5 py-2.5">
                  <dt className="w-20 shrink-0 text-muted">{k}</dt>
                  <dd className="min-w-0 flex-1 break-words font-medium text-ink">{v}</dd>
                </div>
              ))}
            </dl>
          </div>
        ) : (
        <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
          <div>
            <Label htmlFor="appt-dialer">Dialer</Label>
            {/* Always the person posting (create_appointment sets it), so
                one person can't appear under two spellings. */}
            <Input id="appt-dialer" value={dialerName} readOnly disabled />
          </div>
          <div>
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <Label htmlFor="appt-agent" className="!mb-0">
                Agent
              </Label>
              {canManageAgents && (
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    setManaging(true);
                  }}
                  className="flex items-center gap-1 text-[12px] font-medium text-brand-700 hover:underline dark:text-brand-300"
                >
                  <ListChecks className="size-3.5" />
                  Manage list
                </button>
              )}
            </div>
            <Select
              id="appt-agent"
              autoFocus
              value={agent}
              onChange={(e) => setAgent(e.target.value)}
              required
              disabled={agents === null}
            >
              <option value="" disabled>
                {agents === null ? "Loading…" : "Choose an agent"}
              </option>
              {(agents ?? []).map((a) => (
                <option key={a.id} value={a.name}>
                  {a.name}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="appt-client">Client name</Label>
            <Input id="appt-client" value={client} onChange={(e) => setClient(e.target.value)} required maxLength={200} />
          </div>
          <div>
            <Label htmlFor="appt-phone">Phone number</Label>
            <Input
              id="appt-phone"
              type="tel"
              inputMode="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              required
              maxLength={40}
            />
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="appt-policy">
              Policy # <span className="font-normal text-muted">(if there is one)</span>
            </Label>
            <Input id="appt-policy" value={policy} onChange={(e) => setPolicy(e.target.value)} maxLength={200} />
          </div>
          <div>
            <Label htmlFor="appt-date">Appointment date</Label>
            <Input id="appt-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          </div>
          <div className="flex gap-2">
            <div className="min-w-0 flex-1">
              <Label htmlFor="appt-time">Time</Label>
              <Input id="appt-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} required />
            </div>
            <div className="w-24 shrink-0">
              <Label htmlFor="appt-tz">Zone</Label>
              <Select id="appt-tz" value={tz} onChange={(e) => setTz(e.target.value)}>
                {ZONES.map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
                <option value="">—</option>
              </Select>
            </div>
          </div>
        </div>
        )}

        {error && (
          <p className="mt-3.5 rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-700 dark:bg-red-950/50 dark:text-red-300">
            {error}
          </p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          {managing ? (
            <button
              type="button"
              onClick={() => {
                setError(null);
                setManaging(false);
              }}
              className="h-10 rounded-full bg-brand-600 px-5 text-[14px] font-semibold text-white hover:bg-brand-700"
            >
              Done
            </button>
          ) : reviewing ? (
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
                {busy ? "Posting…" : "Confirm & post"}
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
                className="h-10 rounded-full bg-brand-600 px-5 text-[14px] font-semibold text-white hover:bg-brand-700"
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
