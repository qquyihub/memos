import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { v4 as uuidv4 } from "uuid";
import SpaceIcon, { SPACE_ICON_PRESETS } from "@/components/SpaceIcon";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import useCurrentUser from "@/hooks/useCurrentUser";
import { useCreateSpace } from "@/hooks/useSpaceQueries";
import { cn } from "@/lib/utils";
import type { Space, SpaceIcon as SpaceIconValue } from "@/types/space";
import { useTranslate } from "@/utils/i18n";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (space: Space) => void;
}

const CreateSpaceDialog = ({ open, onOpenChange, onCreated }: Props) => {
  const t = useTranslate();
  const currentUser = useCurrentUser();
  const createSpace = useCreateSpace(currentUser?.name);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [icon, setIcon] = useState<SpaceIconValue | undefined>();

  useEffect(() => {
    if (!open) {
      setTitle("");
      setDescription("");
      setIcon(undefined);
    }
  }, [open]);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedTitle = title.trim();
    if (!trimmedTitle || createSpace.isPending) return;

    try {
      const space = await createSpace.mutateAsync({
        title: trimmedTitle,
        description: description.trim(),
        spaceId: uuidv4(),
        ...(icon ? { icon } : {}),
      });
      toast.success(t("space.create-success"));
      onOpenChange(false);
      onCreated?.(space);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("space.create-failure"));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => (createSpace.isPending ? undefined : onOpenChange(nextOpen))}>
      <DialogContent size="sm">
        <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{t("space.create")}</DialogTitle>
            <DialogDescription>{t("space.create-description")}</DialogDescription>
          </DialogHeader>

          <div className="grid gap-2">
            <Label htmlFor="space-title">{t("common.name")}</Label>
            <div className="flex items-center gap-2">
              <SpaceIcon icon={icon} className="size-8 text-base" />
              <Input
                id="space-title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder={t("space.name-placeholder")}
                autoComplete="off"
                autoFocus
              />
            </div>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="space-description">{t("common.description")}</Label>
            <Textarea
              id="space-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder={t("space.description-placeholder")}
              className="min-h-20 resize-none"
            />
          </div>

          <div className="grid gap-2">
            <Label>{t("space.icon")}</Label>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={cn(
                  "flex size-8 items-center justify-center rounded-lg border text-sm transition-colors",
                  !icon ? "border-primary bg-primary/10" : "border-border hover:bg-accent",
                )}
                onClick={() => setIcon(undefined)}
                aria-label={t("space.default-icon")}
              >
                <span className="text-muted-foreground">∅</span>
              </button>
              {SPACE_ICON_PRESETS.map((preset) => (
                <button
                  type="button"
                  key={preset.emoji}
                  className={cn(
                    "flex size-8 items-center justify-center rounded-lg border text-base transition-colors",
                    icon?.emoji === preset.emoji ? "border-primary bg-primary/10" : "border-border hover:bg-accent",
                  )}
                  onClick={() => setIcon({ emoji: preset.emoji })}
                  aria-label={preset.label}
                >
                  {preset.emoji}
                </button>
              ))}
            </div>
          </div>

          <p className="text-xs text-muted-foreground">{t("space.creator-admin-note")}</p>

          <DialogFooter>
            <Button type="button" variant="ghost" disabled={createSpace.isPending} onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={!title.trim() || createSpace.isPending}>
              {t("common.create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

export default CreateSpaceDialog;
