import { memberPathname } from "@aihot/contracts/member-destination";
import { Link, useLocation, useNavigate } from "react-router";

// React Router restores the saved scroll position on a history traversal. The href
// also works when the reader opens a profile in a new tab or shares its URL.
export function useFinancingTrail() {
  const location = useLocation();
  const pathname = memberPathname(location.pathname);
  const index = typeof window === "undefined" ? undefined : window.history.state?.idx;
  return {
    financingListIndex: pathname === "/financing" ? index : location.state?.financingListIndex,
    financingInvestorIndex: pathname === "/financing/investor" ? index : undefined,
  };
}

export function FinancingReturn({ to, investor = false }: { to: string; investor?: boolean }) {
  const navigate = useNavigate();
  const location = useLocation();
  return <Link to={to} className="inline-flex min-h-10 items-center text-sm text-ink-3 hover:text-accent"
    onClick={event => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const previous = investor ? location.state?.financingInvestorIndex : location.state?.financingListIndex;
      const current = window.history.state?.idx;
      if (Number.isInteger(previous) && previous >= 0 && Number.isInteger(current) && current > previous) {
        event.preventDefault();
        void navigate(previous - current);
      }
    }}>{investor ? "返回机构投资记录" : "返回融资数据库"}</Link>;
}
