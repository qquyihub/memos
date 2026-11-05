import { ChevronRightIcon, PlusIcon, UsersIcon } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import CreateSpaceDialog from "@/components/CreateSpaceDialog";
import Empty from "@/components/Empty";
import MobileHeader from "@/components/MobileHeader";
import SpaceIcon from "@/components/SpaceIcon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import useCurrentUser from "@/hooks/useCurrentUser";
import useMediaQuery from "@/hooks/useMediaQuery";
import { useSpaces } from "@/hooks/useSpaceQueries";
import { useTranslate } from "@/utils/i18n";

const Spaces = () => {
  const t = useTranslate();
  const md = useMediaQuery("md");
  const navigate = useNavigate();
  const currentUser = useCurrentUser();
  const { data: spaces = [], isLoading } = useSpaces(currentUser?.name);
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <section className="@container w-full max-w-5xl min-h-full flex flex-col justify-start items-center sm:pt-3 md:pt-6 pb-8">
      {!md && <MobileHeader />}
      <div className="w-full px-4 sm:px-6">
        <div className="mb-4 flex flex-row items-center justify-between gap-3">
          <div className="flex flex-row items-center gap-2">
            <UsersIcon className="w-5 h-auto text-muted-foreground" />
            <h1 className="text-xl font-semibold">{t("space.spaces")}</h1>
          </div>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <PlusIcon />
            {t("space.create")}
          </Button>
        </div>

        {isLoading ? (
          <div className="text-sm text-muted-foreground">{t("common.loading")}</div>
        ) : spaces.length === 0 ? (
          <div className="flex flex-col items-center py-16">
            <Empty />
            <p className="mt-4 text-sm text-muted-foreground">{t("space.empty")}</p>
            <Button className="mt-4" size="sm" onClick={() => setCreateOpen(true)}>
              <PlusIcon />
              {t("space.create")}
            </Button>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {spaces.map((space) => {
              const uid = space.name.split("/").pop() || "";
              return (
                <Link
                  key={space.name}
                  to={`/spaces/${uid}`}
                  className="group flex items-start gap-3 rounded-xl border border-border bg-card p-4 transition-colors hover:bg-accent/40"
                >
                  <SpaceIcon icon={space.icon} className="size-10 text-xl" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-semibold">{space.title}</span>
                      {space.currentUserRole === 1 && (
                        <Badge variant="secondary" className="text-[10px]">
                          {t("space.role.admin")}
                        </Badge>
                      )}
                    </div>
                    {space.description && <p className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">{space.description}</p>}
                    <p className="mt-1 text-xs text-muted-foreground">{t("space.member-count", { count: space.memberCount ?? 0 })}</p>
                  </div>
                  <ChevronRightIcon className="mt-1 size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                </Link>
              );
            })}
          </div>
        )}
      </div>

      <CreateSpaceDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(space) => navigate(`/spaces/${space.name.split("/").pop()}`)}
      />
    </section>
  );
};

export default Spaces;
