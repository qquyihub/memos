import { Link } from "react-router-dom";
import SpaceIcon from "@/components/SpaceIcon";
import useCurrentUser from "@/hooks/useCurrentUser";
import { useSpaces } from "@/hooks/useSpaceQueries";

interface Props {
  spaceName?: string;
}

const MemoSpaceBadge = ({ spaceName }: Props) => {
  const currentUser = useCurrentUser();
  const { data: spaces = [] } = useSpaces(currentUser?.name);
  const space = spaces.find((item) => item.name === spaceName);

  if (!spaceName) return null;
  const uid = spaceName.split("/").pop() || "";

  return (
    <Link
      to={`/spaces/${uid}`}
      className="inline-flex max-w-48 items-center gap-1 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      <SpaceIcon icon={space?.icon} className="size-3.5 text-[9px]" />
      <span className="truncate">{space?.title || uid}</span>
    </Link>
  );
};

export default MemoSpaceBadge;
