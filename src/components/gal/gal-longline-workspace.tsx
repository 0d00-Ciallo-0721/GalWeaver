import { useEffect, useMemo, useState } from "react"
import { AlertTriangle, ArrowLeft, BookOpen, GitBranch, Lock, RefreshCw, Sparkles } from "lucide-react"
import { useGalStore, type GalBoardHighlightState } from "@/stores/gal-store"
import { useWikiStore } from "@/stores/wiki-store"
import { detectGalLonglineRange, type GalLonglineRange, type GalLonglineStop } from "@/lib/gal/gal-longline-range"
import {
  generateGalLonglineOptimizationPlan,
  type GalLonglineNodeOptimization,
  type GalLonglineOptimizationPlan,
  type GalLonglineOptimizeMode,
  type GalLonglineSuggestedNodeInsertion,
} from "@/lib/gal/gal-longline-optimization"
import { reviewGalLongline, type GalLonglineReviewReport } from "@/lib/gal/gal-longline-review"
import { deleteNodeScript, loadGalProject, loadNodeScript, saveGalProject, saveNodeScript } from "@/lib/gal/gal-storage"
import type { GalChoice, GalNode, GalNodeStatus, GalRoute, GalStateSnapshot } from "@/lib/gal/gal-types"
import { GalRouteBoard } from "./gal-route-board"

interface GalLonglineWorkspaceProps {
  route: GalRoute | undefined
  startNodeId: string
  onBackToBoard: () => void
  onBackToEditor: (nodeId: string) => void
}

type ChainItem = {
  node: GalNode
  role: "upstream" | "target" | "downstream"
}

type OptimizationDecision = "pending" | "accept" | "keep" | "regenerate"
type AppliedSnapshot = {
  routeId: string
  nodeId: string
  oldScript: string
  oldStatus: GalNodeStatus
  oldUpdatedAt: string
}
type AppliedInsertionSnapshot = {
  suggestionId: string
  routeId: string
  newNodeId: string
  afterNodeId: string
  beforeNodeId: string
  afterChildren: string[]
  afterChoices: GalChoice[]
  afterUpdatedAt: string
  beforeParents: string[]
  beforeUpdatedAt: string
  routeSequences: Array<{ nodeId: string; sequence: number }>
  routeNodeIds: Record<string, string[]>
}

export function GalLonglineWorkspace({
  route,
  startNodeId,
  onBackToBoard,
  onBackToEditor,
}: GalLonglineWorkspaceProps) {
  const wikiProject = useWikiStore((s) => s.project)
  const galStore = useGalStore()
  const range = useMemo(
    () => route ? detectGalLonglineRange(route, startNodeId) : null,
    [route, startNodeId],
  )
  const chainItems = useMemo<ChainItem[]>(() => {
    if (!range) return []
    return [
      ...(range.upstreamBoundary ? [{ node: range.upstreamBoundary, role: "upstream" as const }] : []),
      ...range.targetNodes.map((node) => ({ node, role: "target" as const })),
      ...(range.downstreamBoundary ? [{ node: range.downstreamBoundary, role: "downstream" as const }] : []),
    ]
  }, [range])
  const [activeNodeId, setActiveNodeId] = useState(startNodeId)
  const [scripts, setScripts] = useState<Record<string, string>>({})
  const [loadingScripts, setLoadingScripts] = useState(false)
  const [reviewReport, setReviewReport] = useState<GalLonglineReviewReport | null>(null)
  const [reviewError, setReviewError] = useState<string | null>(null)
  const [reviewing, setReviewing] = useState(false)
  const [optimizeMode, setOptimizeMode] = useState<GalLonglineOptimizeMode>("problem_nodes")
  const [optimizationPlan, setOptimizationPlan] = useState<GalLonglineOptimizationPlan | null>(null)
  const [optimizationError, setOptimizationError] = useState<string | null>(null)
  const [optimizing, setOptimizing] = useState(false)
  const [optimizationDecisions, setOptimizationDecisions] = useState<Record<string, OptimizationDecision>>({})
  const [appliedSnapshots, setAppliedSnapshots] = useState<Record<string, AppliedSnapshot>>({})
  const [applying, setApplying] = useState(false)
  const [applyMessage, setApplyMessage] = useState<string | null>(null)
  const [applyError, setApplyError] = useState<string | null>(null)
  const [discardedInsertionIds, setDiscardedInsertionIds] = useState<string[]>([])
  const [appliedInsertionIds, setAppliedInsertionIds] = useState<string[]>([])
  const [appliedInsertionSnapshots, setAppliedInsertionSnapshots] = useState<Record<string, AppliedInsertionSnapshot>>({})

  useEffect(() => {
    if (!chainItems.some((item) => item.node.id === activeNodeId)) {
      setActiveNodeId(range?.targetNodes[0]?.id ?? chainItems[0]?.node.id ?? startNodeId)
    }
  }, [activeNodeId, chainItems, range?.targetNodes, startNodeId])

  useEffect(() => {
    if (!range) {
      galStore.clearBoardHighlight()
      return
    }
    galStore.setBoardHighlight(buildLonglineBoardHighlight(
      range,
      reviewReport,
      optimizationPlan,
      new Set(discardedInsertionIds),
      new Set(appliedInsertionIds),
    ))
    return () => galStore.clearBoardHighlight()
  }, [range, reviewReport, optimizationPlan, discardedInsertionIds, appliedInsertionIds])

  useEffect(() => {
    if (!wikiProject?.path || chainItems.length === 0) {
      setScripts({})
      return
    }
    let cancelled = false
    const loadScripts = async () => {
      setLoadingScripts(true)
      try {
        const entries = await Promise.all(chainItems.map(async ({ node }) => {
          const script = await loadNodeScript(wikiProject.path, node.routeId, node.id)
          return [node.id, script ?? ""] as const
        }))
        if (!cancelled) setScripts(Object.fromEntries(entries))
      } finally {
        if (!cancelled) setLoadingScripts(false)
      }
    }
    void loadScripts()
    return () => { cancelled = true }
  }, [wikiProject?.path, chainItems])

  const activeItem = chainItems.find((item) => item.node.id === activeNodeId)
  const activeScript = activeItem ? scripts[activeItem.node.id] ?? "" : ""
  const activeOptimization = activeItem
    ? optimizationPlan?.nodeOptimizations.find((item) => item.nodeId === activeItem.node.id) ?? null
    : null
  const handleReview = async () => {
    if (!route || !range || !galStore.project) return
    setReviewing(true)
    setReviewError(null)
    try {
      const report = await galStore.runAiTask(
        {
          title: "AI 检查长线剧情",
          detail: "正在分析长线节点正文与上下游边界...",
        },
        async (task) => {
          task.update("正在整理长线剧情上下文...")
          const result = await reviewGalLongline({
            project: galStore.project!,
            route,
            upstreamBoundary: range.upstreamBoundary
              ? { node: range.upstreamBoundary, script: scripts[range.upstreamBoundary.id] ?? "" }
              : null,
            targetNodes: range.targetNodes.map((node) => ({ node, script: scripts[node.id] ?? "" })),
            downstreamBoundary: range.downstreamBoundary
              ? { node: range.downstreamBoundary, script: scripts[range.downstreamBoundary.id] ?? "" }
              : null,
          })
          task.update("检查报告已生成。")
          return result
        },
      )
      setReviewReport(report)
    } catch (err) {
      setReviewError(err instanceof Error ? err.message : String(err))
    } finally {
      setReviewing(false)
    }
  }
  const handleGenerateOptimization = async () => {
    if (!route || !range || !galStore.project) return
    setOptimizing(true)
    setOptimizationError(null)
    try {
      const plan = await galStore.runAiTask(
        {
          title: optimizeMode === "story_enhance" ? "生成剧情增强方案" : "生成长线优化方案",
          detail: optimizeMode === "story_enhance"
            ? "正在增强长线剧情连贯性与体验感，不会保存项目..."
            : "正在生成正文优化预览，不会保存项目...",
        },
        async (task) => {
          task.update(optimizeMode === "story_enhance" ? "正在组织剧情增强上下文..." : "正在组织长线优化上下文...")
          const result = await generateGalLonglineOptimizationPlan({
            project: galStore.project!,
            route,
            mode: optimizeMode,
            reviewReport,
            upstreamBoundary: range.upstreamBoundary
              ? { node: range.upstreamBoundary, script: scripts[range.upstreamBoundary.id] ?? "" }
              : null,
            targetNodes: range.targetNodes.map((node) => ({ node, script: scripts[node.id] ?? "" })),
            downstreamBoundary: range.downstreamBoundary
              ? { node: range.downstreamBoundary, script: scripts[range.downstreamBoundary.id] ?? "" }
              : null,
          })
          task.update(optimizeMode === "story_enhance" ? "剧情增强方案已生成。" : "优化方案已生成。")
          return result
        },
      )
      setOptimizationPlan(plan)
      setOptimizationDecisions(Object.fromEntries(plan.nodeOptimizations.map((item) => [item.nodeId, "pending"])))
      setDiscardedInsertionIds([])
      setAppliedInsertionIds([])
    } catch (err) {
      setOptimizationError(err instanceof Error ? err.message : String(err))
    } finally {
      setOptimizing(false)
    }
  }
  const setOptimizationDecision = (nodeId: string, decision: OptimizationDecision) => {
    setOptimizationDecisions((prev) => ({ ...prev, [nodeId]: decision }))
  }
  const applyOptimizations = async (mode: "selected" | "all") => {
    if (!wikiProject?.path || !route || !range || !optimizationPlan) return
    const targetIds = new Set(range.targetNodes.map((node) => node.id))
    const selected = optimizationPlan.nodeOptimizations.filter((item) =>
      targetIds.has(item.nodeId)
      && (mode === "all" || optimizationDecisions[item.nodeId] === "accept")
      && item.optimizedScript.trim(),
    )
    if (selected.length === 0) {
      setApplyError(mode === "all" ? "当前没有可应用的优化正文。" : "请先选择要采用优化的节点。")
      return
    }
    const confirmed = window.confirm(`将写回 ${selected.length} 个目标节点正文。边界节点不会被修改。是否继续？`)
    if (!confirmed) return

    setApplying(true)
    setApplyError(null)
    setApplyMessage(null)
    try {
      const latestProject = await loadGalProject(wikiProject.path)
      if (!latestProject) throw new Error("未找到 Gal 项目")
      const snapshots: Record<string, AppliedSnapshot> = {}
      const now = new Date().toISOString()

      for (const item of selected) {
        const node = findProjectNode(latestProject.routes, item.nodeId)
        if (!node || !targetIds.has(node.id)) continue
        snapshots[node.id] = {
          routeId: node.routeId,
          nodeId: node.id,
          oldScript: scripts[node.id] ?? "",
          oldStatus: node.status,
          oldUpdatedAt: node.updatedAt,
        }
        await saveNodeScript(wikiProject.path, node.routeId, node.id, item.optimizedScript)
        node.status = "draft"
        node.updatedAt = now
      }

      latestProject.updatedAt = now
      await saveGalProject(wikiProject.path, latestProject)
      const refreshed = await loadGalProject(wikiProject.path)
      galStore.setProject(refreshed)
      setScripts((prev) => ({
        ...prev,
        ...Object.fromEntries(selected.map((item) => [item.nodeId, item.optimizedScript])),
      }))
      setAppliedSnapshots((prev) => ({ ...prev, ...snapshots }))
      setApplyMessage(`已应用 ${Object.keys(snapshots).length} 个节点优化。`)
    } catch (err) {
      setApplyError(err instanceof Error ? err.message : String(err))
    } finally {
      setApplying(false)
    }
  }
  const applySuggestedInsertion = async (suggestion: GalLonglineSuggestedNodeInsertion) => {
    if (!wikiProject?.path || !range) return
    const targetPairs = new Set(range.targetNodes.slice(0, -1).map((node, index) => `${node.id}->${range.targetNodes[index + 1].id}`))
    if (!targetPairs.has(`${suggestion.afterNodeId}->${suggestion.beforeNodeId}`)) {
      setApplyError("只能在目标长线节点内部插入过渡节点。")
      return
    }
    const confirmed = window.confirm(`将在「${suggestion.afterNodeId}」和「${suggestion.beforeNodeId}」之间插入过渡节点「${suggestion.title}」。是否继续？`)
    if (!confirmed) return

    setApplying(true)
    setApplyError(null)
    setApplyMessage(null)
    try {
      const latestProject = await loadGalProject(wikiProject.path)
      if (!latestProject) throw new Error("未找到 Gal 项目")
      const afterNode = findProjectNode(latestProject.routes, suggestion.afterNodeId)
      const beforeNode = findProjectNode(latestProject.routes, suggestion.beforeNodeId)
      if (!afterNode || !beforeNode) throw new Error("未找到插入位置的前后节点")
      if (afterNode.routeId !== beforeNode.routeId) throw new Error("插入失败：前后节点不在同一真实线路中")
      const latestAfterTargets = getNodeLinkedTargetIds(afterNode)
      if (latestAfterTargets.length !== 1 || latestAfterTargets[0] !== beforeNode.id || beforeNode.parents.length !== 1 || beforeNode.parents[0] !== afterNode.id) {
        throw new Error("插入失败：前后节点当前不是单线直连关系")
      }
      const routeToSave = latestProject.routes.find((item) => item.id === afterNode.routeId)
      if (!routeToSave) throw new Error("未找到要写入的线路")

      const now = new Date().toISOString()
      const newNodeId = createInsertionNodeId(routeToSave, suggestion.title)
      const insertionSnapshot: AppliedInsertionSnapshot = {
        suggestionId: suggestion.id,
        routeId: routeToSave.id,
        newNodeId,
        afterNodeId: afterNode.id,
        beforeNodeId: beforeNode.id,
        afterChildren: [...(afterNode.children ?? [])],
        afterChoices: cloneChoices(afterNode.choices ?? []),
        afterUpdatedAt: afterNode.updatedAt,
        beforeParents: [...(beforeNode.parents ?? [])],
        beforeUpdatedAt: beforeNode.updatedAt,
        routeSequences: routeToSave.nodes.map((node) => ({
          nodeId: node.id,
          sequence: node.sequence ?? 0,
        })),
        routeNodeIds: Object.fromEntries(
          latestProject.routes
            .filter((item) => hasAdjacentNodeIds(item.nodeIds, afterNode.id, beforeNode.id))
            .map((item) => [item.id, [...item.nodeIds!]]),
        ),
      }
      const newSequence = afterNode.sequence + 1
      for (const node of routeToSave.nodes) {
        if ((node.sequence ?? 0) >= newSequence) node.sequence = (node.sequence ?? 0) + 1
      }
      const newChoice: GalChoice = {
        id: `choice_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        text: "继续",
        emotionalIntent: "推进连续剧情",
        effects: [],
        nextNodeId: beforeNode.id,
        nextNodeTitle: beforeNode.title,
        nextNodeGoal: beforeNode.goal,
      }
      const newNode: GalNode = {
        id: newNodeId,
        routeId: routeToSave.id,
        title: suggestion.title,
        type: "daily",
        status: "draft",
        parents: [afterNode.id],
        children: [beforeNode.id],
        goal: suggestion.goal,
        summary: suggestion.summary,
        boardPosition: midpointPosition(afterNode, beforeNode),
        scriptPath: `nodes/${routeToSave.id}/${newNodeId}.md`,
        incomingState: cloneStateSnapshot(beforeNode.incomingState),
        choices: [newChoice],
        memoryScope: "node",
        characters: Array.from(new Set([...(afterNode.characters ?? []), ...(beforeNode.characters ?? [])])),
        scene: beforeNode.scene || afterNode.scene,
        clueIds: [],
        sequence: newSequence,
        createdAt: now,
        updatedAt: now,
      }

      for (const choice of afterNode.choices ?? []) {
        if (choice.nextNodeId === beforeNode.id) {
          choice.nextNodeId = newNode.id
          choice.nextNodeTitle = newNode.title
          choice.nextNodeGoal = newNode.goal
        }
      }
      afterNode.children = afterNode.children.map((childId) => childId === beforeNode.id ? newNode.id : childId)
      beforeNode.parents = beforeNode.parents.map((parentId) => parentId === afterNode.id ? newNode.id : parentId)
      afterNode.updatedAt = now
      beforeNode.updatedAt = now
      routeToSave.nodes.push(newNode)

      for (const pathRoute of latestProject.routes) {
        if (!Array.isArray(pathRoute.nodeIds)) continue
        const nextNodeIds: string[] = []
        for (let index = 0; index < pathRoute.nodeIds.length; index += 1) {
          const nodeId = pathRoute.nodeIds[index]
          nextNodeIds.push(nodeId)
          if (nodeId === afterNode.id && pathRoute.nodeIds[index + 1] === beforeNode.id) {
            nextNodeIds.push(newNode.id)
          }
        }
        pathRoute.nodeIds = nextNodeIds
      }

      latestProject.updatedAt = now
      await saveNodeScript(wikiProject.path, routeToSave.id, newNode.id, suggestion.script)
      await saveGalProject(wikiProject.path, latestProject)
      const refreshed = await loadGalProject(wikiProject.path)
      galStore.setProject(refreshed)
      galStore.selectNode(newNode.id)
      setScripts((prev) => ({ ...prev, [newNode.id]: suggestion.script }))
      setAppliedInsertionIds((prev) => Array.from(new Set([...prev, suggestion.id])))
      setAppliedInsertionSnapshots((prev) => ({ ...prev, [suggestion.id]: insertionSnapshot }))
      setActiveNodeId(newNode.id)
      setApplyMessage(`已插入过渡节点「${newNode.title}」。`)
    } catch (err) {
      setApplyError(err instanceof Error ? err.message : String(err))
    } finally {
      setApplying(false)
    }
  }
  const undoAppliedInsertion = async (suggestionId: string) => {
    if (!wikiProject?.path) return
    const snapshot = appliedInsertionSnapshots[suggestionId]
    if (!snapshot) return
    const confirmed = window.confirm("将删除本次新增的过渡节点，并恢复插入前的前后节点连接。是否继续？")
    if (!confirmed) return

    setApplying(true)
    setApplyError(null)
    setApplyMessage(null)
    try {
      const latestProject = await loadGalProject(wikiProject.path)
      if (!latestProject) throw new Error("未找到 Gal 项目")
      const routeToSave = latestProject.routes.find((item) => item.id === snapshot.routeId)
      if (!routeToSave) throw new Error("未找到要撤回的线路")
      const newNode = routeToSave.nodes.find((node) => node.id === snapshot.newNodeId)
      const afterNode = routeToSave.nodes.find((node) => node.id === snapshot.afterNodeId)
      const beforeNode = routeToSave.nodes.find((node) => node.id === snapshot.beforeNodeId)
      if (!newNode || !afterNode || !beforeNode) {
        throw new Error("撤回失败：新增节点或前后节点已不存在")
      }
      if (
        newNode.parents.length !== 1
        || newNode.parents[0] !== afterNode.id
        || newNode.children.length !== 1
        || newNode.children[0] !== beforeNode.id
      ) {
        throw new Error("撤回失败：新增节点连接已被后续操作修改，请先处理后续改动")
      }

      afterNode.children = [...snapshot.afterChildren]
      afterNode.choices = cloneChoices(snapshot.afterChoices)
      afterNode.updatedAt = snapshot.afterUpdatedAt
      beforeNode.parents = [...snapshot.beforeParents]
      beforeNode.updatedAt = snapshot.beforeUpdatedAt

      const sequenceByNodeId = new Map(snapshot.routeSequences.map((item) => [item.nodeId, item.sequence]))
      routeToSave.nodes = routeToSave.nodes
        .filter((node) => node.id !== snapshot.newNodeId)
        .map((node) => ({
          ...node,
          sequence: sequenceByNodeId.get(node.id) ?? node.sequence,
        }))
      for (const pathRoute of latestProject.routes) {
        const oldNodeIds = snapshot.routeNodeIds[pathRoute.id]
        if (oldNodeIds) pathRoute.nodeIds = [...oldNodeIds]
      }

      latestProject.updatedAt = new Date().toISOString()
      await deleteNodeScript(wikiProject.path, snapshot.routeId, snapshot.newNodeId)
      await saveGalProject(wikiProject.path, latestProject)
      const refreshed = await loadGalProject(wikiProject.path)
      galStore.setProject(refreshed)
      galStore.selectNode(snapshot.afterNodeId)
      setScripts((prev) => {
        const next = { ...prev }
        delete next[snapshot.newNodeId]
        return next
      })
      setAppliedInsertionIds((prev) => prev.filter((id) => id !== suggestionId))
      setAppliedInsertionSnapshots((prev) => {
        const next = { ...prev }
        delete next[suggestionId]
        return next
      })
      setActiveNodeId(snapshot.afterNodeId)
      setApplyMessage("已撤回新增过渡节点，并恢复原连接。")
    } catch (err) {
      setApplyError(err instanceof Error ? err.message : String(err))
    } finally {
      setApplying(false)
    }
  }
  const undoAppliedOptimization = async (nodeId: string) => {
    if (!wikiProject?.path) return
    const snapshot = appliedSnapshots[nodeId]
    if (!snapshot) return
    const confirmed = window.confirm("将撤回本页面内保存的优化正文，恢复应用前正文。是否继续？")
    if (!confirmed) return

    setApplying(true)
    setApplyError(null)
    setApplyMessage(null)
    try {
      const latestProject = await loadGalProject(wikiProject.path)
      if (!latestProject) throw new Error("未找到 Gal 项目")
      const node = findProjectNode(latestProject.routes, snapshot.nodeId)
      if (!node) throw new Error("未找到要撤回的节点")
      await saveNodeScript(wikiProject.path, snapshot.routeId, snapshot.nodeId, snapshot.oldScript)
      node.status = snapshot.oldStatus
      node.updatedAt = snapshot.oldUpdatedAt
      latestProject.updatedAt = new Date().toISOString()
      await saveGalProject(wikiProject.path, latestProject)
      galStore.setProject(await loadGalProject(wikiProject.path))
      setScripts((prev) => ({ ...prev, [snapshot.nodeId]: snapshot.oldScript }))
      setAppliedSnapshots((prev) => {
        const next = { ...prev }
        delete next[snapshot.nodeId]
        return next
      })
      setApplyMessage("已撤回该节点优化。")
    } catch (err) {
      setApplyError(err instanceof Error ? err.message : String(err))
    } finally {
      setApplying(false)
    }
  }

  if (!route || !range) {
    return (
      <div className="flex h-full flex-col bg-background">
        <LonglineHeader
          title="长线剧情工作区"
          subtitle="未找到可用线路。"
          onBackToBoard={onBackToBoard}
          onBackToEditor={() => onBackToEditor(startNodeId)}
        />
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          当前线路不可用。
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <LonglineHeader
        title="长线剧情工作区"
        subtitle={buildRangeSummary(range.targetNodes.length, range.upstreamBoundary, range.downstreamBoundary)}
        reviewing={reviewing}
        optimizing={optimizing}
        optimizeMode={optimizeMode}
        onOptimizeModeChange={setOptimizeMode}
        onReview={handleReview}
        onGenerateOptimization={handleGenerateOptimization}
        onBackToBoard={onBackToBoard}
        onBackToEditor={() => onBackToEditor(activeItem?.node.id ?? startNodeId)}
      />
      <div className="grid min-h-0 flex-1 grid-cols-[280px_1fr_320px]">
        <aside className="min-h-0 overflow-y-auto border-r bg-muted/20 p-3">
          <div className="mb-2 text-xs font-medium text-muted-foreground">节点链</div>
          <div className="space-y-1">
            {chainItems.map((item, index) => (
              <button
                key={`${item.role}-${item.node.id}`}
                type="button"
                onClick={() => locateLonglineNode(item.node.id, setActiveNodeId, galStore)}
                className={`w-full rounded-md border px-2 py-2 text-left text-xs transition-colors ${
                  activeNodeId === item.node.id
                    ? "border-primary/40 bg-primary/10"
                    : "border-transparent hover:bg-accent"
                }`}
              >
                <div className="mb-1 flex items-center gap-1.5">
                  {item.role === "target" ? (
                    <GitBranch className="h-3.5 w-3.5 text-blue-400" />
                  ) : (
                    <Lock className="h-3.5 w-3.5 text-amber-400" />
                  )}
                  <span className="min-w-0 flex-1 truncate font-medium">{item.node.title || item.node.id}</span>
                  <span className="text-[10px] text-muted-foreground">{index + 1}</span>
                </div>
                <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                  <span>{roleLabel(item.role)}</span>
                  <span>·</span>
                  <span>{item.node.status}</span>
                  {item.role !== "target" && <span className="text-amber-300">只读边界</span>}
                </div>
              </button>
            ))}
          </div>
        </aside>

        <main className="min-h-0 overflow-y-auto p-4">
          <div className="mb-4 h-[360px] overflow-hidden rounded-md border bg-card">
            <GalRouteBoard
              route={route}
              selectedNodeId={activeNodeId}
              onSelectNode={(nodeId) => locateLonglineNode(nodeId, setActiveNodeId, galStore)}
              readOnly
            />
          </div>
          {activeItem ? (
            <div className="mx-auto max-w-4xl">
              <div className="mb-3 rounded-md border bg-card p-3">
                <div className="mb-2 flex items-center gap-2">
                  <BookOpen className="h-4 w-4 text-muted-foreground" />
                  <h2 className="min-w-0 flex-1 truncate text-base font-semibold">{activeItem.node.title}</h2>
                  <span className="rounded bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                    {roleLabel(activeItem.role)}
                  </span>
                </div>
                <div className="grid gap-2 text-xs text-muted-foreground md:grid-cols-2">
                  <div>目标：{activeItem.node.goal || "未填写"}</div>
                  <div>场景：{activeItem.node.scene || "未填写"}</div>
                  <div>父节点：{activeItem.node.parents.length || 0}</div>
                  <div>子节点：{activeItem.node.children.length || 0}</div>
                </div>
                {activeItem.node.summary && (
                  <div className="mt-2 rounded border bg-background/60 p-2 text-xs leading-5 text-muted-foreground">
                    {activeItem.node.summary}
                  </div>
                )}
              </div>
              <div className="rounded-md border bg-card">
                <div className="flex items-center gap-2 border-b px-3 py-2 text-xs text-muted-foreground">
                  <span className="font-medium">节点正文</span>
                  {loadingScripts && (
                    <>
                      <RefreshCw className="h-3 w-3 animate-spin" />
                      <span>读取中</span>
                    </>
                  )}
                  {activeItem.role !== "target" && (
                    <span className="ml-auto text-amber-300">只读边界正文</span>
                  )}
                </div>
                <pre className="min-h-[520px] whitespace-pre-wrap p-4 text-sm leading-7">
                  {activeScript.trim() || "该节点正文为空。"}
                </pre>
              </div>
              {activeOptimization && (
                <OptimizationCompare
                  item={activeOptimization}
                  decision={optimizationDecisions[activeOptimization.nodeId] ?? "pending"}
                  applied={Boolean(appliedSnapshots[activeOptimization.nodeId])}
                  onDecisionChange={(decision) => setOptimizationDecision(activeOptimization.nodeId, decision)}
                  onUndo={() => undoAppliedOptimization(activeOptimization.nodeId)}
                />
              )}
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              未选择节点。
            </div>
          )}
        </main>

        <aside className="min-h-0 overflow-y-auto border-l bg-muted/20 p-3">
          <div className="mb-3 rounded-md border bg-card p-3">
            <div className="mb-1 text-xs font-medium">范围摘要</div>
            <div className="text-xs leading-5 text-muted-foreground">
              {buildRangeSummary(range.targetNodes.length, range.upstreamBoundary, range.downstreamBoundary)}
            </div>
          </div>
          <div className="mb-3 rounded-md border bg-card p-3">
            <div className="mb-2 text-xs font-medium">停止原因</div>
            <div className="space-y-1">
              {range.stopReasons.length > 0 ? range.stopReasons.map((stop, index) => (
                <div key={index} className="rounded bg-muted/60 px-2 py-1.5 text-[11px] text-muted-foreground">
                  {stopLabel(stop)}
                </div>
              )) : (
                <div className="text-xs text-muted-foreground">无</div>
              )}
            </div>
          </div>
          <div className="rounded-md border bg-card p-3">
            <div className="mb-2 text-xs font-medium">提示</div>
            <div className="text-xs leading-5 text-muted-foreground">
              当前页面会先生成优化预览；只有点击应用按钮后，才会写回目标节点正文。
            </div>
          </div>
          <ReviewPanel
            report={reviewReport}
            error={reviewError}
            onSelectNode={(nodeId) => locateLonglineNode(nodeId, setActiveNodeId, galStore)}
          />
          <OptimizationPanel
            plan={optimizationPlan}
            error={optimizationError}
            decisions={optimizationDecisions}
            appliedNodeIds={new Set(Object.keys(appliedSnapshots))}
            applying={applying}
            message={applyMessage}
            applyError={applyError}
            onSelectNode={(nodeId) => locateLonglineNode(nodeId, setActiveNodeId, galStore)}
            onDecisionChange={setOptimizationDecision}
            onApplySelected={() => applyOptimizations("selected")}
            onApplyAll={() => applyOptimizations("all")}
            onUndo={undoAppliedOptimization}
            onApplyInsertion={applySuggestedInsertion}
            onUndoInsertion={undoAppliedInsertion}
            onDiscardInsertion={(id) => setDiscardedInsertionIds((prev) => Array.from(new Set([...prev, id])))}
            discardedInsertionIds={new Set(discardedInsertionIds)}
            appliedInsertionIds={new Set(appliedInsertionIds)}
          />
        </aside>
      </div>
    </div>
  )
}

function LonglineHeader({
  title,
  subtitle,
  reviewing,
  optimizing,
  optimizeMode,
  onOptimizeModeChange,
  onReview,
  onGenerateOptimization,
  onBackToBoard,
  onBackToEditor,
}: {
  title: string
  subtitle: string
  reviewing?: boolean
  optimizing?: boolean
  optimizeMode?: GalLonglineOptimizeMode
  onOptimizeModeChange?: (mode: GalLonglineOptimizeMode) => void
  onReview?: () => void
  onGenerateOptimization?: () => void
  onBackToBoard: () => void
  onBackToEditor: () => void
}) {
  return (
    <div className="flex items-center gap-2 border-b px-4 py-3">
      <GitBranch className="h-4 w-4 text-blue-400" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold">{title}</div>
        <div className="truncate text-xs text-muted-foreground">{subtitle}</div>
      </div>
      {onReview && (
        <button type="button" disabled={reviewing} onClick={onReview} className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-50">
          {reviewing ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
          AI 检查
        </button>
      )}
      {onGenerateOptimization && optimizeMode && onOptimizeModeChange && (
        <>
          <select
            value={optimizeMode}
            onChange={(event) => onOptimizeModeChange(event.target.value as GalLonglineOptimizeMode)}
            className="h-8 rounded-md border bg-background px-2 text-xs"
          >
            <option value="missing_only">只补缺失正文</option>
            <option value="problem_nodes">优化有问题节点</option>
            <option value="whole_range">优化整段长线</option>
            <option value="story_enhance">剧情增强/扩写长线</option>
          </select>
          <button type="button" disabled={optimizing} onClick={onGenerateOptimization} className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-50">
            {optimizing ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            生成优化方案
          </button>
        </>
      )}
      <button type="button" onClick={onBackToEditor} className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-xs hover:bg-accent">
        <ArrowLeft className="h-3.5 w-3.5" />
        返回编辑器
      </button>
      <button type="button" onClick={onBackToBoard} className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-xs hover:bg-accent">
        返回画布
      </button>
    </div>
  )
}

function buildRangeSummary(targetCount: number, upstream: GalNode | null, downstream: GalNode | null): string {
  return `上游边界：${upstream?.title || "无"}；目标节点：${targetCount} 个；下游边界：${downstream?.title || "无"}`
}

function findProjectNode(routes: GalRoute[], nodeId: string): GalNode | null {
  for (const route of routes) {
    const node = route.nodes.find((item) => item.id === nodeId)
    if (node) return node
  }
  return null
}

function cloneChoices(choices: GalChoice[]): GalChoice[] {
  return choices.map((choice) => ({
    ...choice,
    condition: choice.condition ? [...choice.condition] : undefined,
    effects: (choice.effects ?? []).map((effect) => ({ ...effect })),
  }))
}

function hasAdjacentNodeIds(
  nodeIds: string[] | undefined,
  afterNodeId: string,
  beforeNodeId: string,
): nodeIds is string[] {
  if (!Array.isArray(nodeIds)) return false
  return nodeIds.some((nodeId, index) => nodeId === afterNodeId && nodeIds[index + 1] === beforeNodeId)
}

function locateLonglineNode(
  nodeId: string,
  setActiveNodeId: (nodeId: string) => void,
  galStore: ReturnType<typeof useGalStore.getState>,
) {
  setActiveNodeId(nodeId)
  galStore.selectNode(nodeId)
  galStore.requestLocateNode(nodeId)
}

function buildLonglineBoardHighlight(
  range: GalLonglineRange,
  reviewReport: GalLonglineReviewReport | null,
  optimizationPlan: GalLonglineOptimizationPlan | null,
  discardedInsertionIds: Set<string>,
  appliedInsertionIds: Set<string>,
): GalBoardHighlightState {
  const nodes: GalBoardHighlightState["nodes"] = {}
  if (range.upstreamBoundary) {
    nodes[range.upstreamBoundary.id] = { role: "upstream", label: "上游边界" }
  }
  for (const node of range.targetNodes) {
    nodes[node.id] = { role: "target", label: "长线节点" }
  }
  if (range.downstreamBoundary) {
    nodes[range.downstreamBoundary.id] = { role: "downstream", label: "下游边界" }
  }
  if (reviewReport) {
    for (const item of reviewReport.missingScripts) {
      nodes[item.nodeId] = { role: "problem", label: "正文缺失" }
    }
    for (const item of reviewReport.issues) {
      nodes[item.nodeId] = {
        role: item.severity === "error" ? "error" : "problem",
        label: item.category || "剧情问题",
      }
    }
    for (const item of reviewReport.rewriteTargets) {
      nodes[item.nodeId] = nodes[item.nodeId]?.role === "error"
        ? nodes[item.nodeId]
        : { role: "problem", label: "建议改写" }
    }
  }
  return {
    nodes,
    previewInsertions: (optimizationPlan?.suggestedInsertions ?? [])
      .filter((item) => !discardedInsertionIds.has(item.id) && !appliedInsertionIds.has(item.id))
      .map((item) => ({
        id: item.id,
        afterNodeId: item.afterNodeId,
        beforeNodeId: item.beforeNodeId,
        title: item.title,
      })),
  }
}

function createInsertionNodeId(route: GalRoute, title: string): string {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 24) || "transition"
  let id = `node_${slug}_${Date.now().toString(36)}`
  while (route.nodes.some((node) => node.id === id)) {
    id = `node_${slug}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
  }
  return id
}

function cloneStateSnapshot(snapshot: GalStateSnapshot): GalStateSnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as GalStateSnapshot
}

function midpointPosition(afterNode: GalNode, beforeNode: GalNode): GalNode["boardPosition"] {
  if (!afterNode.boardPosition && !beforeNode.boardPosition) return undefined
  return {
    x: Math.round(((afterNode.boardPosition?.x ?? 0) + (beforeNode.boardPosition?.x ?? afterNode.boardPosition?.x ?? 0)) / 2),
    y: Math.round(((afterNode.boardPosition?.y ?? 0) + (beforeNode.boardPosition?.y ?? afterNode.boardPosition?.y ?? 0)) / 2),
  }
}

function getNodeLinkedTargetIds(node: GalNode): string[] {
  return Array.from(new Set([
    ...(node.children ?? []),
    ...(node.choices ?? [])
      .map((choice) => choice.nextNodeId)
      .filter((targetId): targetId is string => Boolean(targetId)),
  ]))
}

function roleLabel(role: ChainItem["role"]): string {
  if (role === "upstream") return "上游边界"
  if (role === "downstream") return "下游边界"
  return "长线节点"
}

function stopLabel(stop: GalLonglineStop): string {
  const direction = stop.direction === "upstream" ? "向上" : "向下"
  const related = stop.relatedNodeId ? `，边界/关联：${stop.relatedNodeId}` : ""
  return `${direction}停止：${stop.reason}${related}`
}

function ReviewPanel({
  report,
  error,
  onSelectNode,
}: {
  report: GalLonglineReviewReport | null
  error: string | null
  onSelectNode: (nodeId: string) => void
}) {
  return (
    <div className="mt-3 rounded-md border bg-card p-3">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-medium">
        <Sparkles className="h-3.5 w-3.5 text-blue-400" />
        AI 检查报告
      </div>
      {error && (
        <div className="mb-2 rounded border border-destructive/40 bg-destructive/10 p-2 text-xs leading-5 text-destructive">
          {error}
        </div>
      )}
      {!report ? (
        <div className="text-xs leading-5 text-muted-foreground">
          点击顶部“AI 检查”后，会在这里显示连续性报告。检查不会改写正文，也不会保存节点。
        </div>
      ) : (
        <div className="space-y-3 text-xs">
          <ReportSection title="范围结论">
            <p className="leading-5 text-muted-foreground">{report.rangeSummary}</p>
          </ReportSection>
          <ReportSection title={`正文缺失 (${report.missingScripts.length})`}>
            {report.missingScripts.length ? report.missingScripts.map((item) => (
              <ReportItem key={item.nodeId} title={item.title} detail={item.nodeId} tone="warning" onClick={() => onSelectNode(item.nodeId)} />
            )) : <EmptyReportText />}
          </ReportSection>
          <ReportSection title={`问题 (${report.issues.length})`}>
            {report.issues.length ? report.issues.map((item, index) => (
              <ReportItem key={`${item.nodeId}-${index}`} title={`${item.title || item.nodeId} · ${item.category || item.severity}`} detail={item.detail} tone={item.severity === "error" ? "error" : "warning"} onClick={() => onSelectNode(item.nodeId)} />
            )) : <EmptyReportText />}
          </ReportSection>
          <ReportSection title={`连续性断点 (${report.continuityBreaks.length})`}>
            {report.continuityBreaks.length ? report.continuityBreaks.map((item, index) => (
              <ReportItem key={`${item.fromNodeId}-${item.toNodeId}-${index}`} title={`${item.fromNodeId} → ${item.toNodeId} · ${item.type}`} detail={item.detail} tone="warning" onClick={() => onSelectNode(item.fromNodeId)} />
            )) : <EmptyReportText />}
          </ReportSection>
          <ReportSection title={`建议过渡节点 (${report.suggestedInsertions.length})`}>
            {report.suggestedInsertions.length ? report.suggestedInsertions.map((item, index) => (
              <ReportItem key={`${item.afterNodeId}-${item.beforeNodeId}-${index}`} title={item.title || `${item.afterNodeId} → ${item.beforeNodeId}`} detail={`${item.reason}\n目标：${item.goal}`} tone="info" />
            )) : <EmptyReportText />}
          </ReportSection>
          <ReportSection title={`建议改写目标 (${report.rewriteTargets.length})`}>
            {report.rewriteTargets.length ? report.rewriteTargets.map((item) => (
              <ReportItem key={item.nodeId} title={item.title || item.nodeId} detail={item.reason} tone="info" onClick={() => onSelectNode(item.nodeId)} />
            )) : <EmptyReportText />}
          </ReportSection>
        </div>
      )}
    </div>
  )
}

function OptimizationCompare({
  item,
  decision,
  applied,
  onDecisionChange,
  onUndo,
}: {
  item: GalLonglineNodeOptimization
  decision: OptimizationDecision
  applied: boolean
  onDecisionChange: (decision: OptimizationDecision) => void
  onUndo: () => void
}) {
  return (
    <div className="mt-3 rounded-md border bg-card">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2 text-xs">
        <div className="min-w-0 flex-1 font-medium">优化预览：{item.title}</div>
        <span className="rounded bg-muted px-2 py-0.5 text-muted-foreground">{suggestionLabel(item.suggestion)}</span>
        {applied && <span className="rounded bg-emerald-500/10 px-2 py-0.5 text-emerald-400">已应用</span>}
        <DecisionButtons decision={decision} onChange={onDecisionChange} />
        {applied && (
          <button type="button" onClick={onUndo} className="rounded border px-2 py-1 text-[11px] hover:bg-accent">
            撤回本页应用
          </button>
        )}
      </div>
      <div className="border-b px-3 py-2 text-xs leading-5 text-muted-foreground">
        修改原因：{item.reason || "AI 未说明修改原因。"}
      </div>
      <div className="grid min-h-[360px] grid-cols-2 divide-x">
        <div className="min-w-0">
          <div className="border-b px-3 py-2 text-xs font-medium text-muted-foreground">原正文</div>
          <pre className="max-h-[520px] overflow-auto whitespace-pre-wrap p-4 text-sm leading-7">
            {item.originalScript.trim() || "该节点原正文为空。"}
          </pre>
        </div>
        <div className="min-w-0">
          <div className="border-b px-3 py-2 text-xs font-medium text-muted-foreground">AI 优化正文</div>
          <pre className="max-h-[520px] overflow-auto whitespace-pre-wrap p-4 text-sm leading-7">
            {item.optimizedScript.trim() || "AI 未返回优化正文。"}
          </pre>
        </div>
      </div>
    </div>
  )
}

function OptimizationPanel({
  plan,
  error,
  decisions,
  appliedNodeIds,
  applying,
  message,
  applyError,
  onSelectNode,
  onDecisionChange,
  onApplySelected,
  onApplyAll,
  onUndo,
  onApplyInsertion,
  onUndoInsertion,
  onDiscardInsertion,
  discardedInsertionIds,
  appliedInsertionIds,
}: {
  plan: GalLonglineOptimizationPlan | null
  error: string | null
  decisions: Record<string, OptimizationDecision>
  appliedNodeIds: Set<string>
  applying: boolean
  message: string | null
  applyError: string | null
  onSelectNode: (nodeId: string) => void
  onDecisionChange: (nodeId: string, decision: OptimizationDecision) => void
  onApplySelected: () => void
  onApplyAll: () => void
  onUndo: (nodeId: string) => void
  onApplyInsertion: (suggestion: GalLonglineSuggestedNodeInsertion) => void
  onUndoInsertion: (suggestionId: string) => void
  onDiscardInsertion: (id: string) => void
  discardedInsertionIds: Set<string>
  appliedInsertionIds: Set<string>
}) {
  const acceptedCount = plan?.nodeOptimizations.filter((item) => decisions[item.nodeId] === "accept").length ?? 0
  const visibleInsertions = plan?.suggestedInsertions.filter((item) => !discardedInsertionIds.has(item.id)) ?? []
  return (
    <div className="mt-3 rounded-md border bg-card p-3">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-medium">
        <Sparkles className="h-3.5 w-3.5 text-emerald-400" />
        优化方案预览
      </div>
      {error && (
        <div className="mb-2 rounded border border-destructive/40 bg-destructive/10 p-2 text-xs leading-5 text-destructive">
          {error}
        </div>
      )}
      {applyError && (
        <div className="mb-2 rounded border border-destructive/40 bg-destructive/10 p-2 text-xs leading-5 text-destructive">
          {applyError}
        </div>
      )}
      {message && (
        <div className="mb-2 rounded border border-emerald-500/30 bg-emerald-500/10 p-2 text-xs leading-5 text-emerald-400">
          {message}
        </div>
      )}
      {!plan ? (
        <div className="text-xs leading-5 text-muted-foreground">
          点击顶部“生成优化方案”后，会在这里显示每个目标节点的优化预览。预览本身不会保存到磁盘。
        </div>
      ) : (
        <div className="space-y-3 text-xs">
          <div className="flex flex-wrap gap-1">
            <button type="button" disabled={applying || acceptedCount === 0} onClick={onApplySelected} className="rounded border px-2 py-1 text-[11px] hover:bg-accent disabled:opacity-50">
              {applying ? "保存中..." : `应用选中修改 (${acceptedCount})`}
            </button>
            <button type="button" disabled={applying || plan.nodeOptimizations.length === 0} onClick={onApplyAll} className="rounded border px-2 py-1 text-[11px] hover:bg-accent disabled:opacity-50">
              应用全部修改
            </button>
          </div>
          <ReportSection title="整体说明">
            <p className="leading-5 text-muted-foreground">{plan.summary}</p>
          </ReportSection>
          <ReportSection title={`节点优化 (${plan.nodeOptimizations.length})`}>
            {plan.nodeOptimizations.length ? plan.nodeOptimizations.map((item) => (
              <div key={item.nodeId} className="rounded border bg-muted/30 p-2">
                <button
                  type="button"
                  onClick={() => onSelectNode(item.nodeId)}
                  className="mb-1 block w-full truncate text-left font-medium hover:text-primary"
                >
                  {item.title || item.nodeId}
                </button>
                <div className="mb-2 line-clamp-3 leading-5 text-muted-foreground">{item.reason || "无修改原因"}</div>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="rounded bg-background px-2 py-0.5 text-[11px] text-muted-foreground">{suggestionLabel(item.suggestion)}</span>
                  <span className={`text-[11px] ${appliedNodeIds.has(item.nodeId) ? "text-emerald-400" : "text-muted-foreground"}`}>
                    {appliedNodeIds.has(item.nodeId) ? "已应用" : decisionLabel(decisions[item.nodeId] ?? "pending")}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  <DecisionButtons
                    decision={decisions[item.nodeId] ?? "pending"}
                    onChange={(decision) => onDecisionChange(item.nodeId, decision)}
                  />
                  {appliedNodeIds.has(item.nodeId) && (
                    <button type="button" disabled={applying} onClick={() => onUndo(item.nodeId)} className="rounded border px-2 py-1 text-[11px] hover:bg-accent disabled:opacity-50">
                      撤回
                    </button>
                  )}
                </div>
              </div>
            )) : <EmptyReportText />}
          </ReportSection>
          <ReportSection title={`建议新增节点 (${visibleInsertions.length})`}>
            {visibleInsertions.length ? visibleInsertions.map((item) => (
              <div key={item.id} className="rounded border bg-muted/30 p-2">
                <div className="mb-1 font-medium">{item.afterNodeId} → {item.title} → {item.beforeNodeId}</div>
                <div className="mb-1 text-muted-foreground">目标：{item.goal}</div>
                <div className="mb-1 text-muted-foreground">摘要：{item.summary}</div>
                <div className="mb-2 line-clamp-3 whitespace-pre-wrap text-muted-foreground">正文：{item.script}</div>
                <div className="mb-2 text-muted-foreground">原因：{item.reason || "AI 未说明原因"}</div>
                <div className="flex flex-wrap items-center gap-1">
                  {appliedInsertionIds.has(item.id) ? (
                    <>
                      <span className="rounded bg-emerald-500/10 px-2 py-1 text-[11px] text-emerald-400">已插入</span>
                      <button type="button" disabled={applying} onClick={() => onUndoInsertion(item.id)} className="rounded border px-2 py-1 text-[11px] hover:bg-accent disabled:opacity-50">
                        撤回新增
                      </button>
                    </>
                  ) : (
                    <button type="button" disabled={applying} onClick={() => onApplyInsertion(item)} className="rounded border px-2 py-1 text-[11px] hover:bg-accent disabled:opacity-50">
                      确认插入
                    </button>
                  )}
                  {!appliedInsertionIds.has(item.id) && (
                    <button type="button" disabled={applying} onClick={() => onDiscardInsertion(item.id)} className="rounded border px-2 py-1 text-[11px] hover:bg-accent disabled:opacity-50">
                      丢弃
                    </button>
                  )}
                </div>
              </div>
            )) : <EmptyReportText />}
          </ReportSection>
        </div>
      )}
    </div>
  )
}

function DecisionButtons({
  decision,
  onChange,
}: {
  decision: OptimizationDecision
  onChange: (decision: OptimizationDecision) => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      <button type="button" onClick={() => onChange("accept")} className={decisionButtonClass(decision === "accept")}>
        采用优化
      </button>
      <button type="button" onClick={() => onChange("keep")} className={decisionButtonClass(decision === "keep")}>
        保留原文
      </button>
      <button type="button" onClick={() => onChange("regenerate")} className={decisionButtonClass(decision === "regenerate")}>
        重新生成
      </button>
    </div>
  )
}

function ReportSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-1 font-medium">{title}</div>
      <div className="space-y-1">{children}</div>
    </section>
  )
}

function ReportItem({
  title,
  detail,
  tone,
  onClick,
}: {
  title: string
  detail: string
  tone: "info" | "warning" | "error"
  onClick?: () => void
}) {
  const toneClass = tone === "error"
    ? "border-destructive/40 bg-destructive/10"
    : tone === "warning"
      ? "border-amber-500/30 bg-amber-500/10"
      : "border-blue-500/30 bg-blue-500/10"
  return (
    <button
      type="button"
      onClick={onClick}
      className={`block w-full rounded border p-2 text-left ${toneClass} ${onClick ? "hover:border-primary/50 hover:bg-accent/40" : ""}`}
      disabled={!onClick}
    >
      <div className="mb-1 flex items-center gap-1 font-medium">
        {tone !== "info" && <AlertTriangle className="h-3 w-3" />}
        <span>{title}</span>
      </div>
      <div className="whitespace-pre-wrap leading-5 text-muted-foreground">{detail}</div>
    </button>
  )
}

function EmptyReportText() {
  return <div className="text-muted-foreground">无</div>
}

function decisionButtonClass(active: boolean): string {
  return `rounded border px-2 py-1 text-[11px] hover:bg-accent ${active ? "border-primary/50 bg-primary/10 text-primary" : ""}`
}

function decisionLabel(decision: OptimizationDecision): string {
  if (decision === "accept") return "已选择采用优化"
  if (decision === "keep") return "已选择保留原文"
  if (decision === "regenerate") return "已标记重新生成"
  return "待选择"
}

function suggestionLabel(suggestion: GalLonglineNodeOptimization["suggestion"]): string {
  if (suggestion === "keep") return "建议保留"
  if (suggestion === "rewrite") return "建议重写"
  return "建议局部优化"
}
