import { CheckIcon, ChevronDownIcon, UsersIcon } from "lucide-react";
import SpaceIcon from "@/components/SpaceIcon";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import useCurrentUser from "@/hooks/useCurrentUser";
import { useSpaces } from "@/hooks/useSpaceQueries";
import { useTranslate } from "@/utils/i18n";

interface Props {
  value?: string;
  onChange: (space?: string) => void;
}

const SpaceSelector = ({ value, onChange }: Props) => {
  const t = useTranslate();
  const currentUser = useCurrentUser();
  const { data: spaces = [] } = useSpaces(currentUser?.name);
  const currentSpace = spaces.find((space) => space.name === value);

  if (spaces.length === 0) {
    return null;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center px-2 text-sm text-muted-foreground opacity-80 transition-colors hover:opacity-100"
        >
          {currentSpace ? (
            <SpaceIcon icon={currentSpace.icon} className="mr-1.5 size-4 text-[10px]" />
          ) : (
            <UsersIcon className="mr-1.5 size-4 opacity-60" />
          )}
          <span className="max-w-28 truncate">{currentSpace?.title || t("space.no-space")}</span>
          <ChevronDownIcon className="ml-0.5 size-4 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem className="cursor-pointer gap-2" onClick={() => onChange(undefined)}>
          <UsersIcon className="size-4 text-muted-foreground" />
          <span className="flex-1">{t("space.no-space")}</span>
          {!value && <CheckIcon className="size-4 text-primary" />}
        </DropdownMenuItem>
        {spaces.map((space) => (
          <DropdownMenuItem key={space.name} className="cursor-pointer gap-2" onClick={() => onChange(space.name)}>
            <SpaceIcon icon={space.icon} className="size-4 text-[10px]" />
            <span className="max-w-48 flex-1 truncate">{space.title}</span>
            {value === space.name && <CheckIcon className="size-4 text-primary" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export default SpaceSelector;
