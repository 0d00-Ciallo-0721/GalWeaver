import { AlertTriangle, Loader2, RotateCcw, X } from "lucide-react"
import { useGalStore } from "@/stores/gal-store"

export function GalAiTaskToasts() {
  const tasks = useGalStore((state) => state.aiTasks)
  const dismissAiTask = useGalStore((state) => state.dismissAiTask)

  if (tasks.length === 0) return null

  return (
    <div className="pointer-events-none fixed left-20 top-14 z-[80] flex w-[360px] flex-col gap-2">
      {tasks.map((task) => (
        <div
          key={task.id}
          className="pointer-events-auto rounded-md border border-white/15 bg-[#171b1b]/95 p-3 text-xs text-slate-100 shadow-2xl"
        >
          <div className="flex items-start gap-2">
            <div className="mt-0.5 shrink-0">
              {task.status === "failed" ? (
                <AlertTriangle className="h-4 w-4 text-red-400" />
              ) : task.status === "retrying" ? (
                <RotateCcw className="h-4 w-4 animate-spin text-amber-400" />
              ) : (
                <Loader2 className="h-4 w-4 animate-spin text-amber-400" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1 truncate font-medium">{task.title}</div>
                <div className="shrink-0 text-[10px] text-slate-400">
                  {task.attempt}/{task.maxRetries + 1}
                </div>
              </div>
              <div className="mt-1 line-clamp-2 text-slate-300">{task.detail}</div>
              {task.error && (
                <div className="mt-1 line-clamp-2 text-red-300">{task.error}</div>
              )}
            </div>
            {task.status === "failed" && (
              <button
                type="button"
                onClick={() => dismissAiTask(task.id)}
                className="shrink-0 rounded p-0.5 text-slate-400 hover:bg-white/10 hover:text-slate-100"
                title="关闭"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}
