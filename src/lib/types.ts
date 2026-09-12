export type Role = "admin" | "manager" | "assistant" | "agent";

export type Profile = {
  id: string;
  full_name: string;
  /** Chat-facing name; null means fall back to full_name. */
  public_name: string | null;
  /** Public storage URL; null means the initials avatar. */
  avatar_url: string | null;
  role: Role;
  is_active: boolean;
  created_at: string;
};

export type Agent = {
  id: string;
  user_id: string;
  display_name: string;
  status: "active" | "archived";
  created_by: string;
  manager_id?: string | null;
  created_at: string;
};

export type Assignment = {
  id: string;
  agent_id: string;
  assistant_id: string;
  assigned_at: string;
  assigned_by: string;
  removed_at: string | null;
  removed_by: string | null;
  removal_reason: string | null;
};

export type RoomType = "agent_workspace" | "group" | "dm";

export type Room = {
  id: string;
  type: RoomType;
  agent_id: string | null;
  name: string;
  created_by: string;
  created_at: string;
  /** Group chat wallpaper (public URL); null for DMs and un-imaged groups. */
  background_url?: string | null;
};

export type RoomMember = {
  room_id: string;
  user_id: string;
  can_view_history_from: string | null;
  last_read_at: string;
  added_at: string;
  added_by: string;
  role: RoomMemberRole;
};

/** A room member joined to their profile, as the chat roster shows them. */
export type RoomMemberView = {
  id: string;
  full_name: string;
  public_name?: string | null;
  avatar_url?: string | null;
  /** The person's app-wide role (admin/manager/assistant/agent). */
  role: Role;
  is_active: boolean | null;
  /** Their standing in THIS room. */
  room_role: RoomMemberRole;
  last_read_at?: string | null;
  last_delivered_at?: string | null;
};

export type MessageKind = "text" | "file" | "system";

export type Message = {
  id: string;
  room_id: string;
  sender_id: string | null;
  kind: MessageKind;
  body: string;
  attachment_path: string | null;
  attachment_name: string | null;
  attachment_size: number | null;
  attachment_mime: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  pinned_at?: string | null;
  pinned_by?: string | null;
};

export type AuditLog = {
  id: number;
  actor_id: string | null;
  action: string;
  target_type: string;
  target_id: string | null;
  room_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
};

export type RoomMemberRole = "admin" | "member";

export type MyRoom = {
  room_id: string;
  name: string;
  /** Other member's name for DMs; equals name otherwise. */
  display_name: string;
  type: RoomType;
  agent_id: string | null;
  /** Group avatar (public URL); null for DMs and un-imaged groups. */
  avatar_url: string | null;
  /** Non-null exactly when type === "dm" — for presence/avatar. */
  dm_other_user_id: string | null;
  last_message_at: string | null;
  last_message_body: string | null;
  last_message_kind: MessageKind | null;
  last_message_sender: string | null;
  unread_count: number;
};

export type HistoryPreset =
  | "full"
  | "last_30_days"
  | "last_7_days"
  | "from_today"
  | "none";
