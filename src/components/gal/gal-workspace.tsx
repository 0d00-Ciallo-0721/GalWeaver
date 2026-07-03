/**
 * Galgame 宸ヤ綔鍙?- 涓诲竷灞€
 *
 * 涓夋爮甯冨眬锛氬乏渚х嚎璺妭鐐规爲 | 涓棿鑺傜偣缂栬緫鍣?| 鍙充晶/搴曢儴 AI 瀵硅瘽
 * 澶嶇敤 WritingWorkspace 鐨?ChatPanel 闆嗘垚妯″紡銆? */

import { useCallback, useEffect, useState } from "react"
import { useGalStore } from "@/stores/gal-store"
import { useWikiStore } from "@/stores/wiki-store"
import { GalNodeEditor } from "./gal-node-editor"
import { GalRouteBoard } from "./gal-route-board"
import { isEmptyProject } from "./gal-utils"
import { isGalProject, loadGalProject } from "@/lib/gal/gal-storage"
import { lintBranchGraph } from "@/lib/gal/gal-branch-lint"
import { buildGalInitContextPreview, initGalProject } from "@/lib/gal/gal-project-init"

export function GalWorkspace() {
  const project = useWikiStore((s) => s.project)
  const galStore = useGalStore()
  const [initializing, setInitializing] = useState(false)
  const [initError, setInitError] = useState<string | null>(null)
  const [initContextPreview, setInitContextPreview] = useState<string | null>(null)
  const [loadingInitContext, setLoadingInitContext] = useState(false)
  const [view, setView] = useState<"board" | "detail">("board")

  const isLoading = galStore.loading || initializing
  const error = galStore.error || initError

  useEffect(() => {
    if (Array.isArray(galStore.project?.routes) && galStore.project.routes.length && !galStore.selectedRouteId) {
      galStore.selectRoute(galStore.project.routes[0].id)
    }
  }, [galStore.project?.routes, galStore.selectedRouteId])

  useEffect(() => {
    const selectedRoute = galStore.project?.routes.find((route) => route.id === galStore.selectedRouteId)
    if (galStore.selectedNodeId && !Array.isArray(selectedRoute?.nodeIds)) {
      setView("detail")
    }
    if (Array.isArray(selectedRoute?.nodeIds)) {
      setView("board")
    }
  }, [galStore.project?.routes, galStore.selectedRouteId, galStore.selectedNodeId])

  useEffect(() => {
    if (!project?.path) return

    let cancelled = false
    const load = async () => {
      galStore.setLoading(true)
      try {
        const exists = await isGalProject(project.path)
        if (cancelled) return
        if (exists) {
          const galProject = await loadGalProject(project.path)
          if (!cancelled) galStore.setProject(galProject)
        }
      } catch (err) {
        if (!cancelled) {
          galStore.setError(err instanceof Error ? err.message : "鍔犺浇澶辫触")
        }
      } finally {
        if (!cancelled) galStore.setLoading(false)
      }
    }

    void load()
    return () => { cancelled = true }
  }, [project?.path])

  // 鍒濆鍖栨柊 Gal 椤圭洰
  const handleInitProject = useCallback(async () => {
    if (!project) return
    setInitializing(true)
    setInitError(null)
    try {
      const galProject = await initGalProject({
        projectPath: project.path,
        title: project.name || "未命名 Gal 项目",
      })
      galStore.setProject(galProject)
    } catch (err) {
      const detail = err instanceof Error
        ? `${err.message}\n\n${err.stack?.split("\n").slice(0, 6).join("\n") || ""}`
        : String(err)
      setInitError(detail)
      console.error("[Gal Init]", err)
    } finally {
      setInitializing(false)
    }
  }, [project])

  const handleReinitProject = useCallback(async () => {
    if (!project) return
    const confirmed = window.confirm(
      "閲嶆柊鍒濆鍖栦細瑕嗙洊褰撳墠 Gal 绾胯矾銆佽妭鐐瑰崱鐗囧拰鍙橀噺閰嶇疆銆傚凡鐢熸垚鐨勬棫鑺傜偣姝ｆ枃鏂囦欢鍙兘浠嶇暀鍦?.gal/nodes 涓紝浣嗕笉浼氬啀琚柊椤圭洰寮曠敤銆傛槸鍚︾户缁紵",
    )
    if (!confirmed) return

    setInitializing(true)
    setInitError(null)
    try {
      galStore.selectNode(null)
      galStore.selectRoute(null)
      const galProject = await initGalProject({
        projectPath: project.path,
        title: project.name || "未命名 Gal 项目",
      })
      galStore.setProject(galProject)
      const firstRoute = galProject.routes[0]
      if (firstRoute) {
        galStore.selectRoute(firstRoute.id)
        galStore.selectNode(firstRoute.entryNodeId)
        setView("detail")
      } else {
        setView("board")
      }
    } catch (err) {
      const detail = err instanceof Error
        ? `${err.message}\n\n${err.stack?.split("\n").slice(0, 6).join("\n") || ""}`
        : String(err)
      setInitError(detail)
      console.error("[Gal Reinit]", err)
    } finally {
      setInitializing(false)
    }
  }, [project])

  const handleShowInitContext = useCallback(async () => {
    if (!project) return
    setLoadingInitContext(true)
    setInitError(null)
    try {
      const preview = await buildGalInitContextPreview(
        project.path,
        project.name || "Galgame 项目",
      )
      setInitContextPreview(preview || "未读取到可用的小说上下文。请确认大纲、记忆或项目设定已完成提取。")
    } catch (err) {
      const detail = err instanceof Error
        ? `错误: ${err.message}\n\n堆栈:\n${err.stack?.split("\n").slice(0, 10).join("\n") || "无"}`
        : String(err)
      setInitContextPreview(`读取上下文失败\n\n${detail}`)
      setInitError(detail)
      console.error("[Gal InitContext]", err)
    } finally {
      setLoadingInitContext(false)
    }
  }, [project])

  // 分支检查
  const handleLintBranch = useCallback(async () => {
    if (!project || !galStore.selectedRouteId) return
    galStore.setLintRunning(true)
    try {
      const results = await lintBranchGraph(
        project.path,
        galStore.selectedRouteId,
      )
      galStore.setLintResults(results)
    } catch (err) {
      console.error("鍒嗘敮妫€鏌ュけ璐?", err)
    } finally {
      galStore.setLintRunning(false)
    }
  }, [project, galStore.selectedRouteId])

  const handleSelectBoardNode = useCallback((nodeId: string) => {
    const selectedRoute = galStore.project?.routes.find((route) => route.id === galStore.selectedRouteId)
    if (Array.isArray(selectedRoute?.nodeIds)) {
      return
    }
    galStore.selectNode(nodeId)
    setView("detail")
  }, [galStore])

  // 空状态：显示初始化按钮
  if (!isLoading && isEmptyProject(galStore.project)) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8">
        <h2 className="text-xl font-semibold">Galgame 剧本工作台</h2>
        <p className="text-sm text-muted-foreground">
          此项目尚未初始化为 Galgame 项目。初始化会复用小说写作上下文生成线路骨架和入口节点。
        </p>
        {error && (
          <p className="text-sm text-destructive">{error}</p>
        )}
        <div className="flex flex-wrap items-center justify-center gap-2">
          <button
            type="button"
            disabled={initializing}
            onClick={handleInitProject}
            className="rounded-md bg-primary px-6 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {initializing ? "初始化中..." : "初始化 Gal 项目"}
          </button>
          <button
            type="button"
            disabled={loadingInitContext}
            onClick={handleShowInitContext}
            className="rounded-md border px-6 py-2 text-sm font-medium hover:bg-accent disabled:opacity-50"
          >
            {loadingInitContext ? "读取中..." : "查看初始化上下文"}
          </button>
        </div>
        {initContextPreview && (
          <InitContextPreview
            content={initContextPreview}
            onClose={() => setInitContextPreview(null)}
          />
        )}
      </div>
    )
  }

  // 主工作台：路线树在 sidebar 中，这里显示画布或详情编辑器
  return (
    <div className="flex h-full min-h-0 overflow-hidden bg-background">
      <div className="min-w-0 flex-1 overflow-hidden">
        {view === "detail" && galStore.selectedNodeId ? (
          <GalNodeEditor
            onLintBranch={handleLintBranch}
            lintRunning={galStore.lintRunning}
            lintResults={galStore.lintResults}
            onReinitGal={handleReinitProject}
            reinitializing={initializing}
            onShowInitContext={handleShowInitContext}
            loadingInitContext={loadingInitContext}
            onBackToBoard={() => {
              galStore.selectNode(null)
              setView("board")
            }}
          />
        ) : (
          <GalRouteBoard
            route={galStore.selectedRoute()}
            selectedNodeId={galStore.selectedNodeId}
            onSelectNode={handleSelectBoardNode}
            onReinitGal={handleReinitProject}
            reinitializing={initializing}
            error={error}
          />
        )}
      </div>
      {initContextPreview && (
        <InitContextPreview
          content={initContextPreview}
          onClose={() => setInitContextPreview(null)}
        />
      )}
    </div>
  )
}

function InitContextPreview({
  content,
  onClose,
}: {
  content: string
  onClose: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
      <div className="flex max-h-[86vh] w-full max-w-5xl flex-col overflow-hidden rounded-md border bg-background shadow-2xl">
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">Gal 初始化上下文</div>
            <div className="text-xs text-muted-foreground">
              以下内容复用小说写作的上下文注入链路，会作为 Gal 初始化的最高优先级依据。
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border px-3 py-1.5 text-xs hover:bg-accent"
          >
            关闭
          </button>
        </div>
        <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap p-4 text-xs leading-5">
          {content}
        </pre>
      </div>
    </div>
  )
}
