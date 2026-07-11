import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { SwapAssistantsButton } from "@/components/SwapAssistantsButton";
import { ActionForm } from "@/components/ActionForm";
import { archiveAgent } from "@/app/actions/agents";
import { buttonClasses } from "@/components/ui/Button";
import { BackIcon } from "@/components/icons";

export default async function AgentDetailPage({
  params,
}: {
  params: Promise<{ agentId: string }>;
}) {
  const { agentId } = await params;
  const { supabase } = await requireRole(["admin", "manager"]);

  const { data: agent } = await supabase
    .from("agents")
    .select("id, display_name, status, user_id, created_at")
    .eq("id", agentId)
    .maybeSingle();

  if (!agent) notFound();

  const { data: room } = await supabase
    .from("rooms")
    .select("id")
    .eq("agent_id", agentId)
    .eq("type", "agent_workspace")
    .maybeSingle();

  const { data: assignments } = await supabase
    .from("assignments")
    .select("id, assistant_id, assigned_at")
    .eq("agent_id", agentId)
    .is("removed_at", null);

  const assistantIds = (assignments ?? []).map((a) => a.assistant_id);
  const { data: assistants } = assistantIds.length
    ? await supabase
        .from("profiles")
        .select("id, full_name")
        .in("id", assistantIds)
    : { data: [] as { id: string; full_name: string }[] };

  const { data: allAssistants } = await supabase
    .from("profiles")
    .select("id, full_name")
    .eq("role", "assistant")
    .eq("is_active", true)
    .order("full_name");

  const assignedSet = new Set(assistantIds);
  const available = (allAssistants ?? []).filter((a) => !assignedSet.has(a.id));

  return (
    <div className="h-full overflow-y-auto">
      <div className="border-b border-line bg-paper px-4 py-4">
        <Link
          href="/agents"
          className="inline-flex items-center gap-1 text-[13px] font-medium text-brand-600 hover:text-brand-700"
        >
          <BackIcon size={15} /> Agents
        </Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold text-ink">
              {agent.display_name}
            </h1>
            <p className="text-[13px] text-muted capitalize">{agent.status}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {room && (
              <Link
                href={`/rooms/${room.id}`}
                className={buttonClasses("secondary", "sm")}
              >
                Open chat
              </Link>
            )}
            {agent.status === "active" && (
              <SwapAssistantsButton
                agentId={agent.id}
                assigned={(assistants ?? []).map((a) => ({
                  id: a.id,
                  full_name: a.full_name,
                }))}
                available={available.map((a) => ({
                  id: a.id,
                  full_name: a.full_name,
                }))}
              />
            )}
          </div>
        </div>
      </div>

      <section className="p-4 space-y-4 max-w-xl">
        <div className="rounded-lg border border-line bg-paper p-4">
          <h2 className="text-sm font-semibold text-ink mb-3">
            Assigned assistants
          </h2>
          {(assistants ?? []).length === 0 ? (
            <p className="text-sm text-muted">None assigned.</p>
          ) : (
            <ul className="space-y-2">
              {(assistants ?? []).map((a) => (
                <li
                  key={a.id}
                  className="flex items-center justify-between text-sm"
                >
                  <span>{a.full_name}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {agent.status === "active" && (
          <ActionForm action={archiveAgent} className="space-y-2">
            <input type="hidden" name="agent_id" value={agent.id} />
            <button
              type="submit"
              className="inline-flex h-8 items-center justify-center rounded-md border border-red-200 px-3 text-[13px] font-medium text-red-700 transition-colors hover:bg-red-50"
            >
              Archive agent
            </button>
          </ActionForm>
        )}
      </section>
    </div>
  );
}
