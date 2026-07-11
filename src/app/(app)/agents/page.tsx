import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { CreateAgentButton } from "@/components/CreateAgentButton";
import { Avatar } from "@/components/Avatar";

export default async function AgentsPage() {
  const { supabase } = await requireRole(["admin", "manager"]);

  const { data: agents, error } = await supabase
    .from("agents")
    .select("id, display_name, status, created_at")
    .order("display_name");

  if (error) {
    return <div className="p-6 text-sm text-red-700">{error.message}</div>;
  }

  return (
    <div className="mx-auto h-full max-w-3xl overflow-y-auto bg-white sm:border-x sm:border-line">
      <div className="flex items-center justify-between border-b border-line bg-[#f0f2f5] px-3 py-2.5">
        <h1 className="text-[16px] font-semibold text-ink">Agents</h1>
        <CreateAgentButton />
      </div>
      <ul>
        {(agents ?? []).map((a) => (
          <li key={a.id} className="border-b border-line">
            <Link
              href={`/agents/${a.id}`}
              className="flex items-center gap-3 px-3 py-3 hover:bg-mist/80"
            >
              <Avatar name={a.display_name} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[15px] font-medium text-ink">
                  {a.display_name}
                </p>
                <p className="text-[12px] capitalize text-muted">{a.status}</p>
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
