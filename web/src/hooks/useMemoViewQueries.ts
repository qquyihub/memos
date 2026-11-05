import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { userServiceClient } from "@/connect";
import type { MemoView } from "@/types/space";

export const memoViewKeys = {
  all: ["memoViews"] as const,
  list: (viewerName: string) => [...memoViewKeys.all, "list", viewerName] as const,
  detail: (name: string) => [...memoViewKeys.all, "detail", name] as const,
};

export function useMemoViews(viewerName: string | undefined, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: memoViewKeys.list(viewerName ?? ""),
    queryFn: async () => {
      const data = await userServiceClient.listMemoViews({ parent: viewerName! });
      return data.memoViews as MemoView[];
    },
    enabled: Boolean(viewerName) && (options?.enabled ?? true),
    staleTime: 1000 * 60 * 5,
  });
}

export function useCreateMemoView(viewerName: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { title: string; filter: string; icon?: { emoji?: string; lucide?: string } }) => {
      const view = await userServiceClient.createMemoView({
        parent: viewerName!,
        memoView: input,
      });
      return view as MemoView;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: memoViewKeys.list(viewerName ?? "") });
    },
  });
}

export function useUpdateMemoView(viewerName: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { view: MemoView; updateMask: string[] }) => {
      const view = await userServiceClient.updateMemoView({
        memoView: input.view,
        updateMask: { paths: input.updateMask },
      });
      return view as MemoView;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: memoViewKeys.list(viewerName ?? "") });
    },
  });
}

export function useDeleteMemoView(viewerName: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (name: string) => {
      await userServiceClient.deleteMemoView({ name });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: memoViewKeys.list(viewerName ?? "") });
    },
  });
}
