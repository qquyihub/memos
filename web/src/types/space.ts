export interface SpaceIcon {
  emoji?: string;
  lucide?: string;
}

export interface Space {
  name: string;
  title: string;
  description: string;
  icon?: SpaceIcon;
  currentUserRole?: number;
  memberCount?: number;
}

export interface SpaceMember {
  name: string;
  user: string;
  role: number;
}

export interface SpaceInvitation {
  name: string;
  invitee: string;
  role: number;
  space: Space;
}

export interface MemoView {
  name: string;
  title: string;
  filter: string;
  icon?: SpaceIcon;
}

export enum SpaceMemberRole {
  ROLE_UNSPECIFIED = 0,
  ADMIN = 1,
  USER = 2,
}
