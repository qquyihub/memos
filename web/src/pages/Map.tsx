import { MapIcon } from "lucide-react";
import MobileHeader from "@/components/MobileHeader";
import UserMemoMap from "@/components/UserMemoMap";
import useMediaQuery from "@/hooks/useMediaQuery";
import { useTranslate } from "@/utils/i18n";

const MemoMap = () => {
  const t = useTranslate();
  const md = useMediaQuery("md");

  return (
    <section className="@container w-full max-w-6xl min-h-full flex flex-col justify-start items-center sm:pt-3 md:pt-6 pb-8">
      {!md && <MobileHeader />}
      <div className="w-full px-4 sm:px-6">
        <div className="mb-4 flex flex-row items-center gap-2">
          <MapIcon className="w-5 h-auto text-muted-foreground" />
          <h1 className="text-xl font-semibold">{t("map.map")}</h1>
        </div>
        <UserMemoMap className="h-[calc(100vh-11rem)] min-h-[420px]" />
      </div>
    </section>
  );
};

export default MemoMap;
