import { useEffect, useMemo, useState } from "react"
import { AlertTriangle, FileDown, GitMerge, Loader2, RotateCcw, X } from "lucide-react"
import { useGalStore } from "@/stores/gal-store"
import { useWikiStore } from "@/stores/wiki-store"
import {
  buildGalNovelMarkdown,
  saveGalNovelMarkdown,
  traceGalPathToEntry,
} from "@/lib/gal/gal-export"
import type { GalRoute } from "@/lib/gal/gal-types"

interface GalPathExportDialogProps {
  route: GalRoute
  targetNodeId: string
  onClose: () => void
}

export function GalPathExportDialog({
  route,
  targetNodeId,
  onClose,
}: GalPathExportDialogProps) {
  const wikiProject = useWikiStore((state) => state.project)
  const requestLocateNode = useGalStore((state) => state.requestLocateNode)
  const [selectedParents, setSelectedParents] = useState<Record<string, string>>({})
  const [exporting, setExporting] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const result = useMemo(
    () => traceGalPathToEntry(route, targetNodeId, selectedParents),
    [route, selectedParents, targetNodeId],
  )

  useEffect(() => {
    setSelectedParents({})
    setMessage(null)
    requestLocateNode(targetNodeId)
  }, [requestLocateNode, route.id, targetNodeId])

  useEffect(() => {
    if (result.status === "needs-selection") {
      requestLocateNode(result.node.id)
    }
  }, [requestLocateNode, result])

  const handleSelectParent = (nodeId: string) => {
    requestLocateNode(nodeId)
    if (result.status !== "needs-selection") return
    setSelectedParents((current) => ({
      ...current,
      [result.node.id]: nodeId,
    }))
  }

  const handleExport = async () => {
    if (!wikiProject?.path || result.status !== "complete") return
    setExporting(true)
    setMessage(null)
    try {
      const target = result.nodes[result.nodes.length - 1]
      const title = target.type === "ending"
        ? target.title
        : `${target.title}-截至此节点`
      const novel = await buildGalNovelMarkdown(
        wikiProject.path,
        result.nodes[0]?.routeId || route.id,
        title,
        result.nodes,
      )
      const savedPath = await saveGalNovelMarkdown(title, novel.content)
      if (!savedPath) return
      setMessage(
        novel.missingNodes.length > 0
          ? `导出完成，其中 ${novel.missingNodes.length} 个节点缺少正文。`
          : "完整剧情正文已导出。",
      )
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "导出失败")
    } finally {
      setExporting(false)
    }
  }

  return (
    <aside className="absolute right-4 top-4 z-50 flex max-h-[calc(100%-2rem)] w-[380px] flex-col overflow-hidden rounded-lg border border-white/15 bg-[#171817]/95 text-slate-100 shadow-2xl backdrop-blur">
      <div className="flex items-start gap-3 border-b border-white/10 px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold">导出单线剧情</h2>
          <p className="mt-1 text-xs leading-5 text-slate-400">
            看着画布选择父节点，最终生成一份按剧情顺序排列的完整正文。
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md hover:bg-white/10"
          title="关闭"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        {result.status === "needs-selection" && (
          <>
            <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
              <GitMerge className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
              <div>
                <div className="text-sm font-medium">正在选择进入「{result.node.title}」的上一段</div>
                <div className="mt-1 text-xs leading-5 text-slate-400">
                  移到候选父节点上会自动定位画布；点击后沿该分支继续向入口回溯。
                </div>
              </div>
            </div>
            <div className="space-y-2">
              {result.options.map((option) => (
                <button
                  key={option.parentId}
                  type="button"
                  onMouseEnter={() => requestLocateNode(option.parentId)}
                  onFocus={() => requestLocateNode(option.parentId)}
                  onClick={() => handleSelectParent(option.parentId)}
                  className="flex w-full flex-col items-start rounded-md border border-white/10 px-3 py-2 text-left hover:border-amber-400/70 hover:bg-amber-400/10 focus-visible:border-amber-400 focus-visible:outline-none"
                >
                  <span className="text-sm font-medium">{option.parentTitle}</span>
                  {option.choiceText && (
                    <span className="mt-1 text-xs leading-5 text-slate-400">
                      经由选项：{option.choiceText}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </>
        )}

        {result.status === "complete" && (
          <>
            <div className="max-h-72 overflow-y-auto rounded-md border border-white/10">
              {result.nodes.map((node, index) => (
                <button
                  key={node.id}
                  type="button"
                  onMouseEnter={() => requestLocateNode(node.id)}
                  onFocus={() => requestLocateNode(node.id)}
                  onClick={() => requestLocateNode(node.id)}
                  className="flex w-full items-center gap-3 border-b border-white/10 px-3 py-2 text-left last:border-b-0 hover:bg-white/10 focus-visible:outline-none"
                >
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-white/10 text-xs text-slate-400">
                    {index + 1}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm">{node.title}</span>
                  <span className="text-xs text-slate-500">{node.status}</span>
                </button>
              ))}
            </div>
            {result.nodes[result.nodes.length - 1]?.type !== "ending" && (
              <div className="flex items-start gap-2 text-xs leading-5 text-amber-300">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                当前节点不是结局，将导出从入口到当前节点为止的剧情。
              </div>
            )}
          </>
        )}

        {result.status === "error" && (
          <div className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {result.message}
          </div>
        )}

        {message && (
          <div className="rounded-md bg-white/10 px-3 py-2 text-xs text-slate-200">{message}</div>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-white/10 p-3">
        {Object.keys(selectedParents).length > 0 && (
          <button
            type="button"
            onClick={() => {
              setSelectedParents({})
              requestLocateNode(targetNodeId)
            }}
            className="inline-flex h-9 items-center gap-2 rounded-md border border-white/15 px-3 text-sm hover:bg-white/10"
          >
            <RotateCcw className="h-4 w-4" />
            重新选择
          </button>
        )}
        <button
          type="button"
          disabled={exporting || result.status !== "complete"}
          onClick={() => void handleExport()}
          className="inline-flex h-9 items-center gap-2 rounded-md bg-amber-500 px-4 text-sm font-medium text-black hover:bg-amber-400 disabled:opacity-50"
        >
          {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileDown className="h-4 w-4" />}
          导出完整剧情
        </button>
      </div>
    </aside>
  )
}
