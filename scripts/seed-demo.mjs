/**
 * Seed demo users, agents, rooms, and chat history.
 * Usage: node scripts/seed-demo.mjs
 * Requires NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env.local
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { resolve } from "path";

function loadEnv() {
  const raw = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
  for (const line of raw.split("\n")) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (!m) continue;
    process.env[m[1].trim()] ??= m[2].trim();
  }
}

loadEnv();

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing Supabase env");
  process.exit(1);
}

const sb = createClient(url, key, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const PASSWORD = "Demo1234!";

const daysAgo = (n, hour = 10, minute = 0) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
};

async function ensureUser({ email, full_name, role }) {
  const list = await sb.auth.admin.listUsers({ perPage: 200 });
  const existing = list.data?.users?.find(
    (u) => u.email?.toLowerCase() === email.toLowerCase(),
  );
  let id = existing?.id;
  if (!id) {
    const { data, error } = await sb.auth.admin.createUser({
      email,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { full_name },
    });
    if (error) throw new Error(`${email}: ${error.message}`);
    id = data.user.id;
  } else {
    await sb.auth.admin.updateUserById(id, {
      password: PASSWORD,
      email_confirm: true,
    });
  }

  const { error: pErr } = await sb.from("profiles").upsert({
    id,
    full_name,
    role,
    is_active: true,
  });
  if (pErr) throw new Error(`profile ${email}: ${pErr.message}`);
  return id;
}

async function insertMessage({
  room_id,
  sender_id,
  kind = "text",
  body,
  created_at,
  metadata = null,
}) {
  const { error } = await sb.from("messages").insert({
    room_id,
    sender_id,
    kind,
    body,
    metadata,
    created_at,
  });
  if (error) throw new Error(`message: ${error.message}`);
}

async function main() {
  console.log("Seeding demo data…");

  const adminId = await ensureUser({
    email: "admin@icc.local",
    full_name: "Admin",
    role: "admin",
  });
  const managerId = await ensureUser({
    email: "manager@icc.local",
    full_name: "Maya Chen",
    role: "manager",
  });
  const claraId = await ensureUser({
    email: "clara@icc.local",
    full_name: "Clara Novak",
    role: "assistant",
  });
  const benId = await ensureUser({
    email: "ben@icc.local",
    full_name: "Ben Ortiz",
    role: "assistant",
  });
  const sofiaId = await ensureUser({
    email: "sofia@icc.local",
    full_name: "Sofia Reed",
    role: "assistant",
  });
  const jamesUserId = await ensureUser({
    email: "james@icc.local",
    full_name: "James Whitfield",
    role: "agent",
  });
  const elenaUserId = await ensureUser({
    email: "elena@icc.local",
    full_name: "Elena Rossi",
    role: "agent",
  });

  // Clean prior demo agents by display name (idempotent-ish)
  const { data: existingAgents } = await sb
    .from("agents")
    .select("id, user_id, display_name")
    .in("display_name", ["James Whitfield", "Elena Rossi"]);

  for (const a of existingAgents ?? []) {
    const { data: rooms } = await sb
      .from("rooms")
      .select("id")
      .eq("agent_id", a.id);
    for (const r of rooms ?? []) {
      await sb.from("messages").delete().eq("room_id", r.id);
      await sb.from("room_members").delete().eq("room_id", r.id);
      await sb.from("rooms").delete().eq("id", r.id);
    }
    await sb.from("assignments").delete().eq("agent_id", a.id);
    await sb.from("agents").delete().eq("id", a.id);
  }

  // Delete demo group rooms named "Ops desk"
  const { data: oldGroups } = await sb
    .from("rooms")
    .select("id")
    .eq("type", "group")
    .eq("name", "Ops desk");
  for (const r of oldGroups ?? []) {
    await sb.from("messages").delete().eq("room_id", r.id);
    await sb.from("room_members").delete().eq("room_id", r.id);
    await sb.from("rooms").delete().eq("id", r.id);
  }

  async function createAgentWorkspace({
    userId,
    displayName,
    assistants,
    creatorId,
  }) {
    const { data: agent, error: aErr } = await sb
      .from("agents")
      .insert({
        user_id: userId,
        display_name: displayName,
        status: "active",
        created_by: creatorId,
      })
      .select("*")
      .single();
    if (aErr) throw aErr;

    const { data: room, error: rErr } = await sb
      .from("rooms")
      .insert({
        type: "agent_workspace",
        agent_id: agent.id,
        name: displayName,
        created_by: creatorId,
      })
      .select("*")
      .single();
    if (rErr) throw rErr;

    const memberMap = new Map();
    const addMember = (user_id, extra = {}) => {
      memberMap.set(user_id, {
        room_id: room.id,
        user_id,
        added_by: creatorId,
        ...extra,
      });
    };
    addMember(userId);
    addMember(creatorId);
    addMember(managerId);
    for (const asst of assistants) {
      addMember(asst.id, {
        can_view_history_from: asst.historyFrom ?? null,
      });
      await sb.from("assignments").insert({
        agent_id: agent.id,
        assistant_id: asst.id,
        assigned_by: creatorId,
        assigned_at: asst.assignedAt ?? daysAgo(20),
      });
    }
    const { error: mErr } = await sb
      .from("room_members")
      .insert([...memberMap.values()]);
    if (mErr) throw mErr;

    await insertMessage({
      room_id: room.id,
      sender_id: null,
      kind: "system",
      body: "Workspace created",
      created_at: daysAgo(21, 9, 0),
      metadata: { event: "workspace_created" },
    });

    return { agent, room };
  }

  const james = await createAgentWorkspace({
    userId: jamesUserId,
    displayName: "James Whitfield",
    creatorId: adminId,
    assistants: [
      { id: claraId, assignedAt: daysAgo(18) },
      { id: sofiaId, assignedAt: daysAgo(5), historyFrom: daysAgo(7) },
    ],
  });

  const elena = await createAgentWorkspace({
    userId: elenaUserId,
    displayName: "Elena Rossi",
    creatorId: managerId,
    assistants: [{ id: benId, assignedAt: daysAgo(14) }],
  });

  // James chat history
  const j = james.room.id;
  const thread = [
    {
      sender_id: claraId,
      body: "Good morning James — confirming your 11:00 with Meridian Capital. Driver is booked for 10:20.",
      created_at: daysAgo(14, 8, 12),
    },
    {
      sender_id: jamesUserId,
      body: "Perfect. Can you also pull last quarter's notes into the brief?",
      created_at: daysAgo(14, 8, 25),
    },
    {
      sender_id: claraId,
      body: "Done — brief is in the shared folder. Flagged the covenant question on page 3.",
      created_at: daysAgo(14, 9, 5),
    },
    {
      sender_id: null,
      kind: "system",
      body: "Sofia Reed joined the workspace",
      created_at: daysAgo(5, 10, 0),
      metadata: { event: "swap", added: ["Sofia Reed"] },
    },
    {
      sender_id: sofiaId,
      body: "Hi James — I'm covering evenings this week. Clara briefed me on Meridian. Anything urgent tonight?",
      created_at: daysAgo(5, 18, 40),
    },
    {
      sender_id: jamesUserId,
      body: "Please hold my Friday dinner reservation under Whitfield, party of 4, 20:00.",
      created_at: daysAgo(3, 16, 10),
    },
    {
      sender_id: claraId,
      body: "Reserved at The Garden Room. Confirmation #GR-4821.",
      created_at: daysAgo(3, 16, 22),
    },
    {
      sender_id: sofiaId,
      body: "Travel update: BA flight tomorrow is delayed 40m. I've moved the car to 14:55.",
      created_at: daysAgo(1, 19, 5),
    },
    {
      sender_id: jamesUserId,
      body: "Thanks Sofia. Also need a quiet room near Terminal 5 if the delay stretches.",
      created_at: daysAgo(1, 19, 18),
    },
    {
      sender_id: claraId,
      body: "Lounge access arranged. I'll keep an eye on the board from 13:00.",
      created_at: daysAgo(0, 7, 45),
    },
  ];
  for (const m of thread) {
    await insertMessage({ room_id: j, ...m });
  }

  // Elena chat history
  const e = elena.room.id;
  const elenaThread = [
    {
      sender_id: benId,
      body: "Elena — Milan itinerary draft is ready. Prefer the early train or the 11:40 flight?",
      created_at: daysAgo(10, 11, 0),
    },
    {
      sender_id: elenaUserId,
      body: "Flight. I need the morning clear for the board call.",
      created_at: daysAgo(10, 11, 20),
    },
    {
      sender_id: benId,
      body: "Booked. Hotel holds the suite with late checkout. Invoice routed to finance.",
      created_at: daysAgo(9, 15, 30),
    },
    {
      sender_id: managerId,
      body: "Ben, please loop me if the vendor contract needs a second signature.",
      created_at: daysAgo(4, 12, 0),
    },
    {
      sender_id: elenaUserId,
      body: "Can someone chase the NDA from their counsel? It's blocking the kickoff.",
      created_at: daysAgo(2, 9, 15),
    },
    {
      sender_id: benId,
      body: "Chased — they promised it by EOD. I'll ping again at 16:00.",
      created_at: daysAgo(2, 9, 40),
    },
    {
      sender_id: benId,
      body: "NDA received and filed. Kickoff is clear for Thursday 09:30.",
      created_at: daysAgo(0, 8, 50),
    },
  ];
  for (const m of elenaThread) {
    await insertMessage({ room_id: e, ...m });
  }

  // Ops desk group
  const { data: group, error: gErr } = await sb
    .from("rooms")
    .insert({
      type: "group",
      name: "Ops desk",
      created_by: managerId,
    })
    .select("*")
    .single();
  if (gErr) throw gErr;

  await sb.from("room_members").insert([
    { room_id: group.id, user_id: managerId, added_by: managerId },
    { room_id: group.id, user_id: adminId, added_by: managerId },
    { room_id: group.id, user_id: claraId, added_by: managerId },
    { room_id: group.id, user_id: benId, added_by: managerId },
    { room_id: group.id, user_id: sofiaId, added_by: managerId },
  ]);

  await insertMessage({
    room_id: group.id,
    sender_id: null,
    kind: "system",
    body: "Group created",
    created_at: daysAgo(12, 9, 0),
    metadata: { event: "group_created" },
  });
  await insertMessage({
    room_id: group.id,
    sender_id: managerId,
    body: "Coverage this week: Clara on James days, Sofia evenings, Ben on Elena. Ping here for handoffs.",
    created_at: daysAgo(12, 9, 10),
  });
  await insertMessage({
    room_id: group.id,
    sender_id: claraId,
    body: "Noted. I'll post a short handoff note before 18:00 each day.",
    created_at: daysAgo(12, 9, 25),
  });
  await insertMessage({
    room_id: group.id,
    sender_id: sofiaId,
    body: "James travel delay handled — car moved. All quiet otherwise.",
    created_at: daysAgo(1, 20, 5),
  });
  await insertMessage({
    room_id: group.id,
    sender_id: benId,
    body: "Elena NDA is in. No blockers for Thursday.",
    created_at: daysAgo(0, 9, 5),
  });

  // Leave one unread for admin by setting last_read_at older on ops desk
  await sb
    .from("room_members")
    .update({ last_read_at: daysAgo(2) })
    .eq("room_id", group.id)
    .eq("user_id", adminId);

  console.log("\nDemo ready. Password for all accounts:", PASSWORD);
  console.log(`
  admin@icc.local     Admin
  manager@icc.local   Maya Chen (manager)
  clara@icc.local     Clara Novak (assistant)
  ben@icc.local       Ben Ortiz (assistant)
  sofia@icc.local     Sofia Reed (assistant)
  james@icc.local     James Whitfield (agent)
  elena@icc.local     Elena Rossi (agent)
`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
