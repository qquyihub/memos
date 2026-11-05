import type { LucideIcon } from "lucide-react";
import { BookIcon, BriefcaseIcon, FolderIcon, GlobeIcon, HeartIcon, LeafIcon, LightbulbIcon, StarIcon, UsersIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SpaceIcon as SpaceIconValue } from "@/types/space";

const LUCIDE_ICON_MAP: Record<string, LucideIcon> = {
  book: BookIcon,
  briefcase: BriefcaseIcon,
  folder: FolderIcon,
  globe: GlobeIcon,
  heart: HeartIcon,
  leaf: LeafIcon,
  lightbulb: LightbulbIcon,
  star: StarIcon,
  users: UsersIcon,
};

export const SPACE_ICON_PRESETS: Array<{ emoji: string; label: string }> = [
  { emoji: "📁", label: "Folder" },
  { emoji: "🌱", label: "Leaf" },
  { emoji: "⭐", label: "Star" },
  { emoji: "💡", label: "Idea" },
  { emoji: "📚", label: "Book" },
  { emoji: "💼", label: "Work" },
  { emoji: "🌍", label: "World" },
  { emoji: "❤️", label: "Heart" },
];

interface Props {
  icon?: SpaceIconValue;
  className?: string;
}

const SpaceIcon = ({ icon, className }: Props) => {
  const wrapperClass = cn("flex items-center justify-center rounded-lg bg-primary/10 text-primary shrink-0", className);

  if (icon?.emoji) {
    return (
      <div className={wrapperClass} aria-hidden>
        <span className="leading-none">{icon.emoji}</span>
      </div>
    );
  }

  const Icon = icon?.lucide ? (LUCIDE_ICON_MAP[icon.lucide] ?? UsersIcon) : UsersIcon;
  return (
    <div className={wrapperClass} aria-hidden>
      <Icon className="w-[55%] h-[55%]" />
    </div>
  );
};

export default SpaceIcon;
