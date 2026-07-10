import { useEffect, useMemo, useState } from "react"
import { AlertTriangle, ChevronDown, ChevronRight, Circle, FileDown, GitBranch, Loader2, Plus, Sparkles, Trash2 } from "lucide-react"
import { useGalStore } from "@/stores/gal-store"
import { useWikiStore } from "@/stores/wiki-store"
import { loadGalProject, saveGalProject } from "@/lib/gal/gal-storage"
import { exportGalProjectContents, exportGalRouteTree } from "@/lib/gal/gal-export"
import { generateNodeScript } from "@/lib/gal/gal-node-generation"
import { hasNodeOutgoingTarget } from "@/lib/gal/gal-graph-normalize"
import { pickDirectory } from "@/lib/platform"
import { getNodeTypeColor } from "./gal-utils"
import type { GalNode, GalRoute } from "@/lib/gal/gal-types"

export function GalRouteTree() {
  const wikiProject = useWikiStore((s) => s.project)
  const project = useGalStore((s) => s.project)
  const selectedRouteId = useGalStore((s) => s.selectedRouteId)
  const selectedNodeId = useGalStore((s) => s.selectedNodeId)
  const selectRoute = useGalStore((s) => s.selectRoute)
  const selectNode = useGalStore((s) => s.selectNode)
  const requestLocateNode = useGalStore((s) => s.requestLocateNode)
  const setProject = useGalStore((s) => s.setProject)
  const setError = useGalStore((s) => s.setError)
  const runAiTask = useGalStore((s) => s.runAiTask)
  const [busy, setBusy] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportMessage, setExportMessage] = useState<string | null>(null)
  const [exportMissingNodes, setExportMissingNodes] = useState<GalNode[]>([])

  const routes = Array.isArray(project?.routes) ? project.routes : []
  const mainRouteId = routes.find((route) => route.id === "main")?.id ?? routes[0]?.id
  const mainRoute = routes.find((route) => route.id === mainRouteId)
  const mainNodeById = useMemo(
    () => new Map((mainRoute?.nodes ?? []).map((node) => [node.id, node])),
    [mainRoute],
  )

  if (!project || routes.length === 0) {
    return (
      <div className="flex h-full flex-col overflow-hidden">
        <Header busy={busy} exporting={exporting} onAddRoute={() => {}} onExport={() => {}} />
        <div className="flex flex-1 items-center justify-center p-4 text-center text-xs text-muted-foreground">
          暂无线路，请先初始化 Gal 项目
        </div>
      </div>
    )
  }

  const persistProject = async (nextProject = project) => {
    if (!wikiProject?.path) return
    await saveGalProject(wikiProject.path, nextProject)
    setProject(await loadGalProject(wikiProject.path))
  }

  const handleAddSpecialRoute = async () => {
    if (!project || !wikiProject?.path || busy) return
    setBusy(true)
    setError(null)
    try {
      const now = new Date().toISOString()
      const routeId = createUniqueRouteId(routes)
      const routeCount = routes.filter((route) => route.id !== mainRouteId).length + 1
      await persistProject({
        ...project,
        routes: [
          ...routes,
          {
            id: routeId,
            title: `新线路 ${routeCount}`,
            theme: "",
            entryNodeId: "",
            endingNodeIds: [],
            nodes: [],
          },
        ],
        updatedAt: now,
      })
      selectNode(null)
      selectRoute(routeId)
    } catch (err) {
      setError(err instanceof Error ? err.message : "新增线路失败")
    } finally {
      setBusy(false)
    }
  }

  const handleGenerateRouteEntry = async (routeId: string, entryPrompt: string) => {
    if (!project || !wikiProject?.path || busy) return
    const prompt = entryPrompt.trim()
    if (!prompt) {
      setError("请先填写新线路入口提示词")
      return
    }
    const route = routes.find((item) => item.id === routeId)
    if (!route || route.id === mainRouteId || Array.isArray(route.nodeIds)) return
    if ((route.nodes ?? []).length > 0) {
      setError("该线路已经有入口节点，不能重复生成入口")
      return
    }

    setBusy(true)
    setError(null)
    try {
      const now = new Date().toISOString()
      const entryNode = createRouteEntryNode(route, prompt, now, routes)
      const stagedProject = {
        ...project,
        routes: routes.map((item) => (
          item.id === routeId
            ? {
                ...item,
                theme: prompt,
                entryNodeId: entryNode.id,
                nodes: [entryNode],
              }
            : item
        )),
        updatedAt: now,
      }
      await persistProject(stagedProject)
      selectRoute(routeId)
      selectNode(entryNode.id)

      await runAiTask(
        {
          title: `生成线路入口：${route.title}`,
          detail: "正在基于入口提示词和完整项目上下文生成入口正文...",
          maxRetries: 2,
        },
        (task) => generateNodeScript({
          projectPath: wikiProject.path,
          routeId,
          nodeId: entryNode.id,
          userPrompt: [
            "这是一个独立特殊线路的入口节点。",
            "必须严格位于作品大纲与人物设定之内，但不要复用主线路节点数据。",
            "请基于下面的线路入口提示词，生成能开启该特殊线路的完整入口正文。",
            prompt,
          ].join("\n"),
          onToken: () => task.update("正在生成入口正文..."),
        }),
      )

      const reloaded = await loadGalProject(wikiProject.path)
      if (reloaded) setProject(reloaded)
      selectRoute(routeId)
      selectNode(entryNode.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : "生成线路入口失败")
    } finally {
      setBusy(false)
    }
  }

  const handleAddLooseNode = async () => {
    if (!project || !wikiProject?.path || !mainRoute || busy) return
    setBusy(true)
    setError(null)
    try {
      const now = new Date().toISOString()
      const nodeId = `empty_${Date.now().toString(36)}`
      const looseNode: GalNode = {
        id: nodeId,
        routeId: mainRoute.id,
        title: "空节点",
        type: "common",
        status: "card",
        parents: [],
        children: [],
        goal: "作为后续分支的收束节点。",
        summary: "空节点。可从其他更前面的节点选项收束到这里。",
        scriptPath: `nodes/${mainRoute.id}/${nodeId}.md`,
        incomingState: {
          variables: {},
          characterCognition: {},
          acquiredClueIds: [],
          seenCgIds: [],
          visitedNodeIds: [],
          currentScene: "",
          characterMoods: {},
        },
        choices: [],
        memoryScope: "node",
        characters: [],
        scene: "",
        clueIds: [],
        sequence: Math.max(0, ...(mainRoute.nodes ?? []).map((node) => node.sequence || 0)) + 1,
        createdAt: now,
        updatedAt: now,
      }
      await persistProject({
        ...project,
        routes: routes.map((route) => (
          route.id === mainRoute.id
            ? { ...route, nodes: [...(route.nodes ?? []), looseNode] }
            : route
        )),
        updatedAt: now,
      })
      selectRoute(mainRoute.id)
      selectNode(nodeId)
    } catch (err) {
      setError(err instanceof Error ? err.message : "新增空节点失败")
    } finally {
      setBusy(false)
    }
  }

  const updatePathRoute = async (routeId: string, patch: Partial<GalRoute>) => {
    if (!project || !wikiProject?.path || busy || routeId === mainRouteId) return
    setBusy(true)
    setError(null)
    try {
      await persistProject({
        ...project,
        routes: routes.map((route) => (
          route.id === routeId ? { ...route, ...patch } : route
        )),
        updatedAt: new Date().toISOString(),
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存线路失败")
    } finally {
      setBusy(false)
    }
  }

  const handleDeletePathRoute = async (routeId: string) => {
    if (!project || !wikiProject?.path || busy || routeId === mainRouteId) return
    const route = routes.find((item) => item.id === routeId)
    if (!route) return
    if (!window.confirm(`确定删除线路「${route.title}」吗？这只会删除路径，不会删除主线路节点。`)) return
    setBusy(true)
    setError(null)
    try {
      await persistProject({
        ...project,
        routes: routes.filter((item) => item.id !== routeId),
        updatedAt: new Date().toISOString(),
      })
      if (selectedRouteId === routeId) {
        selectNode(null)
        selectRoute(mainRouteId ?? null)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除线路失败")
    } finally {
      setBusy(false)
    }
  }

  const handleExportAll = async () => {
    if (!project || !wikiProject?.path || exporting) return
    setExporting(true)
    setExportMessage(null)
    setExportMissingNodes([])
    setError(null)
    try {
      const destination = await pickDirectory()
      if (!destination) return
      const result = await exportGalProjectContents(
        wikiProject.path,
        destination,
        project,
      )
      setExportMissingNodes(result.missingNodes)
      setExportMessage(
        `已导出 ${result.nodeCount} 个节点、${result.routeCount} 条单线`
        + (result.missingNodes.length > 0
          ? `，${result.missingNodes.length} 个节点缺少正文`
          : ""),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : "导出线路失败")
    } finally {
      setExporting(false)
    }
  }

  const handleExportRouteTree = async (routeId: string) => {
    if (!project || !wikiProject?.path || exporting) return
    setExporting(true)
    setExportMessage(null)
    setExportMissingNodes([])
    setError(null)
    try {
      const destination = await pickDirectory()
      if (!destination) return
      const result = await exportGalRouteTree(
        wikiProject.path,
        destination,
        project,
        routeId,
      )
      setExportMissingNodes(result.missingNodes)
      setExportMessage(
        `已导出当前树：${result.nodeCount} 个节点，${result.terminalNodeCount} 个末节点`
        + (result.missingNodes.length > 0
          ? `，${result.missingNodes.length} 个节点缺少正文`
          : ""),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : "导出线路树失败")
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <Header
        busy={busy}
        exporting={exporting}
        onAddRoute={handleAddSpecialRoute}
        onExport={() => void handleExportAll()}
      />
      {exportMessage && (
        <div className="border-b bg-muted/50 px-3 py-2 text-[11px] text-muted-foreground">
          {exportMessage}
        </div>
      )}
      {exportMissingNodes.length > 0 && (
        <div className="border-b border-amber-500/20 bg-amber-500/5 px-3 py-2">
          <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-amber-300">
            <AlertTriangle className="h-3.5 w-3.5" />
            缺少正文的节点
          </div>
          <div className="max-h-28 space-y-1 overflow-y-auto pr-1">
            {exportMissingNodes.map((node) => (
              <button
                key={node.id}
                type="button"
                onClick={() => {
                  selectRoute(mainRouteId ?? node.routeId)
                  selectNode(node.id)
                  requestLocateNode(node.id)
                }}
                className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[11px] text-amber-100 hover:bg-amber-500/10"
                title={`点击定位节点：${node.id}`}
              >
                <Circle className="h-2 w-2 shrink-0 text-amber-300" />
                <span className="min-w-0 flex-1 truncate">{node.title || node.id}</span>
                <span className="shrink-0 text-[10px] text-amber-200/70">{node.id}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="flex-1 overflow-y-auto p-1">
        {routes.map((route) => {
          const isMainRoute = route.id === mainRouteId
          const isPathRoute = !isMainRoute && Array.isArray(route.nodeIds)
          const pathNodes = isPathRoute
            ? (route.nodeIds ?? [])
                .map((nodeId) => mainNodeById.get(nodeId))
                .filter((node): node is GalNode => Boolean(node))
            : []
          const sectionRoute = isPathRoute ? { ...route, nodes: pathNodes } : route
          return (
            <RouteSection
              key={route.id}
              route={sectionRoute}
              isMainRoute={isMainRoute}
              isPathRoute={isPathRoute}
              mainNodeById={mainNodeById}
              selectedRouteId={selectedRouteId}
              selectedNodeId={selectedNodeId}
              busy={busy}
              onSelectRoute={() => {
                selectRoute(route.id)
                if (isPathRoute) selectNode(null)
              }}
              onSelectNode={(nodeId) => {
                selectRoute(route.id)
                selectNode(nodeId)
              }}
              onExportTree={() => handleExportRouteTree(route.id)}
              onLocateNode={(nodeId) => {
                selectRoute(route.id)
                selectNode(null)
                requestLocateNode(nodeId)
              }}
              onAddLooseNode={handleAddLooseNode}
              onRename={(title) => updatePathRoute(route.id, { title })}
              onAppendNode={(nodeId) => {
                const currentNodeIds = Array.isArray(route.nodeIds) ? route.nodeIds : []
                updatePathRoute(route.id, {
                  nodeIds: [...currentNodeIds, nodeId],
                  entryNodeId: currentNodeIds[0] ?? nodeId,
                })
              }}
              onRemoveLast={() => {
                const currentNodeIds = Array.isArray(route.nodeIds) ? route.nodeIds : []
                updatePathRoute(route.id, {
                  nodeIds: currentNodeIds.slice(0, Math.max(1, currentNodeIds.length - 1)),
                })
              }}
              onSaveEntryPrompt={(entryPrompt) => updatePathRoute(route.id, { theme: entryPrompt })}
              onGenerateEntry={(entryPrompt) => handleGenerateRouteEntry(route.id, entryPrompt)}
              onDeleteRoute={() => handleDeletePathRoute(route.id)}
            />
          )
        })}
      </div>
    </div>
  )
}

function Header({
  busy,
  exporting,
  onAddRoute,
  onExport,
}: {
  busy: boolean
  exporting: boolean
  onAddRoute: () => void
  onExport: () => void
}) {
  return (
    <div className="flex items-center gap-2 border-b px-3 py-2">
      <GitBranch className="h-4 w-4 text-muted-foreground" />
      <span className="min-w-0 flex-1 text-sm font-medium">线路 & 节点</span>
      <button
        type="button"
        disabled={busy || exporting}
        onClick={onExport}
        className="inline-flex h-7 w-7 items-center justify-center rounded-md border hover:bg-accent disabled:opacity-40"
        title="导出全部线路与完整正文"
      >
        {exporting
          ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
          : <FileDown className="h-3.5 w-3.5" />}
      </button>
      <button
        type="button"
        disabled={busy || exporting}
        onClick={onAddRoute}
        className="inline-flex h-7 w-7 items-center justify-center rounded-md border hover:bg-accent disabled:opacity-40"
        title="新增线路路径"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

function RouteSection({
  route,
  isMainRoute,
  isPathRoute,
  mainNodeById,
  selectedRouteId,
  selectedNodeId,
  busy,
  onSelectRoute,
  onSelectNode,
  onExportTree,
  onLocateNode,
  onAddLooseNode,
  onRename,
  onAppendNode,
  onRemoveLast,
  onSaveEntryPrompt,
  onGenerateEntry,
  onDeleteRoute,
}: {
  route: GalRoute
  isMainRoute: boolean
  isPathRoute: boolean
  mainNodeById: Map<string, GalNode>
  selectedRouteId: string | null
  selectedNodeId: string | null
  busy: boolean
  onSelectRoute: () => void
  onSelectNode: (nodeId: string) => void
  onExportTree: () => void
  onLocateNode: (nodeId: string) => void
  onAddLooseNode: () => void
  onRename: (title: string) => void
  onAppendNode: (nodeId: string) => void
  onRemoveLast: () => void
  onSaveEntryPrompt: (entryPrompt: string) => void
  onGenerateEntry: (entryPrompt: string) => void
  onDeleteRoute: () => void
}) {
  const [expanded, setExpanded] = useState(true)
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState(route.title)
  const [entryPrompt, setEntryPrompt] = useState(route.theme ?? "")
  const nodes = isMainRoute ? sortNodes(route.nodes ?? []) : sortNodes(route.nodes ?? [])
  const candidateNodes = isPathRoute ? getNextPathCandidates(route, mainNodeById) : []
  const nodeById = useMemo(
    () => new Map((route.nodes ?? []).map((node) => [node.id, node])),
    [route.nodes],
  )
  const outgoingNodeById = isPathRoute ? mainNodeById : nodeById

  useEffect(() => {
    setRenameValue(route.title)
  }, [route.title])

  useEffect(() => {
    setEntryPrompt(route.theme ?? "")
  }, [route.theme])

  return (
    <div>
      <button
        type="button"
        onClick={() => {
          onSelectRoute()
          setExpanded(!expanded)
        }}
        className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
          selectedRouteId === route.id
            ? "bg-accent text-accent-foreground"
            : "text-foreground hover:bg-accent/50"
        }`}
      >
        {expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
        <span className="flex-1 truncate font-medium">{isMainRoute ? "主线路" : route.title}</span>
        <span className="text-xs text-muted-foreground">{nodes.length}</span>
      </button>

      {expanded && (
        <div className="ml-4 border-l pl-2">
          {isMainRoute ? (
            <div className="space-y-1 py-1">
              <button
                type="button"
                disabled={busy}
                onClick={onAddLooseNode}
                className="inline-flex w-full items-center justify-center gap-1 rounded-md border px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent disabled:opacity-40"
              >
                <Plus className="h-3 w-3" />
                空节点
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={onExportTree}
                className="inline-flex w-full items-center justify-center gap-1 rounded-md border px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent disabled:opacity-40"
                title="Export current route tree"
              >
                <FileDown className="h-3 w-3" />
                导出此树
              </button>
            </div>
          ) : (
            <div className="space-y-1 py-1">
              {renaming ? (
                <form
                  className="flex gap-1"
                  onSubmit={(event) => {
                    event.preventDefault()
                    const title = renameValue.trim()
                    if (title) onRename(title)
                    setRenaming(false)
                  }}
                >
                  <input
                    value={renameValue}
                    onChange={(event) => setRenameValue(event.target.value)}
                    className="h-7 min-w-0 flex-1 rounded border bg-background px-2 text-xs"
                    autoFocus
                  />
                  <button type="submit" className="rounded border px-2 text-[11px] hover:bg-accent">保存</button>
                </form>
              ) : (
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => {
                      setRenameValue(route.title)
                      setRenaming(true)
                    }}
                    className="min-w-0 flex-1 rounded-md border px-2 py-1 text-left text-[11px] text-muted-foreground hover:bg-accent"
                  >
                    改名：{route.title}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={onExportTree}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md border text-muted-foreground hover:bg-accent disabled:opacity-40"
                    title="Export current route tree"
                  >
                    <FileDown className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={onDeleteRoute}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-destructive/30 text-destructive hover:bg-destructive/10 disabled:opacity-40"
                    title="删除线路路径"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
              {isPathRoute ? (
                <div className="flex items-center gap-1">
                  <select
                    disabled={busy || candidateNodes.length === 0}
                    className="h-7 min-w-0 flex-1 rounded border bg-background px-2 text-xs"
                    defaultValue=""
                    onChange={(event) => {
                      const nodeId = event.target.value
                      event.currentTarget.value = ""
                      if (nodeId) onAppendNode(nodeId)
                    }}
                  >
                    <option value="">选择下一个主线节点</option>
                    {candidateNodes.map((node) => (
                      <option key={node.id} value={node.id}>{node.title}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    disabled={busy || (route.nodeIds?.length ?? 0) <= 1}
                    onClick={onRemoveLast}
                    className="rounded border px-2 py-1 text-[11px] hover:bg-accent disabled:opacity-40"
                    title="移除路径末尾节点"
                  >
                    退一步
                  </button>
                </div>
              ) : (
                <div className="space-y-1 rounded-md border border-dashed p-2">
                  <div className="text-[11px] font-medium text-muted-foreground">
                    入口提示词
                  </div>
                  <textarea
                    value={entryPrompt}
                    onChange={(event) => setEntryPrompt(event.target.value)}
                    placeholder="描述这条特殊线路的入口事件、人物状态、场景和想要的剧情方向..."
                    className="min-h-20 w-full resize-y rounded border bg-background px-2 py-1.5 text-xs"
                  />
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => onSaveEntryPrompt(entryPrompt.trim())}
                      className="rounded border px-2 py-1 text-[11px] hover:bg-accent disabled:opacity-40"
                    >
                      保存提示词
                    </button>
                    <button
                      type="button"
                      disabled={busy || nodes.length > 0 || entryPrompt.trim().length === 0}
                      onClick={() => onGenerateEntry(entryPrompt)}
                      className="inline-flex items-center gap-1 rounded border px-2 py-1 text-[11px] hover:bg-accent disabled:opacity-40"
                      title={nodes.length > 0 ? "该线路已经有入口节点" : "基于提示词生成独立线路入口"}
                    >
                      <Sparkles className="h-3 w-3" />
                      生成入口
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {nodes.map((node, index) => {
            const unfinishedTerminal = isUnfinishedTerminalNode(node, outgoingNodeById, route)
            const nodeTitleColor = unfinishedTerminal
              ? "font-semibold text-orange-300"
              : getNodeTypeColor(node.type)
            return (
            <div
              key={`${node.id}-${index}`}
              className={`flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs transition-colors ${
                selectedNodeId === node.id && !isPathRoute
                  ? "bg-primary/10 text-primary"
                  : "text-foreground hover:bg-accent/50"
              }`}
            >
              <button
                type="button"
                onClick={() => onSelectNode(node.id)}
                onContextMenu={(event) => {
                  if (isPathRoute) return
                  event.preventDefault()
                  onLocateNode(node.id)
                }}
                className={`flex min-w-0 flex-1 items-center gap-1.5 text-left ${isPathRoute ? "cursor-default" : ""}`}
                title={isPathRoute ? undefined : "左键编辑，右键在画布中定位"}
              >
                <Circle className={`h-2 w-2 shrink-0 ${unfinishedTerminal ? "text-orange-300" : "text-muted-foreground/50"}`} />
                <span className={`truncate ${nodeTitleColor}`}>{node.title}</span>
              </button>
              {isPathRoute && index < nodes.length - 1 && (
                <span className="text-[10px] text-muted-foreground">→</span>
              )}
              {unfinishedTerminal && (
                <span className="shrink-0 text-[10px] font-semibold text-orange-300">!</span>
              )}
              {!isPathRoute && node.status !== "card" && (
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {node.status === "final" ? "✓" : "•"}
                </span>
              )}
            </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function createUniqueRouteId(routes: GalRoute[]): string {
  const existing = new Set(routes.map((route) => route.id))
  let routeId = `route_${Date.now().toString(36)}`
  while (existing.has(routeId)) {
    routeId = `route_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
  }
  return routeId
}

function createUniqueRouteNodeId(routeId: string, routes: GalRoute[]): string {
  const existing = new Set(routes.flatMap((route) => (route.nodes ?? []).map((node) => node.id)))
  let nodeId = `${routeId}_entry`
  if (!existing.has(nodeId)) return nodeId
  nodeId = `${routeId}_entry_${Date.now().toString(36)}`
  while (existing.has(nodeId)) {
    nodeId = `${routeId}_entry_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
  }
  return nodeId
}

function createRouteEntryNode(
  route: GalRoute,
  entryPrompt: string,
  now: string,
  routes: GalRoute[],
): GalNode {
  const nodeId = createUniqueRouteNodeId(route.id, routes)
  return {
    id: nodeId,
    routeId: route.id,
    title: route.title || "新线路入口",
    type: "entry",
    status: "card",
    parents: [],
    children: [],
    goal: entryPrompt,
    summary: entryPrompt,
    scriptPath: `nodes/${route.id}/${nodeId}.md`,
    incomingState: createEmptyStateSnapshot(),
    choices: [],
    memoryScope: "route",
    characters: [],
    scene: "",
    aiPrompt: entryPrompt,
    clueIds: [],
    sequence: 1,
    createdAt: now,
    updatedAt: now,
  }
}

function createEmptyStateSnapshot(): GalNode["incomingState"] {
  return {
    variables: {},
    characterCognition: {},
    acquiredClueIds: [],
    seenCgIds: [],
    visitedNodeIds: [],
    currentScene: "",
    characterMoods: {},
  }
}

function getNextPathCandidates(route: GalRoute, mainNodeById: Map<string, GalNode>): GalNode[] {
  const nodeIds = Array.isArray(route.nodeIds) ? route.nodeIds : []
  const lastNodeId = nodeIds[nodeIds.length - 1]
  if (!lastNodeId) return []
  const lastNode = mainNodeById.get(lastNodeId)
  if (!lastNode) return []
  const nextIds = Array.from(new Set([
    ...(lastNode.children ?? []),
    ...(lastNode.choices ?? [])
      .map((choice) => choice.nextNodeId)
      .filter((id): id is string => Boolean(id)),
  ]))
  return nextIds
    .filter((nodeId) => !nodeIds.includes(nodeId))
    .map((nodeId) => mainNodeById.get(nodeId))
    .filter((node): node is GalNode => Boolean(node))
}

function sortNodes(nodes: GalNode[]): GalNode[] {
  return [...nodes].sort((a, b) => {
    if (a.type === "entry" && b.type !== "entry") return -1
    if (b.type === "entry" && a.type !== "entry") return 1
    return (a.sequence || 0) - (b.sequence || 0)
  })
}

function isUnfinishedTerminalNode(
  node: GalNode,
  nodeById: Map<string, GalNode>,
  route: GalRoute,
): boolean {
  const isEnding = node.type === "ending" || (route.endingNodeIds ?? []).includes(node.id)
  return !isEnding && !hasNodeOutgoingTarget(node, nodeById)
}
