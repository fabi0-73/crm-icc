import { requireRole } from "@/lib/auth";
import { InviteUserButton } from "@/components/InviteUserButton";
import { ActionForm } from "@/components/ActionForm";
import { deactivateUser, reactivateUser } from "@/app/actions/admin";
import { PageHeader } from "@/components/ui/PageHeader";
import { Table, TBody, Td, Th, THead } from "@/components/ui/Table";

export default async function UsersPage() {
  const { supabase } = await requireRole(["admin"]);

  const { data: users, error } = await supabase
    .from("profiles")
    .select("id, full_name, role, is_active, created_at")
    .order("full_name");

  if (error) {
    return <div className="p-6 text-sm text-red-600">{error.message}</div>;
  }

  return (
    <div className="h-full overflow-y-auto">
      <PageHeader title="Users" actions={<InviteUserButton />} />
      <Table>
        <THead>
          <Th>Name</Th>
          <Th>Role</Th>
          <Th>Status</Th>
          <Th>Actions</Th>
        </THead>
        <TBody>
          {(users ?? []).map((u) => (
            <tr key={u.id}>
              <Td className="font-medium text-ink">{u.full_name}</Td>
              <Td className="capitalize text-muted">{u.role}</Td>
              <Td>
                <span
                  className={`inline-flex items-center gap-1.5 ${
                    u.is_active ? "text-ink" : "text-muted"
                  }`}
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      u.is_active ? "bg-emerald-500" : "bg-slate-300"
                    }`}
                  />
                  {u.is_active ? "Active" : "Inactive"}
                </span>
              </Td>
              <Td>
                {u.is_active ? (
                  <ActionForm action={deactivateUser}>
                    <input type="hidden" name="user_id" value={u.id} />
                    <button
                      type="submit"
                      className="font-medium text-red-600 hover:underline"
                    >
                      Deactivate
                    </button>
                  </ActionForm>
                ) : (
                  <ActionForm action={reactivateUser}>
                    <input type="hidden" name="user_id" value={u.id} />
                    <button
                      type="submit"
                      className="font-medium text-brand-600 hover:underline"
                    >
                      Reactivate
                    </button>
                  </ActionForm>
                )}
              </Td>
            </tr>
          ))}
        </TBody>
      </Table>
    </div>
  );
}
