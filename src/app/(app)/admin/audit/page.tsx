import { requireRole } from "@/lib/auth";

export default async function AuditPage() {
  const { supabase } = await requireRole(["admin", "manager"]);

  const { data: logs, error } = await supabase
    .from("audit_logs")
    .select("id, actor_id, action, target_type, target_id, room_id, metadata, created_at")
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) {
    return <div className="p-6 text-sm text-red-600">{error.message}</div>;
  }

  const actorIds = [
    ...new Set(
      (logs ?? [])
        .map((l) => l.actor_id)
        .filter((id): id is string => Boolean(id)),
    ),
  ];

  const { data: actors } = actorIds.length
    ? await supabase.from("profiles").select("id, full_name").in("id", actorIds)
    : { data: [] as { id: string; full_name: string }[] };

  const actorMap = new Map((actors ?? []).map((a) => [a.id, a.full_name]));

  return (
    <div className="h-full overflow-y-auto">
      <div className="border-b border-gray-200 bg-white px-4 py-3">
        <h1 className="text-lg font-semibold text-gray-900">Audit log</h1>
        <p className="text-sm text-gray-500">Most recent 200 events</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="bg-gray-50 text-xs uppercase text-gray-500">
            <tr>
              <th className="px-4 py-2 font-medium">When</th>
              <th className="px-4 py-2 font-medium">Actor</th>
              <th className="px-4 py-2 font-medium">Action</th>
              <th className="px-4 py-2 font-medium">Target</th>
              <th className="px-4 py-2 font-medium">Details</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 bg-white">
            {(logs ?? []).map((log) => (
              <tr key={log.id} className="align-top">
                <td className="px-4 py-3 whitespace-nowrap text-gray-500">
                  {new Date(log.created_at).toLocaleString()}
                </td>
                <td className="px-4 py-3">
                  {log.actor_id
                    ? (actorMap.get(log.actor_id) ?? log.actor_id.slice(0, 8))
                    : "—"}
                </td>
                <td className="px-4 py-3 font-mono text-xs">{log.action}</td>
                <td className="px-4 py-3 text-gray-600">
                  {log.target_type}
                  {log.target_id ? ` · ${log.target_id.slice(0, 8)}` : ""}
                </td>
                <td className="px-4 py-3 text-xs text-gray-500 max-w-xs truncate">
                  {JSON.stringify(log.metadata)}
                </td>
              </tr>
            ))}
            {(logs ?? []).length === 0 && (
              <tr>
                <td
                  colSpan={5}
                  className="px-4 py-8 text-center text-gray-500"
                >
                  No audit events yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
