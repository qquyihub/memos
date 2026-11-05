import { ArrowLeftIcon, PencilIcon, Trash2Icon, UserPlusIcon, UsersIcon } from "lucide-react";
import { useState } from "react";
import toast from "react-hot-toast";
import { Link, useNavigate, useParams } from "react-router-dom";
import ConfirmDialog from "@/components/ConfirmDialog";
import Empty from "@/components/Empty";
import MemoView from "@/components/MemoView/MemoView";
import MobileHeader from "@/components/MobileHeader";
import PagedMemoList from "@/components/PagedMemoList";
import SpaceIcon, { SPACE_ICON_PRESETS } from "@/components/SpaceIcon";
import UserAvatar from "@/components/UserAvatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import useCurrentUser from "@/hooks/useCurrentUser";
import useMediaQuery from "@/hooks/useMediaQuery";
import {
  useCreateSpaceInvitation,
  useDeleteSpace,
  useDeleteSpaceInvitation,
  useDeleteSpaceMember,
  useSpace,
  useSpaceInvitations,
  useSpaceMembers,
  useUpdateSpace,
  useUpdateSpaceMember,
} from "@/hooks/useSpaceQueries";
import { useUser } from "@/hooks/useUserQueries";
import type { SpaceIcon as SpaceIconValue, SpaceInvitation, SpaceMember } from "@/types/space";
import { useTranslate } from "@/utils/i18n";

type TabKey = "memos" | "members" | "invitations";

const SpaceDetail = () => {
  const t = useTranslate();
  const md = useMediaQuery("md");
  const navigate = useNavigate();
  const currentUser = useCurrentUser();
  const params = useParams<{ spaceUid: string }>();
  const spaceUid = params.spaceUid || "";
  const spaceName = `spaces/${spaceUid}`;
  const { data: space, isLoading } = useSpace(currentUser?.name, spaceName);
  const { data: members = [] } = useSpaceMembers(spaceName, { enabled: Boolean(space) });
  const { data: invitations = [] } = useSpaceInvitations(spaceName, { enabled: Boolean(space?.currentUserRole === 1) });
  const updateSpace = useUpdateSpace(spaceName);
  const deleteSpace = useDeleteSpace(spaceName);
  const updateMember = useUpdateSpaceMember(spaceName);
  const deleteMember = useDeleteSpaceMember(spaceName);
  const revokeInvitation = useDeleteSpaceInvitation(spaceName, currentUser?.name);
  const createInvitation = useCreateSpaceInvitation(spaceName);

  const [tab, setTab] = useState<TabKey>("memos");
  const [editOpen, setEditOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [icon, setIcon] = useState<SpaceIconValue | undefined>();
  const [invitee, setInvitee] = useState("");
  const [inviteRole, setInviteRole] = useState("2");
  const [removeTarget, setRemoveTarget] = useState<SpaceMember | undefined>();

  const isAdmin = space?.currentUserRole === 1;

  const openEdit = () => {
    if (!space) return;
    setTitle(space.title);
    setDescription(space.description);
    setIcon(space.icon);
    setEditOpen(true);
  };

  const handleSaveSpace = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!title.trim() || updateSpace.isPending) return;
    try {
      await updateSpace.mutateAsync({
        space: { title: title.trim(), description: description.trim(), icon: icon ?? {} },
        updateMask: ["title", "description", "icon"],
      });
      setEditOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("space.update-failure"));
    }
  };

  const handleInvite = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!invitee.trim() || createInvitation.isPending) return;
    try {
      await createInvitation.mutateAsync({
        invitee: invitee.trim().startsWith("users/") ? invitee.trim() : `users/${invitee.trim()}`,
        role: Number(inviteRole),
      });
      setInviteOpen(false);
      setInvitee("");
      toast.success(t("space.invitation-sent"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("space.invitation-failure"));
    }
  };

  const handleDeleteSpace = async () => {
    try {
      await deleteSpace.mutateAsync();
      navigate("/spaces");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("space.delete-failure"));
    }
  };

  const handleRoleChange = async (member: SpaceMember, role: string) => {
    try {
      await updateMember.mutateAsync({ member, role: Number(role) });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("space.update-failure"));
    }
  };

  const handleRemoveMember = async () => {
    if (!removeTarget) return;
    try {
      await deleteMember.mutateAsync(removeTarget.name);
      setRemoveTarget(undefined);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("space.remove-failure"));
    }
  };

  if (isLoading) {
    return <div className="p-6 text-sm text-muted-foreground">{t("common.loading")}</div>;
  }
  if (!space) {
    return (
      <div className="flex w-full flex-col items-center py-20">
        <Empty />
        <p className="mt-3 text-sm text-muted-foreground">{t("space.not-found")}</p>
        <Link className="mt-3 text-sm text-primary hover:underline" to="/spaces">
          {t("space.back")}
        </Link>
      </div>
    );
  }

  return (
    <section className="@container w-full max-w-3xl min-h-full flex flex-col justify-start items-center sm:pt-3 md:pt-6 pb-8">
      {!md && <MobileHeader />}
      <div className="w-full px-4 sm:px-6">
        <div className="mb-4 flex flex-row items-center justify-between gap-3">
          <Link className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground" to="/spaces">
            <ArrowLeftIcon className="size-4" />
            {t("space.back")}
          </Link>
          {isAdmin && (
            <div className="flex items-center gap-1">
              <Button size="sm" variant="ghost" onClick={openEdit}>
                <PencilIcon />
                {t("common.edit")}
              </Button>
              <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setDeleteOpen(true)}>
                <Trash2Icon />
                {t("common.delete")}
              </Button>
            </div>
          )}
        </div>

        <div className="mb-5 flex items-start gap-3 rounded-xl border border-border bg-card p-4">
          <SpaceIcon icon={space.icon} className="size-12 text-2xl" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold">{space.title}</h1>
              {isAdmin && <Badge variant="secondary">{t("space.role.admin")}</Badge>}
            </div>
            {space.description && <p className="mt-1 text-sm text-muted-foreground">{space.description}</p>}
            <p className="mt-1 text-xs text-muted-foreground">{t("space.member-count", { count: space.memberCount ?? members.length })}</p>
          </div>
        </div>

        <div className="mb-3 flex flex-row gap-1 border-b border-border pb-2">
          {(
            [
              ["memos", t("space.tab.memos")],
              ["members", t("space.tab.members")],
              ...(isAdmin ? [["invitations", t("space.tab.invitations")] as const] : []),
            ] as Array<readonly [TabKey, string]>
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={
                tab === key
                  ? "rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-foreground"
                  : "rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent/50 hover:text-foreground"
              }
              onClick={() => setTab(key)}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === "memos" && (
          <PagedMemoList
            renderer={(memo) => (
              <MemoView key={`${memo.name}-${memo.updateTime}`} memo={memo} showVisibility showPinned compact showSpace />
            )}
            orderBy="create_time desc"
            filter={`space == ${JSON.stringify(spaceName)}`}
            showMemoEditor
            defaultSpace={spaceName}
          />
        )}

        {tab === "members" && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                <UsersIcon className="size-4" />
                {t("space.tab.members")}
              </div>
              {isAdmin && (
                <Button size="sm" variant="outline" onClick={() => setInviteOpen(true)}>
                  <UserPlusIcon />
                  {t("space.invite")}
                </Button>
              )}
            </div>
            {members.map((member) => (
              <MemberRow
                key={member.name}
                member={member}
                isAdmin={isAdmin}
                currentUser={currentUser?.name}
                onRoleChange={(role) => handleRoleChange(member, role)}
                onRemove={() => setRemoveTarget(member)}
              />
            ))}
          </div>
        )}

        {tab === "invitations" && isAdmin && (
          <div className="flex flex-col gap-2">
            {invitations.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">{t("space.no-invitations")}</p>
            ) : (
              invitations.map((invitation) => (
                <InvitationRow
                  key={invitation.name}
                  invitation={invitation}
                  onRevoke={async () => {
                    try {
                      await revokeInvitation.mutateAsync(invitation.name);
                    } catch (error) {
                      toast.error(error instanceof Error ? error.message : t("space.revoke-failure"));
                    }
                  }}
                />
              ))
            )}
          </div>
        )}
      </div>

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent size="sm">
          <form className="flex flex-col gap-4" onSubmit={handleSaveSpace}>
            <DialogHeader>
              <DialogTitle>{t("space.edit")}</DialogTitle>
            </DialogHeader>
            <div className="grid gap-2">
              <Label htmlFor="space-edit-title">{t("common.name")}</Label>
              <Input id="space-edit-title" value={title} onChange={(event) => setTitle(event.target.value)} autoFocus />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="space-edit-description">{t("common.description")}</Label>
              <Textarea id="space-edit-description" value={description} onChange={(event) => setDescription(event.target.value)} />
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="flex size-8 items-center justify-center rounded-lg border border-border text-xs text-muted-foreground"
                onClick={() => setIcon(undefined)}
              >
                ∅
              </button>
              {SPACE_ICON_PRESETS.map((preset) => (
                <button
                  type="button"
                  key={preset.emoji}
                  className={
                    icon?.emoji === preset.emoji
                      ? "flex size-8 items-center justify-center rounded-lg border border-primary bg-primary/10"
                      : "flex size-8 items-center justify-center rounded-lg border border-border hover:bg-accent"
                  }
                  onClick={() => setIcon({ emoji: preset.emoji })}
                >
                  {preset.emoji}
                </button>
              ))}
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setEditOpen(false)}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" disabled={!title.trim() || updateSpace.isPending}>
                {t("common.save")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
        <DialogContent size="sm">
          <form className="flex flex-col gap-4" onSubmit={handleInvite}>
            <DialogHeader>
              <DialogTitle>{t("space.invite")}</DialogTitle>
              <DialogDescription>{t("space.invite-description")}</DialogDescription>
            </DialogHeader>
            <div className="grid gap-2">
              <Label htmlFor="space-invite-user">{t("space.invitee")}</Label>
              <Input
                id="space-invite-user"
                value={invitee}
                onChange={(event) => setInvitee(event.target.value)}
                placeholder="username"
                autoComplete="off"
                autoFocus
              />
            </div>
            <div className="grid gap-2">
              <Label>{t("space.role")}</Label>
              <Select value={inviteRole} onValueChange={setInviteRole}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="2">{t("space.role.member")}</SelectItem>
                  <SelectItem value="1">{t("space.role.admin")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setInviteOpen(false)}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" disabled={!invitee.trim() || createInvitation.isPending}>
                {t("space.send-invitation")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={Boolean(removeTarget)}
        onOpenChange={(open) => !open && setRemoveTarget(undefined)}
        title={t("space.remove-member-title")}
        description={t("space.remove-member-description")}
        confirmLabel={t("common.remove")}
        cancelLabel={t("common.cancel")}
        confirmVariant="destructive"
        onConfirm={handleRemoveMember}
      />

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={t("space.delete-title")}
        description={t("space.delete-description")}
        confirmLabel={t("common.delete")}
        cancelLabel={t("common.cancel")}
        confirmVariant="destructive"
        onConfirm={handleDeleteSpace}
      />
    </section>
  );
};

function MemberRow({
  member,
  isAdmin,
  currentUser,
  onRoleChange,
  onRemove,
}: {
  member: SpaceMember;
  isAdmin: boolean;
  currentUser?: string;
  onRoleChange: (role: string) => void;
  onRemove: () => void;
}) {
  const t = useTranslate();
  const username = member.user.split("/").pop() || "";
  const { data: user } = useUser(member.user);

  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2">
      <UserAvatar avatarUrl={user?.avatarUrl} className="size-8 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{user?.displayName || username}</div>
        <div className="truncate text-xs text-muted-foreground">@{username}</div>
      </div>
      {isAdmin && currentUser !== member.user ? (
        <Select value={String(member.role)} onValueChange={onRoleChange}>
          <SelectTrigger size="sm" className="w-28">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="2">{t("space.role.member")}</SelectItem>
            <SelectItem value="1">{t("space.role.admin")}</SelectItem>
          </SelectContent>
        </Select>
      ) : (
        <Badge variant="secondary">{member.role === 1 ? t("space.role.admin") : t("space.role.member")}</Badge>
      )}
      {isAdmin && currentUser !== member.user && (
        <Button size="icon" variant="ghost" className="text-destructive" onClick={onRemove} aria-label={t("common.remove")}>
          <Trash2Icon />
        </Button>
      )}
    </div>
  );
}

function InvitationRow({ invitation, onRevoke }: { invitation: SpaceInvitation; onRevoke: () => Promise<void> }) {
  const t = useTranslate();
  const username = invitation.invitee.split("/").pop() || "";
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">@{username}</div>
        <div className="truncate text-xs text-muted-foreground">
          {invitation.role === 1 ? t("space.role.admin") : t("space.role.member")} · {t("space.pending")}
        </div>
      </div>
      <Button size="sm" variant="ghost" className="text-destructive" onClick={() => void onRevoke()}>
        {t("space.revoke")}
      </Button>
    </div>
  );
}

export default SpaceDetail;
