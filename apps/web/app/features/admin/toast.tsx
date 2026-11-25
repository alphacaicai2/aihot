import { Toast } from "@base-ui/react/toast";
import { IconClose } from "../../components/icons";
import "./toast.css";

type Tone = "ok" | "error" | "info";
const manager = Toast.createToastManager();

export function toast(text: string, tone: Tone = "info") {
  manager.add({
    id: `${tone}-${text}`,
    type: tone,
    title: text,
    priority: tone === "error" ? "high" : "low",
    timeout: tone === "error" ? 6500 : 3200,
  });
}

function Notices() {
  const { toasts } = Toast.useToastManager();
  return (
    <Toast.Portal>
      <Toast.Viewport aria-label="操作结果" className="pointer-events-none fixed inset-x-4 bottom-[max(1rem,env(safe-area-inset-bottom))] z-[80] mx-auto max-w-md">
        {toasts.map(item => (
          <Toast.Root
            key={item.id}
            toast={item}
            swipeDirection="right"
            className={`admin-toast pointer-events-auto flex items-center gap-2 rounded-card px-4 py-2.5 text-[13.5px] shadow-lg ring-1 ${item.type === "error" ? "bg-hot text-white ring-hot/40" : item.type === "ok" ? "bg-ink text-bg ring-line-strong" : "bg-surface text-ink ring-line-strong"}`}
          >
            <Toast.Title className="min-w-0 break-words" />
            {item.type === "error" && <Toast.Close aria-label="关闭提示" className="-mr-1 grid size-7 shrink-0 place-items-center rounded-full hover:bg-white/15"><IconClose size={14} /></Toast.Close>}
          </Toast.Root>
        ))}
      </Toast.Viewport>
    </Toast.Portal>
  );
}

export function Toaster() {
  return <Toast.Provider toastManager={manager} limit={4}><Notices /></Toast.Provider>;
}
