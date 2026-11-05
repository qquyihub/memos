import { timestampDate } from "@bufbuild/protobuf/wkt";
import { CheckIcon, TrashIcon, UsersIcon, XIcon } from "lucide-react";
import { useState } from "react";
import toast from "react-hot-toast";
import { Link } from "react-router-dom";
import SpaceIcon from "@/components/SpaceIcon";
import UserAvatar from "@/components/UserAvatar";
import { Button } from "@/components/ui/button";
import { userServiceClient } from "@/connect";
import useCurrentUser from "@/hooks/useCurrentUser";
import { useAcceptSpaceInvitation, useDeclineSpaceInvitation } from "@/hooks/useSpaceQueries";
import { cn } from "@/lib/utils";
import { UserNotification, UserNotification_Status } from "@/types/proto/api/v1/user_service_pb";
import { useTranslate } from "@/utils/i18n";

interface Props {
  notification: UserNotification;
}

interface SpaceInvitationPayload {
  spaceInvitation: string;
  space: {
    name: string;
    title: string;
    description?: string;
    icon?: { emoji?: string; lucide?: string };
  };
  role: number;
  state: number;
}

const SpaceInvitationMessage = ({ notification }: Props) => {
  const t = useTranslate();
  const currentUser = useCurrentUser();
  const acceptInvitation = useAcceptSpaceInvitation(currentUser?.name);
  const declineInvitation = useDeclineSpaceInvitation(currentUser?.name);
  const [loading, setLoading] = useState<"accept" | "decline" | undefined>();

  const notificationPayload = (
    notification as unknown as {
      payload?: { case?: string; value?: SpaceInvitationPayload };
    }
  ).payload;
  const payload = notificationPayload?.case === "spaceInvitation" ? notificationPayload.value : undefined;
  const sender = notification.senderUser;
  const isUnread = notification.status === UserNotification_Status.UNREAD;

  if (!payload?.space) {
    return null;
  }

  const isAccepted = payload.state === 2;
  const spaceUid = (payload.space.name || "").split("/").pop() || "";

  const handleAccept = async () => {
    setLoading("accept");
    try {
      await acceptInvitation.mutateAsync(payload.spaceInvitation);
      toast.success(t("space.invitation-accepted"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("space.invitation-failure"));
    } finally {
      setLoading(undefined);
    }
  };

  const handleDecline = async () => {
    setLoading("decline");
    try {
      await declineInvitation.mutateAsync(payload.spaceInvitation);
      await userServiceClient.deleteUserNotification({ name: notification.name });
      toast.success(t("space.invitation-declined"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("space.invitation-failure"));
    } finally {
      setLoading(undefined);
    }
  };

  const handleDelete = async () => {
    await userServiceClient.deleteUserNotification({ name: notification.name });
  };

  return (
    <div
      className={cn(
        "group relative w-full border-b border-border/60 px-5 py-4 transition-all duration-200 last:border-b-0",
        isUnread ? "bg-primary/[0.03] hover:bg-primary/[0.05]" : "hover:bg-muted/30",
      )}
    >
      {isUnread && <div className="absolute top-0 bottom-0 left-0 w-0.5 bg-gradient-to-b from-primary to-primary/60" />}
      <div className="flex items-start gap-3">
        <div className="relative shrink-0">
          <UserAvatar className="h-10 w-10 ring-1 ring-border/40" avatarUrl={sender?.avatarUrl} />
          <div className="absolute -right-1 -bottom-1 flex size-5 items-center justify-center rounded-full border-2 border-background bg-primary text-primary-foreground shadow-md">
            <UsersIcon className="size-2.5" strokeWidth={2.5} />
          </div>
        </div>

        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <span className="text-sm font-semibold text-foreground/95">{sender?.displayName || sender?.username}</span>
              <span className="text-sm text-muted-foreground/80">{t("space.invited-you")}</span>
              <span className="text-xs text-muted-foreground/60">
                {notification.createTime && timestampDate(notification.createTime)?.toLocaleDateString()}
              </span>
            </div>
            <button
              type="button"
              onClick={handleDelete}
              className="rounded-lg p-1.5 opacity-0 transition-all hover:bg-destructive/10 group-hover:opacity-100"
              title={t("common.delete")}
            >
              <TrashIcon className="size-4 text-muted-foreground hover:text-destructive" />
            </button>
          </div>

          <div className="mt-2 flex items-center gap-3 rounded-lg border border-border bg-background/70 p-3">
            <SpaceIcon icon={payload.space.icon} className="size-10 text-lg" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold">{payload.space.title}</div>
              {payload.space.description && (
                <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{payload.space.description}</p>
              )}
            </div>
            {isAccepted ? (
              <Button size="sm" variant="outline" asChild>
                <Link to={`/spaces/${spaceUid}`}>{t("space.open")}</Link>
              </Button>
            ) : (
              <div className="flex shrink-0 items-center gap-1">
                <Button size="sm" variant="ghost" disabled={loading !== undefined} onClick={handleDecline}>
                  <XIcon />
                  {t("space.decline")}
                </Button>
                <Button size="sm" disabled={loading !== undefined} onClick={handleAccept}>
                  <CheckIcon />
                  {t("space.accept")}
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default SpaceInvitationMessage;
