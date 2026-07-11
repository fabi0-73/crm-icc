import { requireRole } from "@/lib/auth";
import { InviteUserButton } from "@/components/InviteUserButton";
import { ActionForm } from "@/components/ActionForm";
import { deactivateUser, reactivateUser } from "@/app/actions/admin";

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
      <div className="flex items-center justify-between border-b border-gray-200 bg-white px-4 py-3">
        <h1 className="text-lg font-semibold text-gray-900">Users</h1>
        <InviteUserButton />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="bg-gray-50 text-xs uppercase text-gray-500">
            <tr>
              <th className="px-4 py-2 font-medium">Name</th>
              <th className="px-4 py-2 font-medium">Role</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 bg-white">
            {(users ?? []).map((u) => (
              <tr key={u.id}>
                <td className="px-4 py-3 font-medium text-gray-900">
                  {u.full_name}
                </td>
                <td className="px-4 py-3 capitalize text-gray-600">{u.role}</td>
                <td className="px-4 py-3">
                  <span
                    className={
                      u.is_active ? "text-emerald-600" : "text-gray-400"
                    }
                  >
                    {u.is_active ? "Active" : "Inactive"}
                  </span>
                </td>
                <td className="px-4 py-3">
                  {u.is_active ? (
                    <ActionForm action={deactivateUser}>
                      <input type="hidden" name="user_id" value={u.id} />
                      <button
                        type="submit"
                        className="text-red-600 hover:underline"
                      >
                        Deactivate
                      </button>
                    </ActionForm>
                  ) : (
                    <ActionForm action={reactivateUser}>
                      <input type="hidden" name="user_id" value={u.id} />
                      <button
                        type="submit"
                        className="text-brand-600 hover:underline"
                      >
                        Reactivate
                      </button>
                    </ActionForm>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
