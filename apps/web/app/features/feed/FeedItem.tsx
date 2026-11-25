// One report in a feed. The same article sits on the desktop timeline or in a compact mobile row.
import { memo } from "react";
import { Link } from "react-router";
import { IntentLink } from "../../components/ui/IntentLink";
import type { GroupInfo, FeedItemSummary, TimelineFilters } from "@aihot/contracts/site";
import { CATEGORY_LABELS } from "@aihot/contracts/taxonomy";
import { IconCheck, IconChevronDown } from "../../components/icons";
import { Card } from "../../components/coss/card";
import { Button } from "../../components/coss/button";
import { SelectedBadge } from "../../components/ui/Badge";
import { ScoreLabel } from "../../components/ui/Score";
import { MediaThumbs, SourceLine, StarButton } from "./parts";
import { GroupDevelopments, GroupSources, LatestDevelopment } from "./ReadingGroup";
import { QuotedLine } from "../item/QuotedPost";
import { markRead, markUnread } from "../../lib/local-state";

export interface FeedItemProps {
  item: FeedItemSummary;
  group?: GroupInfo | null;
  filters?: TimelineFilters;
  read?: boolean;
  onMarkRead?: (item: FeedItemSummary) => void;
  onOpen?: (id: string) => void;
  /** Show category and tags under the text (全部动态, topics, search). */
  showTags?: boolean;
  compact?: boolean;
}

export const FeedItem = memo(function FeedItem({ item, group, filters, read = false, onOpen, onMarkRead, showTags = false, compact = false }: FeedItemProps) {
  const isX = item.channel === "x" && !!item.x;
  const open = () => onOpen?.(item.id);
  const showSources = !!group && (group.additionalSourceCount > 0 || (group.developmentCount <= 1 && group.reportCount > 1));
  const showDevelopments = !!group?.story && group.developmentCount > 1;
  const tags = showTags ? item.tags.slice(0, 3) : [];

  return (
    <Card render={<article />} data-item-id={item.id} className="min-w-0 border-0 bg-transparent shadow-none before:hidden lg:border lg:border-line lg:bg-card lg:px-5 lg:pt-4 lg:shadow-xs/5 lg:before:block lg:hover:border-line-strong">
      <header className="flex min-h-[18px] items-center gap-2 text-[12.5px] leading-[18px] text-ink-4">
        <SourceLine item={item} className="font-medium text-ink-3" />
        {item.selected && (
          <span className="hidden lg:inline-flex">
            <SelectedBadge />
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2">
          <span className="hidden lg:inline-flex">
            <ScoreLabel score={item.score} />
          </span>
          <span className="lg:hidden">
            <ScoreLabel score={item.score} compact />
          </span>
          <span className="-my-1 inline-flex">
            <StarButton item={item} />
          </span>
        </span>
      </header>

      {isX ? (
        <p className={`mt-2 whitespace-pre-line text-[15px] leading-[1.75] transition-colors ${compact ? "line-clamp-2" : "line-clamp-5 lg:line-clamp-4"} ${read ? "text-ink-4" : "text-ink"}`}>
          <IntentLink to={`/items/${item.id}`} onClick={open} className="after:absolute after:inset-0 after:content-['']">
            {item.summary ?? item.title}
          </IntentLink>
        </p>
      ) : (
        <>
          <h3 className={`mt-2 line-clamp-2 text-[17px] font-bold leading-[1.55] transition-colors lg:line-clamp-none lg:text-[18px] lg:font-[650] ${read ? "text-ink-4" : "text-ink"}`}>
            <IntentLink to={`/items/${item.id}`} onClick={open} className="after:absolute after:inset-0 after:content-['']">
              {item.title}
            </IntentLink>
          </h3>
          {!compact && item.summary && <p className="mt-1.5 line-clamp-2 text-[14.5px] leading-[1.75] text-ink-3 lg:mt-2 lg:text-[15px]">{item.summary}</p>}
        </>
      )}

      {!compact && isX && item.x!.media.length > 0 && <MediaThumbs media={item.x!.media} className="mt-2.5" />}
      {!compact && isX && item.x!.quoted?.text && <QuotedLine quoted={item.x!.quoted} />}

      {(tags.length > 0 || (showTags && item.category)) && (
        <div className="relative z-10 mt-2 hidden flex-wrap gap-x-2.5 gap-y-1 text-[12px] text-ink-4 lg:flex">
          {showTags && item.category && (
            <Link to={`/all?category=${item.category}`} className="hover:text-accent">
              {CATEGORY_LABELS[item.category]}
            </Link>
          )}
          {tags.map((t) => (
            <Link key={t} to={`/all?tag=${encodeURIComponent(t)}`} className="hover:text-accent">
              #{t}
            </Link>
          ))}
        </div>
      )}

      {group && <LatestDevelopment group={group} />}
      {(showSources || showDevelopments) && (
        <div className="mt-2 flex flex-wrap items-start gap-x-4 gap-y-1">
          {showSources && <GroupSources group={group!} filters={filters} parentId={item.id} />}
          {showDevelopments && <GroupDevelopments group={{ ...group!, story: group!.story! }} filters={filters} parentId={item.id} />}
        </div>
      )}

      <footer className="mt-3 flex items-start justify-between gap-2 border-t border-line-soft py-1 text-[12px] text-ink-3 lg:-mx-5 lg:rounded-b-2xl lg:bg-panel-quiet lg:px-5">
        {!compact && item.reason && (
          <details className="disclosure group/reason relative z-10 min-w-0 flex-1">
            <summary className="inline-flex min-h-9 cursor-pointer list-none items-center gap-1.5 rounded-control font-medium hover:text-accent">
              为什么值得看 <IconChevronDown size={13} className="transition-transform group-open/reason:rotate-180" />
            </summary>
            <p className="pb-2 text-[13px] leading-[1.75]">{item.reason}</p>
          </details>
        )}
        <Button variant="ghost" size="xs" onClick={() => read ? markUnread(item.id) : onMarkRead ? onMarkRead(item) : markRead(item.id)} className="relative z-10 my-auto ml-auto h-9 text-xs text-ink-3 hover:bg-bg-sunk hover:text-accent sm:h-8">
          <IconCheck size={13} className={`transition-opacity ${read ? "opacity-100" : "opacity-0"}`} />
          {read ? "已读 · 标为未读" : "标为已读"}
        </Button>
      </footer>
    </Card>
  );
});
