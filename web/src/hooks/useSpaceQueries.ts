import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { spaceServiceClient } from "@/connect";
import { memoKeys } from "@/hooks/useMemoQueries";
import { userKeys } from "@/hooks/useUserQueries";
import type { Space, SpaceInvitation, SpaceMember } from "@/types/space";

const SPACE_LIST_STALE_TIME = 1000 * 60 * 5;

export const spaceKeys = {
  all: ["spaces"] as const,
  lists: () => [...spaceKeys.all, "list"] as const,
  list: (viewerName: string) => [...spaceKeys.lists(), viewerName] as const,
  space: (viewerName: string, spaceName: string) => [...spaceKeys.all, "space", viewerName, spaceName] as const,
  members: (spaceName: string) => [...spaceKeys.all, "members", spaceName] as const,
  invitations: (spaceName: string) => [...spaceKeys.all, "invitations", spaceName] as const,
  userInvitations: (viewerName: string) => [...spaceKeys.all, "user-invitations", viewerName] as const,
};

export function useSpaces(viewerName: string | undefined, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: spaceKeys.list(viewerName ?? ""),
    queryFn: async () => {
      const data = await spaceServiceClient.listSpaces({ pageSize: 1000 });
      return data.spaces as Space[];
    },
    enabled: Boolean(viewerName) && (options?.enabled ?? true),
    staleTime: SPACE_LIST_STALE_TIME,
    refetchOnWindowFocus: false,
  });
}

export function useSpace(viewerName: string | undefined, spaceName: string | undefined, options?: { enabled?: boolean }) {
  const queryClient = useQueryClient();
  const listKey = spaceKeys.list(viewerName ?? "");
  return useQuery({
    queryKey: spaceKeys.space(viewerName ?? "", spaceName ?? ""),
    queryFn: async () => (await spaceServiceClient.getSpace({ name: spaceName! })) as Space,
    enabled: Boolean(viewerName && spaceName) && (options?.enabled ?? true),
    initialData: () => queryClient.getQueryData<Space[]>(listKey)?.find((space) => space.name === spaceName),
    staleTime: SPACE_LIST_STALE_TIME,
  });
}

export function useSpaceMembers(spaceName: string | undefined, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: spaceKeys.members(spaceName ?? ""),
    queryFn: async () => {
      const data = await spaceServiceClient.listSpaceMembers({ parent: spaceName!, pageSize: 1000 });
      return data.spaceMembers as SpaceMember[];
    },
    enabled: Boolean(spaceName) && (options?.enabled ?? true),
    staleTime: SPACE_LIST_STALE_TIME,
  });
}

export function useSpaceInvitations(spaceName: string | undefined, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: spaceKeys.invitations(spaceName ?? ""),
    queryFn: async () => {
      const data = await spaceServiceClient.listSpaceInvitations({ parent: spaceName!, pageSize: 1000 });
      return data.spaceInvitations as SpaceInvitation[];
    },
    enabled: Boolean(spaceName) && (options?.enabled ?? true),
    staleTime: 1000 * 30,
  });
}

export function useUserSpaceInvitations(viewerName: string | undefined, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: spaceKeys.userInvitations(viewerName ?? ""),
    queryFn: async () => {
      const data = await spaceServiceClient.listUserSpaceInvitations({ parent: viewerName! });
      return data.spaceInvitations as SpaceInvitation[];
    },
    enabled: Boolean(viewerName) && (options?.enabled ?? true),
    staleTime: 1000 * 30,
  });
}

function useInvalidateSpaceQueries(viewerName?: string) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: spaceKeys.all });
    void queryClient.invalidateQueries({ queryKey: memoKeys.all });
    void queryClient.invalidateQueries({ queryKey: userKeys.stats() });
    void queryClient.invalidateQueries({ queryKey: userKeys.notifications() });
    if (viewerName) {
      void queryClient.invalidateQueries({ queryKey: spaceKeys.userInvitations(viewerName) });
    }
  };
}

export function useCreateSpace(viewerName: string | undefined) {
  const queryClient = useQueryClient();
  const invalidate = useInvalidateSpaceQueries(viewerName);
  return useMutation({
    mutationFn: async (input: Partial<Space> & { spaceId?: string }) => {
      const space = await spaceServiceClient.createSpace({
        space: {
          title: input.title,
          description: input.description,
          ...(input.icon ? { icon: input.icon } : {}),
        },
        spaceId: input.spaceId,
      });
      return space as Space;
    },
    onSuccess: (space) => {
      invalidate();
      if (viewerName) {
        queryClient.setQueryData<Space[]>(spaceKeys.list(viewerName), (previous = []) => [
          ...previous.filter((item) => item.name !== space.name),
          space,
        ]);
      }
    },
  });
}

export function useUpdateSpace(spaceName: string | undefined) {
  const invalidate = useInvalidateSpaceQueries();
  return useMutation({
    mutationFn: async (input: { space: Partial<Space>; updateMask: string[] }) => {
      const space = await spaceServiceClient.updateSpace({
        space: { name: spaceName, ...input.space },
        updateMask: { paths: input.updateMask },
      });
      return space as Space;
    },
    onSuccess: () => invalidate(),
  });
}

export function useDeleteSpace(spaceName: string | undefined) {
  const invalidate = useInvalidateSpaceQueries();
  return useMutation({
    mutationFn: async () => {
      await spaceServiceClient.deleteSpace({ name: spaceName! });
    },
    onSuccess: () => invalidate(),
  });
}

export function useCreateSpaceInvitation(spaceName: string | undefined) {
  const invalidate = useInvalidateSpaceQueries();
  return useMutation({
    mutationFn: async (input: { invitee: string; role: number }) => {
      const invitation = await spaceServiceClient.createSpaceInvitation({
        parent: spaceName!,
        spaceInvitation: { invitee: input.invitee, role: input.role },
      });
      return invitation as SpaceInvitation;
    },
    onSuccess: () => invalidate(),
  });
}

export function useDeleteSpaceInvitation(_spaceName: string | undefined, viewerName?: string) {
  const invalidate = useInvalidateSpaceQueries(viewerName);
  return useMutation({
    mutationFn: async (invitationName: string) => {
      await spaceServiceClient.deleteSpaceInvitation({ name: invitationName });
    },
    onSuccess: () => invalidate(),
  });
}

export function useUpdateSpaceMember(_spaceName: string | undefined) {
  const invalidate = useInvalidateSpaceQueries();
  return useMutation({
    mutationFn: async (input: { member: SpaceMember; role: number }) => {
      const member = await spaceServiceClient.updateSpaceMember({
        spaceMember: { name: input.member.name, role: input.role },
        updateMask: { paths: ["role"] },
      });
      return member as SpaceMember;
    },
    onSuccess: () => invalidate(),
  });
}

export function useDeleteSpaceMember(_spaceName: string | undefined) {
  const invalidate = useInvalidateSpaceQueries();
  return useMutation({
    mutationFn: async (memberName: string) => {
      await spaceServiceClient.deleteSpaceMember({ name: memberName });
    },
    onSuccess: () => invalidate(),
  });
}

export function useAcceptSpaceInvitation(viewerName: string | undefined) {
  const invalidate = useInvalidateSpaceQueries(viewerName);
  return useMutation({
    mutationFn: async (invitationName: string) => {
      await spaceServiceClient.acceptSpaceInvitation({ name: invitationName });
    },
    onSuccess: () => invalidate(),
  });
}

export function useDeclineSpaceInvitation(viewerName: string | undefined) {
  const invalidate = useInvalidateSpaceQueries(viewerName);
  return useMutation({
    mutationFn: async (invitationName: string) => {
      await spaceServiceClient.declineSpaceInvitation({ name: invitationName });
    },
    onSuccess: () => invalidate(),
  });
}
