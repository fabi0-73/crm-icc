import { requireRole } from "@/lib/auth";
import { PageHeader } from "@/components/ui/PageHeader";
import { Table, TBody, Td, Th, THead } from "@/components/ui/Table";

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
      <PageHeader title="Audit log" subtitle="Most recent 200 events" />
      <Table>
        <THead>
          <Th>When</Th>
          <Th>Actor</Th>
          <Th>Action</Th>
          <Th>Target</Th>
          <Th>Details</Th>
        </THead>
        <TBody>
          {(logs ?? []).map((log) => (
            <tr key={log.id} className="align-top">
              <Td className="whitespace-nowrap text-muted">
                {new Date(log.created_at).toLocaleString()}
              </Td>
              <Td>
                {log.actor_id
                  ? (actorMap.get(log.actor_id) ?? log.actor_id.slice(0, 8))
                  : "—"}
              </Td>
              <Td className="font-mono text-xs">{log.action}</Td>
              <Td className="text-muted">
                {log.target_type}
                {log.target_id ? ` · ${log.target_id.slice(0, 8)}` : ""}
              </Td>
              <Td className="max-w-xs truncate text-xs text-muted">
                {JSON.stringify(log.metadata)}
              </Td>
            </tr>
          ))}
          {(logs ?? []).length === 0 && (
            <tr>
              <Td className="py-8 text-center text-muted">
                No audit events yet.
              </Td>
              <Td /><Td /><Td /><Td />
            </tr>
          )}
        </TBody>
      </Table>
    </div>
  );
}
