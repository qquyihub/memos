import { ArrowLeftIcon } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import MemoView from "@/components/MemoView/MemoView";
import PagedMemoList from "@/components/PagedMemoList";
import SpaceIcon from "@/components/SpaceIcon";
import useCurrentUser from "@/hooks/useCurrentUser";
import { useMemoViews } from "@/hooks/useMemoViewQueries";
import { useTranslate } from "@/utils/i18n";

const MemoViewDetail = () => {
  const t = useTranslate();
  const currentUser = useCurrentUser();
  const params = useParams<{ viewId: string }>();
  const { data: views = [] } = useMemoViews(currentUser?.name);
  const view = views.find((item) => item.name === `users/${currentUser?.username}/views/${params.viewId}`);

  return (
    <section className="@container w-full max-w-3xl min-h-full flex flex-col justify-start items-center sm:pt-3 md:pt-6 pb-8">
      <div className="w-full px-4 sm:px-6">
        <div className="mb-3">
          <Link className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground" to="/views">
            <ArrowLeftIcon className="size-4" />
            {t("view.views")}
          </Link>
        </div>

        {view ? (
          <>
            <div className="mb-4 flex items-center gap-3">
              <SpaceIcon icon={view.icon} className="size-10 text-lg" />
              <div className="min-w-0">
                <h1 className="truncate text-xl font-semibold">{view.title}</h1>
                <pre className="mt-0.5 overflow-x-auto font-mono text-xs text-muted-foreground">{view.filter}</pre>
              </div>
            </div>
            <PagedMemoList
              renderer={(memo) => (
                <MemoView key={`${memo.name}-${memo.updateTime}`} memo={memo} showVisibility showPinned compact showSpace />
              )}
              orderBy="create_time desc"
              filter={view.filter}
            />
          </>
        ) : (
          <p className="py-16 text-center text-sm text-muted-foreground">{t("view.not-found")}</p>
        )}
      </div>
    </section>
  );
};

export default MemoViewDetail;
