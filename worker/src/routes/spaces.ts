import { Hono, type Context } from "hono";
import type { Env, UserPayload } from "../types";
import { authRequired } from "../middleware/auth";
import * as spaceDB from "../db/space";
import * as userDB from "../db/user";
import { deleteStoredObjects } from "../storage";

type SpaceApp = { Bindings: Env; Variables: { user: UserPayload } };
type SpaceContext = Context<SpaceApp>;

export const spaceRoutes = new Hono<SpaceApp>();

const SPACE_UID_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,34}[a-zA-Z0-9])?$/;
const SPACE_MEMBER_ROLE_VALUES = new Set(["ADMIN", "USER"]);

function generateSpaceUid(): string {
  return crypto.randomUUID();
}

function parseSpaceUid(name?: string): string {
  const value = name || "";
  return value.startsWith("spaces/") ? value.slice("spaces/".length) : value;
}

function parseUsername(name?: string): string {
  const value = name || "";
  return value.startsWith("users/") ? value.slice("users/".length) : value;
}

function parseRole(value: unknown): string | undefined {
  if (value === 1 || value === "1") return "ADMIN";
  if (value === 2 || value === "2") return "USER";
  if (typeof value === "string") {
    const normalized = value.toUpperCase();
    return SPACE_MEMBER_ROLE_VALUES.has(normalized) ? normalized : undefined;
  }
  return undefined;
}

function roleToNumber(role: string): number {
  return role === "ADMIN" ? 1 : role === "USER" ? 2 : 0;
}

function parseIconPayload(rawPayload: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(rawPayload || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeIcon(input: unknown): Record<string, string> | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }
  const icon = input as { emoji?: unknown; lucide?: unknown; case?: unknown; value?: unknown };
  if (icon.case === "emoji" && typeof icon.value === "string") {
    return { emoji: icon.value };
  }
  if (icon.case === "lucide" && typeof icon.value === "string") {
    return { lucide: icon.value };
  }
  if (typeof icon.emoji === "string" && icon.emoji.trim()) {
    return { emoji: icon.emoji.trim() };
  }
  if (typeof icon.lucide === "string" && icon.lucide.trim()) {
    return { lucide: icon.lucide.trim() };
  }
  return undefined;
}

function buildPayloadWithIcon(existingPayload: string, iconInput: unknown): string {
  const payload = parseIconPayload(existingPayload);
  const icon = normalizeIcon(iconInput);
  if (icon) {
    return JSON.stringify({ ...payload, icon });
  }
  if (iconInput !== undefined) {
    const next = { ...payload };
    delete next.icon;
    return JSON.stringify(next);
  }
  return JSON.stringify(payload);
}

function formatSpaceIcon(row: spaceDB.SpaceRow): Record<string, string> | undefined {
  const icon = parseIconPayload(row.payload).icon;
  if (!icon || typeof icon !== "object") {
    return undefined;
  }
  const value = icon as { emoji?: unknown; lucide?: unknown };
  if (typeof value.emoji === "string" && value.emoji) return { emoji: value.emoji };
  if (typeof value.lucide === "string" && value.lucide) return { lucide: value.lucide };
  return undefined;
}

function formatSpaceMetadata(row: spaceDB.SpaceRow) {
  const icon = formatSpaceIcon(row);
  return {
    name: `spaces/${row.uid}`,
    title: row.title,
    description: row.description,
    ...(icon ? { icon } : {}),
  };
}

function formatSpace(row: spaceDB.SpaceRow, options: { metadataOnly?: boolean } = {}) {
  if (options.metadataOnly) {
    return formatSpaceMetadata(row);
  }
  return {
    ...formatSpaceMetadata(row),
    currentUserRole: roleToNumber(row.current_user_role || ""),
    memberCount: row.member_count ?? 0,
  };
}

function formatMember(spaceUid: string, member: spaceDB.SpaceMemberRow) {
  return {
    name: `spaces/${spaceUid}/members/${member.username}`,
    user: `users/${member.username}`,
    role: roleToNumber(member.role),
  };
}

function formatInvitation(space: spaceDB.SpaceRow, invitation: spaceDB.SpaceInvitationRow) {
  return {
    name: `spaces/${space.uid}/invitations/${invitation.username}`,
    invitee: `users/${invitation.username}`,
    role: roleToNumber(invitation.role),
    space: formatSpaceMetadata(space),
  };
}

function getPageParams(c: SpaceContext): { limit: number; offset: number } {
  const limit = Math.max(1, Math.min(Number(c.req.query("pageSize")) || 100, 1000));
  const pageToken = c.req.query("pageToken");
  let offset = 0;
  if (pageToken) {
    try {
      const parsed = JSON.parse(atob(pageToken)) as { offset?: number };
      if (typeof parsed.offset === "number" && Number.isFinite(parsed.offset)) {
        offset = Math.max(0, Math.trunc(parsed.offset));
      }
    } catch {
      offset = 0;
    }
  }
  return { limit, offset };
}

function nextPageToken(offset: number, limit: number, count: number): string {
  return count >= limit ? btoa(JSON.stringify({ offset: offset + limit })) : "";
}

async function findSpaceAndMembership(c: SpaceContext, spaceUid: string) {
  const user = c.get("user");
  const space = await spaceDB.getSpaceByUid(c.env.DB, spaceUid, user.id);
  if (!space) {
    return { space: null, membership: null };
  }
  const membership = await spaceDB.getSpaceMember(c.env.DB, space.id, user.id);
  if (!membership || membership.status !== "ACTIVE" || !SPACE_MEMBER_ROLE_VALUES.has(membership.role)) {
    return { space: null, membership: null };
  }
  return { space, membership };
}

async function getSpaceRowByUid(c: SpaceContext, spaceUid: string) {
  return c.env.DB.prepare("SELECT id, uid, title, description, payload FROM space WHERE uid = ?")
    .bind(spaceUid)
    .first<spaceDB.SpaceRow>();
}

async function resolveInvitationNotification(c: SpaceContext, receiverId: number, spaceUid: string, mode: "archive" | "delete") {
  const { results } = await c.env.DB.prepare(
    "SELECT id, message FROM inbox WHERE receiver_id = ? AND json_extract(message, '$.type') = 'SPACE_INVITATION'"
  ).bind(receiverId).all<{ id: number; message: string }>();

  for (const row of results) {
    let parsed: { spaceUid?: string } = {};
    try {
      parsed = JSON.parse(row.message || "{}");
    } catch {
      continue;
    }
    if (parsed.spaceUid !== spaceUid) continue;
    if (mode === "archive") {
      await c.env.DB.prepare("UPDATE inbox SET status = 'ARCHIVED' WHERE id = ?").bind(row.id).run();
    } else {
      await c.env.DB.prepare("DELETE FROM inbox WHERE id = ?").bind(row.id).run();
    }
  }
}

// List the spaces the caller belongs to.
spaceRoutes.get("/", authRequired, async (c) => {
  const user = c.get("user");
  const spaces = await spaceDB.listSpacesForUser(c.env.DB, user.id);
  return c.json({
    spaces: spaces.map((space) => formatSpace(space)),
    nextPageToken: "",
  });
});

// Create a space; the caller becomes its first administrator.
spaceRoutes.post("/", authRequired, async (c) => {
  const user = c.get("user");
  const body = await c.req.json<Record<string, unknown>>();
  const spaceInput = (body.space ?? body) as Record<string, unknown>;
  const title = typeof spaceInput.title === "string" ? spaceInput.title.trim() : "";
  if (!title) {
    return c.json({ code: 3, message: "space title is required", details: [] }, 400);
  }

  const requestedUid = typeof body.spaceId === "string" && body.spaceId.trim() ? body.spaceId.trim() : generateSpaceUid();
  if (!SPACE_UID_PATTERN.test(requestedUid)) {
    return c.json({ code: 3, message: "invalid space id", details: [] }, 400);
  }
  if (await getSpaceRowByUid(c, requestedUid)) {
    return c.json({ code: 6, message: "space already exists", details: [] }, 409);
  }

  const payload = buildPayloadWithIcon("{}", spaceInput.icon);
  const space = await spaceDB.createSpace(
    c.env.DB,
    {
      uid: requestedUid,
      title,
      description: typeof spaceInput.description === "string" ? spaceInput.description.trim() : "",
      payload,
    },
    user.id,
  );

  return c.json(formatSpace(space));
});

// Get one space visible through membership.
spaceRoutes.get("/:spaceUid", authRequired, async (c) => {
  const user = c.get("user");
  const { space } = await findSpaceAndMembership(c, c.req.param("spaceUid"));
  if (!space) {
    return c.json({ code: 5, message: "space not found", details: [] }, 404);
  }
  const members = await spaceDB.listSpaceMembers(c.env.DB, space.id);
  return c.json({
    ...formatSpace({ ...space, member_count: members.length }),
  });
});

// Update space metadata. Administrator only.
spaceRoutes.patch("/:spaceUid", authRequired, async (c) => {
  const { space, membership } = await findSpaceAndMembership(c, c.req.param("spaceUid"));
  if (!space || !membership) {
    return c.json({ code: 5, message: "space not found", details: [] }, 404);
  }
  if (membership.role !== "ADMIN") {
    return c.json({ code: 7, message: "space administrator permission required", details: [] }, 403);
  }

  const body = await c.req.json<Record<string, unknown>>();
  const spaceInput = (body.space ?? body) as Record<string, unknown>;
  const updateData: Partial<{ title: string; description: string; payload: string }> = {};
  const updateMask = c.req.query("updateMask") || c.req.query("update_mask") || "";
  const paths = updateMask ? new Set(updateMask.split(",").map((path) => path.trim())) : undefined;
  const canUpdate = (path: string) => !paths || paths.has(path);

  if (canUpdate("title") && spaceInput.title !== undefined) {
    const title = typeof spaceInput.title === "string" ? spaceInput.title.trim() : "";
    if (!title) {
      return c.json({ code: 3, message: "space title is required", details: [] }, 400);
    }
    updateData.title = title;
  }
  if (canUpdate("description") && spaceInput.description !== undefined) {
    updateData.description = String(spaceInput.description).trim();
  }
  if (canUpdate("icon") && spaceInput.icon !== undefined) {
    updateData.payload = buildPayloadWithIcon(space.payload, spaceInput.icon);
  }

  const updated = await spaceDB.updateSpace(c.env.DB, space.id, updateData);
  if (!updated) {
    return c.json({ code: 5, message: "space not found", details: [] }, 404);
  }
  const members = await spaceDB.listSpaceMembers(c.env.DB, space.id);
  return c.json(formatSpace({ ...updated, current_user_role: membership.role, member_count: members.length }));
});

// Delete a space and every memo currently placed in it. Administrator only.
spaceRoutes.delete("/:spaceUid", authRequired, async (c) => {
  const { space, membership } = await findSpaceAndMembership(c, c.req.param("spaceUid"));
  if (!space || !membership) {
    return c.json({ code: 5, message: "space not found", details: [] }, 404);
  }
  if (membership.role !== "ADMIN") {
    return c.json({ code: 7, message: "space administrator permission required", details: [] }, 403);
  }

  const attachments = await spaceDB.deleteMemosInSpace(c.env.DB, space.id);
  await spaceDB.deleteSpace(c.env.DB, space.id);
  await c.env.DB.prepare("DELETE FROM inbox WHERE json_extract(message, '$.spaceUid') = ?").bind(space.uid).run();
  await deleteStoredObjects(c.env, c.env.DB, attachments as never);
  return c.json({});
});

// List active members.
spaceRoutes.get("/:spaceUid/members", authRequired, async (c) => {
  const { space } = await findSpaceAndMembership(c, c.req.param("spaceUid"));
  if (!space) {
    return c.json({ code: 5, message: "space not found", details: [] }, 404);
  }
  const { limit, offset } = getPageParams(c);
  const members = await spaceDB.listSpaceMembers(c.env.DB, space.id);
  const page = members.slice(offset, offset + limit);
  return c.json({
    spaceMembers: page.map((member) => formatMember(space.uid, member)),
    nextPageToken: nextPageToken(offset, limit, page.length),
  });
});

// Get one active membership.
spaceRoutes.get("/:spaceUid/members/:username", authRequired, async (c) => {
  const { space } = await findSpaceAndMembership(c, c.req.param("spaceUid"));
  if (!space) {
    return c.json({ code: 5, message: "space not found", details: [] }, 404);
  }
  const target = await userDB.findUserByUsername(c.env.DB, parseUsername(c.req.param("username")));
  if (!target) {
    return c.json({ code: 5, message: "space or membership not found", details: [] }, 404);
  }
  const member = await spaceDB.getSpaceMember(c.env.DB, space.id, target.id);
  if (!member || member.status !== "ACTIVE") {
    return c.json({ code: 5, message: "space or membership not found", details: [] }, 404);
  }
  return c.json(formatMember(space.uid, member));
});

// Change a member's role. Administrator only; a space must keep one administrator.
spaceRoutes.patch("/:spaceUid/members/:username", authRequired, async (c) => {
  const { space, membership } = await findSpaceAndMembership(c, c.req.param("spaceUid"));
  if (!space || !membership) {
    return c.json({ code: 5, message: "space not found", details: [] }, 404);
  }
  if (membership.role !== "ADMIN") {
    return c.json({ code: 7, message: "space administrator permission required", details: [] }, 403);
  }

  const body = await c.req.json<Record<string, unknown>>();
  const memberInput = (body.spaceMember ?? body) as Record<string, unknown>;
  const role = parseRole(memberInput.role);
  if (!role) {
    return c.json({ code: 3, message: "space member role must be ADMIN or USER", details: [] }, 400);
  }

  const target = await userDB.findUserByUsername(c.env.DB, parseUsername(c.req.param("username")));
  const member = target ? await spaceDB.getSpaceMember(c.env.DB, space.id, target.id) : null;
  if (!target || !member || member.status !== "ACTIVE") {
    return c.json({ code: 5, message: "space or membership not found", details: [] }, 404);
  }
  if (member.role === "ADMIN" && role !== "ADMIN" && (await spaceDB.countActiveAdmins(c.env.DB, space.id)) <= 1) {
    return c.json({ code: 9, message: "a space must retain an active administrator", details: [] }, 400);
  }

  await spaceDB.updateSpaceMemberRole(c.env.DB, space.id, target.id, role);
  return c.json(formatMember(space.uid, { ...member, role }));
});

// Remove a member. Administrators may remove anyone; members may leave.
spaceRoutes.delete("/:spaceUid/members/:username", authRequired, async (c) => {
  const user = c.get("user");
  const { space, membership } = await findSpaceAndMembership(c, c.req.param("spaceUid"));
  if (!space || !membership) {
    return c.json({ code: 5, message: "space not found", details: [] }, 404);
  }

  const target = await userDB.findUserByUsername(c.env.DB, parseUsername(c.req.param("username")));
  if (!target) {
    return c.json({ code: 5, message: "space or membership not found", details: [] }, 404);
  }
  if (membership.role !== "ADMIN" && target.id !== user.id) {
    return c.json({ code: 7, message: "space administrator permission required", details: [] }, 403);
  }

  const member = await spaceDB.getSpaceMember(c.env.DB, space.id, target.id);
  if (!member || member.status !== "ACTIVE") {
    return c.json({ code: 5, message: "space or membership not found", details: [] }, 404);
  }
  if (member.role === "ADMIN" && (await spaceDB.countActiveAdmins(c.env.DB, space.id)) <= 1) {
    return c.json({ code: 9, message: "a space must retain an active administrator", details: [] }, 400);
  }

  await spaceDB.deleteSpaceMember(c.env.DB, space.id, target.id);
  return c.json({});
});

// List pending invitations. Administrator only.
spaceRoutes.get("/:spaceUid/invitations", authRequired, async (c) => {
  const { space, membership } = await findSpaceAndMembership(c, c.req.param("spaceUid"));
  if (!space || !membership) {
    return c.json({ code: 5, message: "space not found", details: [] }, 404);
  }
  if (membership.role !== "ADMIN") {
    return c.json({ code: 7, message: "space administrator permission required", details: [] }, 403);
  }
  const { limit, offset } = getPageParams(c);
  const invitations = await spaceDB.listSpaceInvitations(c.env.DB, space.id);
  const page = invitations.slice(offset, offset + limit);
  return c.json({
    spaceInvitations: page.map((invitation) => formatInvitation(space, invitation)),
    nextPageToken: nextPageToken(offset, limit, page.length),
  });
});

// Invite an active user. Administrator only.
spaceRoutes.post("/:spaceUid/invitations", authRequired, async (c) => {
  const user = c.get("user");
  const { space, membership } = await findSpaceAndMembership(c, c.req.param("spaceUid"));
  if (!space || !membership) {
    return c.json({ code: 5, message: "space not found", details: [] }, 404);
  }
  if (membership.role !== "ADMIN") {
    return c.json({ code: 7, message: "space administrator permission required", details: [] }, 403);
  }

  const body = await c.req.json<Record<string, unknown>>();
  const invitationInput = (body.spaceInvitation ?? body) as Record<string, unknown>;
  const inviteeName =
    typeof invitationInput.invitee === "string"
      ? invitationInput.invitee
      : typeof invitationInput.username === "string"
        ? invitationInput.username
        : "";
  const target = await userDB.findUserByUsername(c.env.DB, parseUsername(inviteeName));
  if (!target) {
    return c.json({ code: 5, message: "user not found", details: [] }, 404);
  }
  if (target.row_status !== "NORMAL") {
    return c.json({ code: 9, message: "only active users can be invited to a space", details: [] }, 400);
  }
  const role = parseRole(invitationInput.role) || "USER";

  const existing = await spaceDB.getSpaceMember(c.env.DB, space.id, target.id);
  if (existing) {
    return c.json({ code: 6, message: "space membership or invitation already exists", details: [] }, 409);
  }

  const invitation = await spaceDB.createSpaceInvitation(c.env.DB, space.id, target.id, role);
  await c.env.DB.prepare("INSERT INTO inbox (sender_id, receiver_id, status, message) VALUES (?, ?, 'UNREAD', ?)")
    .bind(
      user.id,
      target.id,
      JSON.stringify({
        type: "SPACE_INVITATION",
        spaceUid: space.uid,
        spaceTitle: space.title,
        spaceDescription: space.description,
        spacePayload: space.payload,
        role: roleToNumber(role),
      }),
    )
    .run();

  return c.json(formatInvitation(space, invitation));
});

// Revoke a pending invitation. Administrator only.
spaceRoutes.delete("/:spaceUid/invitations/:username", authRequired, async (c) => {
  const { space, membership } = await findSpaceAndMembership(c, c.req.param("spaceUid"));
  if (!space || !membership) {
    return c.json({ code: 5, message: "space not found", details: [] }, 404);
  }
  if (membership.role !== "ADMIN") {
    return c.json({ code: 7, message: "space administrator permission required", details: [] }, 403);
  }
  const target = await userDB.findUserByUsername(c.env.DB, parseUsername(c.req.param("username")));
  if (!target) {
    return c.json({ code: 5, message: "space invitation not found", details: [] }, 404);
  }
  const invitation = await spaceDB.getSpaceInvitation(c.env.DB, space.id, target.id);
  if (!invitation) {
    return c.json({ code: 5, message: "space invitation not found", details: [] }, 404);
  }

  await spaceDB.deleteSpaceInvitation(c.env.DB, space.id, target.id);
  await resolveInvitationNotification(c, target.id, space.uid, "delete");
  return c.json({});
});

async function resolveInvitationAction(c: SpaceContext, action: "accept" | "decline") {
  const user = c.get("user");
  const space = await getSpaceRowByUid(c, parseSpaceUid(c.req.param("spaceUid")));
  const target = await userDB.findUserByUsername(c.env.DB, parseUsername(c.req.param("username")));
  if (!space || !target || target.id !== user.id) {
    return c.json({ code: 5, message: "space invitation not found", details: [] }, 404);
  }
  const invitation = await spaceDB.getSpaceInvitation(c.env.DB, space.id, user.id);
  if (!invitation) {
    return c.json({ code: 5, message: "space invitation not found", details: [] }, 404);
  }

  if (action === "accept") {
    const member = await spaceDB.acceptSpaceInvitation(c.env.DB, space.id, user.id);
    if (!member) {
      return c.json({ code: 5, message: "space invitation not found", details: [] }, 404);
    }
    await resolveInvitationNotification(c, user.id, space.uid, "archive");
    return c.json(formatMember(space.uid, member));
  }

  await spaceDB.deleteSpaceInvitation(c.env.DB, space.id, user.id);
  await resolveInvitationNotification(c, user.id, space.uid, "delete");
  return c.json({});
}

spaceRoutes.post("/:spaceUid/invitations/:username/accept", authRequired, (c) => resolveInvitationAction(c, "accept"));
spaceRoutes.post("/:spaceUid/invitations/:username/decline", authRequired, (c) => resolveInvitationAction(c, "decline"));
