import { timestampDate } from "@bufbuild/protobuf/wkt";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { useMemo } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import MemoView from "@/components/MemoView/MemoView";
import MobileHeader from "@/components/MobileHeader";
import PagedMemoList from "@/components/PagedMemoList";
import { Button } from "@/components/ui/button";
import useMediaQuery from "@/hooks/useMediaQuery";
import { useMemos } from "@/hooks/useMemoQueries";
import { cn } from "@/lib/utils";
import { State } from "@/types/proto/api/v1/common_pb";
import type { Memo } from "@/types/proto/api/v1/memo_service_pb";
import { useTranslate } from "@/utils/i18n";

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function getMonthRange(year: number, month: number) {
  const start = new Date(year, month, 1);
  const end = new Date(year, month + 1, 1);
  return { start, end, startSeconds: start.getTime() / 1000, endSeconds: end.getTime() / 1000 };
}

function buildMonthPath(year: number, month: number) {
  return `/calendar/${year}/${month + 1}`;
}

const Calendar = () => {
  const t = useTranslate();
  const md = useMediaQuery("md");
  const navigate = useNavigate();
  const params = useParams<{ year?: string; month?: string; day?: string }>();

  const now = new Date();
  const parsedYear = Number(params.year);
  const parsedMonth = Number(params.month);
  const year = Number.isInteger(parsedYear) && parsedYear > 0 ? parsedYear : now.getFullYear();
  const month = Number.isInteger(parsedMonth) && parsedMonth >= 1 && parsedMonth <= 12 ? parsedMonth - 1 : now.getMonth();
  const selectedDay = params.day ? Number(params.day) : undefined;
  const { start, startSeconds, endSeconds } = getMonthRange(year, month);

  const filter = `created_ts >= ${startSeconds} && created_ts < ${endSeconds}`;
  const { data, isLoading } = useMemos({ state: State.NORMAL, filter, pageSize: 1000, orderBy: "create_time asc" });
  const memos = data?.memos || [];

  const memosByDay = useMemo(() => {
    const map = new Map<number, Memo[]>();
    for (const memo of memos) {
      if (!memo.createTime) continue;
      const date = timestampDate(memo.createTime);
      const day = date.getDate();
      const list = map.get(day) || [];
      list.push(memo);
      map.set(day, list);
    }
    return map;
  }, [memos]);

  const firstWeekday = start.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: Array<{ day: number; inMonth: boolean; date: Date }> = [];

  for (let index = 0; index < 42; index += 1) {
    const offset = index - firstWeekday;
    const cellDate = new Date(year, month, 1 + offset);
    cells.push({
      day: cellDate.getDate(),
      inMonth: cellDate.getMonth() === month,
      date: cellDate,
    });
  }

  const prevMonth = new Date(year, month - 1, 1);
  const nextMonth = new Date(year, month + 1, 1);
  const selectedDate = selectedDay && selectedDay >= 1 && selectedDay <= daysInMonth ? new Date(year, month, selectedDay) : undefined;
  const selectedDayStart = selectedDate ? new Date(year, month, selectedDay).getTime() / 1000 : 0;
  const selectedDayEnd = selectedDate ? selectedDayStart + 86400 : 0;

  return (
    <section className="@container w-full max-w-4xl min-h-full flex flex-col justify-start items-center sm:pt-3 md:pt-6 pb-8">
      {!md && <MobileHeader />}
      <div className="w-full px-4 sm:px-6">
        <div className="mb-4 flex flex-row items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">{t("calendar.calendar")}</h1>
            <p className="text-sm text-muted-foreground">
              {year} · {month + 1}
            </p>
          </div>
          <div className="flex flex-row items-center gap-1">
            <Button variant="ghost" size="icon" aria-label={t("calendar.previous-month")} asChild>
              <Link to={buildMonthPath(prevMonth.getFullYear(), prevMonth.getMonth())}>
                <ChevronLeftIcon />
              </Link>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <Link to={buildMonthPath(now.getFullYear(), now.getMonth())}>{t("calendar.today")}</Link>
            </Button>
            <Button variant="ghost" size="icon" aria-label={t("calendar.next-month")} asChild>
              <Link to={buildMonthPath(nextMonth.getFullYear(), nextMonth.getMonth())}>
                <ChevronRightIcon />
              </Link>
            </Button>
          </div>
        </div>

        <div className="overflow-hidden rounded-xl border border-border bg-card">
          <div className="grid grid-cols-7 border-b border-border bg-muted/30">
            {WEEKDAY_LABELS.map((label) => (
              <div key={label} className="px-2 py-2 text-center text-xs font-medium text-muted-foreground">
                {label}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7">
            {cells.map((cell, index) => {
              const dayMemos = cell.inMonth ? memosByDay.get(cell.day) || [] : [];
              const isToday = cell.date.toDateString() === now.toDateString();
              const isSelected = cell.inMonth && selectedDay === cell.day;
              return (
                <button
                  type="button"
                  key={`${cell.date.toISOString()}-${index}`}
                  disabled={!cell.inMonth}
                  onClick={() => navigate(`${buildMonthPath(year, month)}/${cell.day}`)}
                  className={cn(
                    "relative flex min-h-24 flex-col items-start gap-1 border-b border-r border-border p-1.5 text-left align-top transition-colors last:border-r-0",
                    cell.inMonth ? "hover:bg-accent/40" : "cursor-default bg-muted/10 text-muted-foreground/50",
                    isSelected && "bg-accent/60",
                  )}
                >
                  <span
                    className={cn(
                      "flex size-6 items-center justify-center rounded-full text-xs font-medium",
                      isToday && "bg-primary text-primary-foreground",
                      !isToday && cell.inMonth && "text-foreground",
                    )}
                  >
                    {cell.day}
                  </span>
                  {cell.inMonth && (
                    <div className="flex w-full flex-col gap-0.5">
                      {dayMemos.slice(0, 3).map((memo) => (
                        <span key={memo.name} className="truncate rounded bg-primary/10 px-1 py-0.5 text-[10px] leading-4 text-foreground">
                          {memo.snippet || memo.content || "·"}
                        </span>
                      ))}
                      {dayMemos.length > 3 && <span className="text-[10px] text-muted-foreground">+{dayMemos.length - 3}</span>}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {isLoading && <p className="mt-3 text-center text-xs text-muted-foreground">{t("common.loading")}</p>}

        {selectedDate && (
          <div className="mt-5">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-sm font-semibold">
                {selectedDate.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })}
              </h2>
              <Button variant="ghost" size="sm" onClick={() => navigate(buildMonthPath(year, month))}>
                {t("calendar.all-memos")}
              </Button>
            </div>
            <PagedMemoList
              renderer={(memo) => (
                <MemoView key={`${memo.name}-${memo.updateTime}`} memo={memo} showVisibility showPinned compact showSpace />
              )}
              orderBy="create_time desc"
              filter={`created_ts >= ${selectedDayStart} && created_ts < ${selectedDayEnd}`}
              showMemoEditor
              defaultCreateTime={selectedDate}
            />
          </div>
        )}

        {!selectedDate && (
          <div className="mt-5">
            <PagedMemoList
              renderer={(memo) => (
                <MemoView key={`${memo.name}-${memo.updateTime}`} memo={memo} showVisibility showPinned compact showSpace />
              )}
              orderBy="create_time desc"
              filter={filter}
            />
          </div>
        )}
      </div>
    </section>
  );
};

export default Calendar;
