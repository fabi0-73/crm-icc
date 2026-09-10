import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { CreateAgentButton } from "@/components/CreateAgentButton";
import { Avatar } from "@/components/Avatar";
import { PageHeader } from "@/components/ui/PageHeader";

export default async function AgentsPage() {
  const { supabase, profile } = await requireRole(["admin", "manager"]);

  const { data: agents, error } = await supabase
    .from("agents")
    .select("id, display_name, status, created_at")
    .order("display_name");

  if (error) {
    return <div className="p-6 text-sm text-red-700">{error.message}</div>;
  }

  return (
    <div className="mx-auto h-full max-w-3xl overflow-y-auto bg-paper sm:border-x sm:border-line">
      <PageHeader
        title="Agents"
        actions={profile.role === "admin" ? <CreateAgentButton /> : undefined}
      />
      <ul>
        {(agents ?? []).map((a) => (
          <li key={a.id} className="border-b border-line">
            <Link
              href={`/agents/${a.id}`}
              className="flex items-center gap-3 px-3 py-3 hover:bg-mist"
            >
              <Avatar name={a.display_name} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-ink">
                  {a.display_name}
                </p>
                <p className="text-xs capitalize text-muted">{a.status}</p>
              </div>
            </Link>
          </li>
        ))}
        {(agents ?? []).length === 0 && (
          <li className="px-4 py-10 text-center text-sm text-muted">
            No agents yet
          </li>
        )}
      </ul>
    </div>
  );
}
