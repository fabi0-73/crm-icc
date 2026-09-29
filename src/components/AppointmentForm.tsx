"use client";

import { useEffect, useMemo, useState } from "react";
import { CalendarPlus, X } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Input, Label, Select } from "@/components/ui/Field";

/** The client's time zone, as dialers already write it. */
const ZONES = ["EST", "CST", "MST", "PST", "AKST", "HST"];
/** Agent names this person used lately — a per-browser convenience only. */
const RECENT_AGENTS_KEY = "icc.recentAgents";

function recentAgents(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_AGENTS_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, 12) : [];
  } catch {
    return [];
  }
}

function rememberAgent(name: string) {
  try {
    const next = [name, ...recentAgents().filter((n) => n !== name)].slice(0, 12);
    localStorage.setItem(RECENT_AGENTS_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable — nothing lost but the suggestion */
  }
}

/**
 * "New appointment": the only way an appointment reaches the Excel export.
 * Each field is stored as typed (create_appointment, migration 0023), and
 * the same call posts the usual readable message in the group.
 */
export function AppointmentForm({
  roomId,
  dialerName,
  onClose,
}: {
  roomId: string;
  /** Prefilled: the person filling the form is normally the dialer. */
  dialerName: string;
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
  const [error, setError] = useState<string | null>(null);
  const [agents, setAgents] = useState<string[]>([]);

  useEffect(() => {
    setAgents(recentAgents());
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
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
    rememberAgent(agent.trim());
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
            New appointment
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

        <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
          <div>
            <Label htmlFor="appt-dialer">Dialer</Label>
            {/* Always the person posting (create_appointment sets it), so
                one person can't appear under two spellings. */}
            <Input id="appt-dialer" value={dialerName} readOnly disabled />
          </div>
          <div>
            <Label htmlFor="appt-agent">Agent</Label>
            <Input
              id="appt-agent"
              autoFocus
              value={agent}
              onChange={(e) => setAgent(e.target.value)}
              list="appt-agents"
              autoComplete="off"
              required
              maxLength={200}
            />
            <datalist id="appt-agents">
              {agents.map((a) => (
                <option key={a} value={a} />
              ))}
            </datalist>
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

        {error && (
          <p className="mt-3.5 rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-700 dark:bg-red-950/50 dark:text-red-300">
            {error}
          </p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-10 rounded-full px-4 text-[14px] font-medium text-muted hover:bg-mist hover:text-ink"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy}
            className="h-10 rounded-full bg-brand-600 px-5 text-[14px] font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {busy ? "Posting…" : "Post appointment"}
          </button>
        </div>
      </form>
    </div>
  );
}
