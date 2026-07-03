import { useMemo, useState } from "react"
import { ChevronDown, ChevronRight, Circle, GitBranch, Plus, Trash2 } from "lucide-react"
import { useGalStore } from "@/stores/gal-store"
import { useWikiStore } from "@/stores/wiki-store"
import { loadGalProject, saveGalProject } from "@/lib/gal/gal-storage"
import { getNodeTypeColor } from "./gal-utils"
import type { GalNode, GalRoute } from "@/lib/gal/gal-types"

export function GalRouteTree() {
  const wikiProject = useWikiStore((s) => s.project)
  const project = useGalStore((s) => s.project)
  const selectedRouteId = useGalStore((s) => s.selectedRouteId)
  const selectedNodeId = useGalStore((s) => s.selectedNodeId)
  const selectRoute = useGalStore((s) => s.selectRoute)
  const selectNode = useGalStore((s) => s.selectNode)
  const setProject = useGalStore((s) => s.setProject)
  const setError = useGalStore((s) => s.setError)
  const [busy, setBusy] = useState(false)

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
        <Header busy={busy} onAddRoute={() => {}} />
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

  const handleAddPathRoute = async () => {
    if (!project || !wikiProject?.path || busy) return
    setBusy(true)
    setError(null)
    try {
      const now = new Date().toISOString()
      const routeId = `path_${Date.now().toString(36)}`
      const entryId = mainRoute?.entryNodeId || mainRoute?.nodes[0]?.id || ""
      await persistProject({
        ...project,
        routes: [
          ...routes,
          {
            id: routeId,
            title: "新线路",
            theme: "主线路节点路径",
            nodeIds: entryId ? [entryId] : [],
            entryNodeId: entryId,
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

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <Header busy={busy} onAddRoute={handleAddPathRoute} />
      <div className="flex-1 overflow-y-auto p-1">
        {routes.map((route) => {
          const isMainRoute = route.id === mainRouteId
          const pathNodes = Array.isArray(route.nodeIds)
            ? route.nodeIds
                .map((nodeId) => mainNodeById.get(nodeId))
                .filter((node): node is GalNode => Boolean(node))
            : []
          const sectionRoute = isMainRoute ? route : { ...route, nodes: pathNodes }
          return (
            <RouteSection
              key={route.id}
              route={sectionRoute}
              isMainRoute={isMainRoute}
              mainNodeById={mainNodeById}
              selectedRouteId={selectedRouteId}
              selectedNodeId={selectedNodeId}
              busy={busy}
              onSelectRoute={() => {
                selectRoute(route.id)
                if (!isMainRoute) selectNode(null)
              }}
              onSelectNode={(nodeId) => {
                if (!isMainRoute) return
                selectRoute(route.id)
                selectNode(nodeId)
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
  onAddRoute,
}: {
  busy: boolean
  onAddRoute: () => void
}) {
  return (
    <div className="flex items-center gap-2 border-b px-3 py-2">
      <GitBranch className="h-4 w-4 text-muted-foreground" />
      <span className="min-w-0 flex-1 text-sm font-medium">线路 & 节点</span>
      <button
        type="button"
        disabled={busy}
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
  mainNodeById,
  selectedRouteId,
  selectedNodeId,
  busy,
  onSelectRoute,
  onSelectNode,
  onAddLooseNode,
  onRename,
  onAppendNode,
  onRemoveLast,
  onDeleteRoute,
}: {
  route: GalRoute
  isMainRoute: boolean
  mainNodeById: Map<string, GalNode>
  selectedRouteId: string | null
  selectedNodeId: string | null
  busy: boolean
  onSelectRoute: () => void
  onSelectNode: (nodeId: string) => void
  onAddLooseNode: () => void
  onRename: (title: string) => void
  onAppendNode: (nodeId: string) => void
  onRemoveLast: () => void
  onDeleteRoute: () => void
}) {
  const [expanded, setExpanded] = useState(true)
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState(route.title)
  const nodes = isMainRoute ? sortNodes(route.nodes ?? []) : (route.nodes ?? [])
  const candidateNodes = isMainRoute ? [] : getNextPathCandidates(route, mainNodeById)

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
            <div className="py-1">
              <button
                type="button"
                disabled={busy}
                onClick={onAddLooseNode}
                className="inline-flex w-full items-center justify-center gap-1 rounded-md border px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent disabled:opacity-40"
              >
                <Plus className="h-3 w-3" />
                空节点
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
                    重命名
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
            </div>
          )}

          {nodes.map((node, index) => (
            <div
              key={`${node.id}-${index}`}
              className={`flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs transition-colors ${
                selectedNodeId === node.id && isMainRoute
                  ? "bg-primary/10 text-primary"
                  : "text-foreground hover:bg-accent/50"
              }`}
            >
              <button
                type="button"
                onClick={() => onSelectNode(node.id)}
                className={`flex min-w-0 flex-1 items-center gap-1.5 text-left ${isMainRoute ? "" : "cursor-default"}`}
              >
                <Circle className="h-2 w-2 shrink-0 text-muted-foreground/50" />
                <span className={`truncate ${getNodeTypeColor(node.type)}`}>{node.title}</span>
              </button>
              {!isMainRoute && index < nodes.length - 1 && (
                <span className="text-[10px] text-muted-foreground">→</span>
              )}
              {isMainRoute && node.status !== "card" && (
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {node.status === "final" ? "✓" : "•"}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
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
