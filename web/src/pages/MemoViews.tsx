import { ExternalLinkIcon, ListFilterIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import toast from "react-hot-toast";
import { Link } from "react-router-dom";
import ConfirmDialog from "@/components/ConfirmDialog";
import Empty from "@/components/Empty";
import MobileHeader from "@/components/MobileHeader";
import SpaceIcon, { SPACE_ICON_PRESETS } from "@/components/SpaceIcon";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import useCurrentUser from "@/hooks/useCurrentUser";
import useMediaQuery from "@/hooks/useMediaQuery";
import { useCreateMemoView, useDeleteMemoView, useMemoViews, useUpdateMemoView } from "@/hooks/useMemoViewQueries";
import type { MemoView, SpaceIcon as SpaceIconValue } from "@/types/space";
import { useTranslate } from "@/utils/i18n";

const FILTER_EXAMPLES = [
  { label: "Pinned", value: "pinned" },
  { label: "Open tasks", value: "has_task_list && has_incomplete_tasks" },
  { label: "Public", value: 'visibility == "PUBLIC"' },
  { label: "With attachments", value: "has_attachments" },
  { label: "In a space", value: 'space == "spaces/your-space-id"' },
  { label: "Not in a space", value: "space == null" },
];

const MemoViews = () => {
  const t = useTranslate();
  const md = useMediaQuery("md");
  const currentUser = useCurrentUser();
  const { data: views = [], isLoading } = useMemoViews(currentUser?.name);
  const createView = useCreateMemoView(currentUser?.name);
  const updateView = useUpdateMemoView(currentUser?.name);
  const deleteView = useDeleteMemoView(currentUser?.name);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<MemoView | undefined>();
  const [title, setTitle] = useState("");
  const [filter, setFilter] = useState("");
  const [icon, setIcon] = useState<SpaceIconValue | undefined>();
  const [deleteTarget, setDeleteTarget] = useState<MemoView | undefined>();

  const openCreate = () => {
    setEditing(undefined);
    setTitle("");
    setFilter("");
    setIcon(undefined);
    setDialogOpen(true);
  };

  const openEdit = (view: MemoView) => {
    setEditing(view);
    setTitle(view.title);
    setFilter(view.filter);
    setIcon(view.icon);
    setDialogOpen(true);
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!title.trim() || !filter.trim()) return;
    try {
      if (editing) {
        await updateView.mutateAsync({
          view: { ...editing, title: title.trim(), filter: filter.trim(), icon },
          updateMask: ["title", "filter", "icon"],
        });
      } else {
        await createView.mutateAsync({
          title: title.trim(),
          filter: filter.trim(),
          ...(icon ? { icon } : {}),
        });
      }
      setDialogOpen(false);
      toast.success(t("view.save-success"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("view.save-failure"));
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteView.mutateAsync(deleteTarget.name);
      setDeleteTarget(undefined);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("view.delete-failure"));
    }
  };

  return (
    <section className="@container w-full max-w-4xl min-h-full flex flex-col justify-start items-center sm:pt-3 md:pt-6 pb-8">
      {!md && <MobileHeader />}
      <div className="w-full px-4 sm:px-6">
        <div className="mb-4 flex flex-row items-center justify-between gap-3">
          <div className="flex flex-row items-center gap-2">
            <ListFilterIcon className="w-5 h-auto text-muted-foreground" />
            <h1 className="text-xl font-semibold">{t("view.views")}</h1>
          </div>
          <Button size="sm" onClick={openCreate}>
            <PlusIcon />
            {t("view.create")}
          </Button>
        </div>

        {isLoading ? (
          <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
        ) : views.length === 0 ? (
          <div className="flex flex-col items-center py-16">
            <Empty />
            <p className="mt-4 text-sm text-muted-foreground">{t("view.empty")}</p>
            <Button className="mt-4" size="sm" onClick={openCreate}>
              <PlusIcon />
              {t("view.create")}
            </Button>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {views.map((view) => {
              const id = view.name.split("/").pop() || "";
              return (
                <div key={view.name} className="flex flex-col gap-2 rounded-xl border border-border bg-card p-4">
                  <div className="flex items-center gap-2">
                    <SpaceIcon icon={view.icon} className="size-8 text-sm" />
                    <span className="min-w-0 flex-1 truncate font-semibold">{view.title}</span>
                    <Button size="icon" variant="ghost" onClick={() => openEdit(view)} aria-label={t("common.edit")}>
                      <PencilIcon />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="text-destructive"
                      onClick={() => setDeleteTarget(view)}
                      aria-label={t("common.delete")}
                    >
                      <Trash2Icon />
                    </Button>
                  </div>
                  <pre className="overflow-x-auto rounded-md bg-muted/40 px-2 py-1.5 font-mono text-xs text-muted-foreground">
                    {view.filter}
                  </pre>
                  <Link className="inline-flex items-center gap-1 text-sm text-primary hover:underline" to={`/views/${id}`}>
                    {t("view.open")}
                    <ExternalLinkIcon className="size-3.5" />
                  </Link>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent size="lg">
          <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
            <DialogHeader>
              <DialogTitle>{editing ? t("view.edit") : t("view.create")}</DialogTitle>
              <DialogDescription>{t("view.description")}</DialogDescription>
            </DialogHeader>
            <div className="grid gap-2">
              <Label htmlFor="view-title">{t("common.name")}</Label>
              <Input id="view-title" value={title} onChange={(event) => setTitle(event.target.value)} autoFocus />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="view-filter">{t("view.filter")}</Label>
              <Textarea
                id="view-filter"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder='visibility == "PUBLIC" && has_task_list'
                className="min-h-24 font-mono text-xs"
              />
              <div className="flex flex-wrap gap-1.5">
                {FILTER_EXAMPLES.map((example) => (
                  <button
                    type="button"
                    key={example.label}
                    className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                    onClick={() => setFilter(example.value)}
                  >
                    {example.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid gap-2">
              <Label>{t("space.icon")}</Label>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className={
                    !icon
                      ? "flex size-8 items-center justify-center rounded-lg border border-primary bg-primary/10 text-xs text-muted-foreground"
                      : "flex size-8 items-center justify-center rounded-lg border border-border text-xs text-muted-foreground"
                  }
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
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setDialogOpen(false)}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" disabled={!title.trim() || !filter.trim() || createView.isPending || updateView.isPending}>
                {t("common.save")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(undefined)}
        title={t("view.delete-title")}
        description={t("view.delete-description")}
        confirmLabel={t("common.delete")}
        cancelLabel={t("common.cancel")}
        confirmVariant="destructive"
        onConfirm={handleDelete}
      />
    </section>
  );
};

export default MemoViews;
