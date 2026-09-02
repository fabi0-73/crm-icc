import { requireRole } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/server";
import { emailToUsername } from "@/lib/username";
import { NewUserButton } from "@/components/NewUserButton";
import { ResetPasswordButton } from "@/components/ResetPasswordButton";
import { ActionForm } from "@/components/ActionForm";
import { deactivateUser, reactivateUser } from "@/app/actions/admin";
import { PageHeader } from "@/components/ui/PageHeader";
import { Table, TBody, Td, Th, THead } from "@/components/ui/Table";

/** id → username, from the auth emails. Empty map if the service key is absent. */
async function loadUsernames(): Promise<Map<string, string>> {
  try {
    const service = createServiceClient();
    const { data } = await service.auth.admin.listUsers({
      page: 1,
      perPage: 1000,
    });
    return new Map(
      (data?.users ?? []).map((u) => [u.id, emailToUsername(u.email ?? "")]),
    );
  } catch {
    return new Map();
  }
}

export default async function UsersPage() {
  const { supabase, profile: self } = await requireRole(["admin"]);

  const [{ data: users, error }, usernames] = await Promise.all([
    supabase
      .from("profiles")
      .select("id, full_name, role, is_active, created_at")
      .order("full_name"),
    loadUsernames(),
  ]);

  if (error) {
    return <div className="p-6 text-sm text-red-600">{error.message}</div>;
  }

  return (
    <div className="h-full overflow-y-auto">
      <PageHeader title="Users" actions={<NewUserButton />} />
      <Table>
        <THead>
          <Th>Name</Th>
          <Th>Username</Th>
          <Th>Role</Th>
          <Th>Status</Th>
          <Th>Actions</Th>
        </THead>
        <TBody>
          {(users ?? []).map((u) => (
            <tr key={u.id}>
              <Td className="font-medium text-ink">{u.full_name}</Td>
              <Td className="font-mono text-xs text-muted">
                {usernames.get(u.id) ?? "—"}
              </Td>
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
                <div className="flex items-center gap-4">
                  {u.id === self.id ? (
                    <span className="text-muted">You</span>
                  ) : (
                    <ResetPasswordButton userId={u.id} name={u.full_name} />
                  )}
                  {/* Agent accounts are archived from the Agents page —
                      flipping them here would leave agents.status and the
                      login state disagreeing. */}
                  {u.role === "agent" ? (
                    <span className="text-muted">Manage on Agents</span>
                  ) : u.id === self.id ? null : u.is_active ? (
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
                </div>
              </Td>
            </tr>
          ))}
        </TBody>
      </Table>
    </div>
  );
}
