import { useEffect, useMemo, useRef, useState } from "react"
import { AlertTriangle, ArrowLeft, BookOpen, GitBranch, Lock, RefreshCw, Sparkles } from "lucide-react"
import { useGalStore, type GalBoardHighlightState } from "@/stores/gal-store"
import { useWikiStore } from "@/stores/wiki-store"
import { detectGalLonglineRange, type GalLonglineRange, type GalLonglineStop } from "@/lib/gal/gal-longline-range"
import {
  generateGalLonglineOptimizationPlan,
  type GalLonglineOptimizationPlan,
  type GalLonglineOptimizeMode,
} from "@/lib/gal/gal-longline-optimization"
import {
  executeGalLonglinePlan,
  type GalLonglinePlanExecutionReport,
  type GalLonglinePlanExecutionStep,
} from "@/lib/gal/gal-longline-plan-executor"
import { reviewGalLongline, type GalLonglineReviewReport } from "@/lib/gal/gal-longline-review"
import { deleteNodeScript, loadNodeScript, saveGalProject, saveNodeScript } from "@/lib/gal/gal-storage"
import type { GalNode, GalNodeStatus, GalProject, GalRoute } from "@/lib/gal/gal-types"
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

type RewriteUndoSnapshot = {
  routeId: string
  nodeId: string
  oldScript: string
  oldStatus: GalNodeStatus
  oldUpdatedAt: string
}

type InsertUndoSnapshot = {
  routeId: string
  insertedNodeId?: string
  afterNodeId: string
  beforeNodeId: string
  afterChildren: string[]
  afterChoices: GalNode["choices"]
  afterUpdatedAt: string
  beforeParents: string[]
  beforeUpdatedAt: string
  routeNodeIds: Record<string, string[]>
  routeSequences: Array<{ nodeId: string; sequence: number }>
}

type StepUndoSnapshot = RewriteUndoSnapshot | InsertUndoSnapshot

export function GalLonglineWorkspace({
  route,
  startNodeId,
  onBackToBoard,
  onBackToEditor,
}: GalLonglineWorkspaceProps) {
  const wikiProject = useWikiStore((s) => s.project)
  const galStore = useGalStore()
  const undoSnapshotsRef = useRef<Record<string, StepUndoSnapshot>>({})
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
  const [selectedPlanStepIds, setSelectedPlanStepIds] = useState<Set<string>>(new Set())
  const [planActionMessage, setPlanActionMessage] = useState<string | null>(null)
  const [executionReport, setExecutionReport] = useState<GalLonglinePlanExecutionReport | null>(null)
  const [executingPlan, setExecutingPlan] = useState(false)
  const [editingStepId, setEditingStepId] = useState<string | null>(null)
  const [editScope, setEditScope] = useState("")
  const [editConstraints, setEditConstraints] = useState("")
  const [undoneStepIds, setUndoneStepIds] = useState<Set<string>>(new Set())
  const [undoSnapshots, setUndoSnapshots] = useState<Record<string, StepUndoSnapshot>>({})
  const [compareStepId, setCompareStepId] = useState<string | null>(null)

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
    ))
    return () => galStore.clearBoardHighlight()
  }, [range, reviewReport, optimizationPlan])

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
    if (!route || !range || !galStore.project || !wikiProject?.path) return
    setOptimizing(true)
    setOptimizationError(null)
    try {
      const plan = await galStore.runAiTask(
        {
          title: optimizeMode === "story_enhance" ? "生成剧情增强方案" : "生成长线优化方案",
          detail: optimizeMode === "story_enhance"
            ? "正在增强长线剧情连贯性与体验感，不会保存项目..."
            : "正在生成结构化优化计划，不会保存项目...",
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
            projectPath: wikiProject.path,
            onFindingProgress: (findingId, index, total) => {
              task.update(`正在为发现 ${findingId} 生成计划... (${index}/${total})`)
            },
          })
          task.update(optimizeMode === "story_enhance" ? "剧情增强方案已生成。" : "优化方案已生成。")
          return result
        },
      )
      setOptimizationPlan(plan)
      setSelectedPlanStepIds(new Set(plan.steps.filter(shouldSelectPlanStepByDefault).map((step) => step.id)))
      setPlanActionMessage(null)
    } catch (err) {
      setOptimizationError(err instanceof Error ? err.message : String(err))
    } finally {
      setOptimizing(false)
    }
  }
  const setPlanStepSelected = (stepId: string, selected: boolean) => {
    setSelectedPlanStepIds((prev) => {
      const next = new Set(prev)
      if (selected) next.add(stepId)
      else next.delete(stepId)
      return next
    })
    setPlanActionMessage(null)
    setExecutionReport(null)
  }
  const handleStartEditStep = (stepId: string) => {
    const step = optimizationPlan?.steps.find((s) => s.id === stepId)
    if (!step) return
    setEditingStepId(stepId)
    setEditScope(step.scope)
    setEditConstraints(step.constraints.join("\n"))
  }
  const handleSaveEditStep = () => {
    if (!optimizationPlan || !editingStepId) return
    setOptimizationPlan({
      ...optimizationPlan,
      steps: optimizationPlan.steps.map((s) =>
        s.id === editingStepId
          ? { ...s, scope: editScope.trim(), constraints: editConstraints.split("\n").map((c) => c.trim()).filter(Boolean) }
          : s,
      ),
    })
    setEditingStepId(null)
  }
  const handleCancelEditStep = () => {
    setEditingStepId(null)
  }
  const handleExecuteSelectedPlan = async () => {
    if (!route || !range || !galStore.project || !optimizationPlan || !wikiProject?.path || executingPlan) return
    setExecutingPlan(true)
    setPlanActionMessage(null)
    setExecutionReport(null)
    setUndoneStepIds(new Set())
    setUndoSnapshots({})
    setCompareStepId(null)
    undoSnapshotsRef.current = {}
    try {
      const report = await galStore.runAiTask(
        {
          title: "执行长线优化计划",
          detail: "正在按所选步骤串行执行计划骨架...",
        },
        async (task) => {
          const result = await executeGalLonglinePlan({
            projectPath: wikiProject.path,
            project: galStore.project!,
            route,
            plan: optimizationPlan,
            selectedStepIds: selectedPlanStepIds,
            scripts,
            upstreamBoundary: range.upstreamBoundary
              ? { node: range.upstreamBoundary, script: scripts[range.upstreamBoundary.id] ?? "" }
              : null,
            downstreamBoundary: range.downstreamBoundary
              ? { node: range.downstreamBoundary, script: scripts[range.downstreamBoundary.id] ?? "" }
              : null,
            onStepUpdate: (step, index) => {
              task.update(`正在处理第 ${index + 1} 个计划步骤：${step.title}`)
              if (step.status === "running") {
                const planStep = optimizationPlan.steps.find((item) => item.id === step.stepId)
                const snapshot = planStep ? createUndoSnapshot(planStep, galStore.project!, scripts) : null
                if (snapshot) {
                  undoSnapshotsRef.current[step.stepId] = snapshot
                  setUndoSnapshots((prev) => ({ ...prev, [step.stepId]: snapshot }))
                }
              }
              if (step.nodeId && step.updatedScript) {
                setScripts((prev) => ({ ...prev, [step.nodeId!]: step.updatedScript! }))
              }
              setExecutionReport((prev) => mergeExecutionStep(prev, step, index))
            },
          })
          task.update("计划执行骨架已完成。")
          return result
        },
      )
      setExecutionReport(report)
      const updatedScripts = Object.fromEntries(
        report.steps
          .filter((step) => step.nodeId && step.updatedScript)
          .map((step) => [step.nodeId!, step.updatedScript!]),
      )
      if (Object.keys(updatedScripts).length > 0) {
        setScripts((prev) => ({ ...prev, ...updatedScripts }))
      }
      galStore.setProject(galStore.project ? { ...galStore.project } : null)
      setPlanActionMessage("执行完成：已按计划写回正文或插入中继节点。")
    } catch (err) {
      setPlanActionMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setExecutingPlan(false)
    }
  }
  const handleUndoExecutionStep = async (step: GalLonglinePlanExecutionStep) => {
    if (!wikiProject?.path || !galStore.project || step.status !== "succeeded" || undoneStepIds.has(step.stepId)) return
    const snapshot = undoSnapshotsRef.current[step.stepId]
    if (!snapshot) {
      setPlanActionMessage("未找到本步骤的撤回快照，无法撤回。")
      return
    }
    try {
      if (step.type === "rewrite_node") {
        const rewriteSnapshot = snapshot as RewriteUndoSnapshot
        await undoRewriteStep(wikiProject.path, galStore.project, rewriteSnapshot)
        setScripts((prev) => ({ ...prev, [rewriteSnapshot.nodeId]: rewriteSnapshot.oldScript }))
        locateLonglineNode(rewriteSnapshot.nodeId, setActiveNodeId, galStore)
      } else if (step.type === "insert_bridge_node") {
        const insertSnapshot = {
          ...(snapshot as InsertUndoSnapshot),
          insertedNodeId: step.insertedNodeId ?? (snapshot as InsertUndoSnapshot).insertedNodeId,
        }
        await undoInsertStep(wikiProject.path, galStore.project, insertSnapshot)
        if (insertSnapshot.insertedNodeId) {
          setScripts((prev) => {
            const next = { ...prev }
            delete next[insertSnapshot.insertedNodeId!]
            return next
          })
        }
        locateLonglineNode(insertSnapshot.afterNodeId, setActiveNodeId, galStore)
      }
      galStore.setProject({ ...galStore.project })
      setUndoneStepIds((prev) => new Set([...prev, step.stepId]))
      setExecutionReport((prev) => prev ? {
        ...prev,
        steps: prev.steps.map((item) => item.stepId === step.stepId ? { ...item, written: false, message: `${item.message}（已撤回）` } : item),
      } : prev)
      setPlanActionMessage("已撤回所选步骤。")
    } catch (err) {
      setPlanActionMessage(err instanceof Error ? err.message : String(err))
    }
  }
  const handleViewExecutionStep = (step: GalLonglinePlanExecutionStep) => {
    if (step.nodeId) locateLonglineNode(step.nodeId, setActiveNodeId, galStore)
    setCompareStepId((current) => current === step.stepId ? null : step.stepId)
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
              当前页面会先生成优化计划；计划不会写回项目，后续执行阶段才会按步骤处理。
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
            selectedStepIds={selectedPlanStepIds}
            message={planActionMessage}
            executionReport={executionReport}
            executing={executingPlan}
            undoneStepIds={undoneStepIds}
            undoSnapshots={undoSnapshots}
            compareStepId={compareStepId}
            editingStepId={editingStepId}
            editScope={editScope}
            editConstraints={editConstraints}
            onSelectNode={(nodeId) => locateLonglineNode(nodeId, setActiveNodeId, galStore)}
            onStepSelectedChange={setPlanStepSelected}
            onExecuteSelected={handleExecuteSelectedPlan}
            onViewExecutionStep={handleViewExecutionStep}
            onUndoExecutionStep={handleUndoExecutionStep}
            onStartEditStep={handleStartEditStep}
            onSaveEditStep={handleSaveEditStep}
            onCancelEditStep={handleCancelEditStep}
            onEditScopeChange={setEditScope}
            onEditConstraintsChange={setEditConstraints}
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

function mergeExecutionStep(
  report: GalLonglinePlanExecutionReport | null,
  step: GalLonglinePlanExecutionStep,
  index: number,
): GalLonglinePlanExecutionReport {
  const now = new Date().toISOString()
  const steps = [...(report?.steps ?? [])]
  steps[index] = step
  return {
    startedAt: report?.startedAt ?? now,
    finishedAt: report?.finishedAt ?? now,
    steps,
  }
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

function createUndoSnapshot(
  step: GalLonglineOptimizationPlan["steps"][number],
  project: GalProject,
  scripts: Record<string, string>,
): StepUndoSnapshot | null {
  if (step.type === "rewrite_node" && step.targetNodeId) {
    const node = findProjectNode(project, step.targetNodeId)
    if (!node) return null
    return {
      routeId: node.routeId,
      nodeId: node.id,
      oldScript: scripts[node.id] ?? "",
      oldStatus: node.status,
      oldUpdatedAt: node.updatedAt,
    }
  }
  if (step.type === "insert_bridge_node" && step.afterNodeId && step.beforeNodeId) {
    const route = project.routes.find((item) => item.nodes.some((node) => node.id === step.afterNodeId))
    const afterNode = route?.nodes.find((node) => node.id === step.afterNodeId)
    const beforeNode = route?.nodes.find((node) => node.id === step.beforeNodeId)
    if (!route || !afterNode || !beforeNode) return null
    return {
      routeId: route.id,
      afterNodeId: afterNode.id,
      beforeNodeId: beforeNode.id,
      afterChildren: [...afterNode.children],
      afterChoices: cloneChoices(afterNode.choices),
      afterUpdatedAt: afterNode.updatedAt,
      beforeParents: [...beforeNode.parents],
      beforeUpdatedAt: beforeNode.updatedAt,
      routeNodeIds: Object.fromEntries(
        project.routes
          .filter((item) => Array.isArray(item.nodeIds))
          .map((item) => [item.id, [...item.nodeIds!]]),
      ),
      routeSequences: route.nodes.map((node) => ({ nodeId: node.id, sequence: node.sequence })),
    }
  }
  return null
}

async function undoRewriteStep(projectPath: string, project: GalProject, snapshot: RewriteUndoSnapshot): Promise<void> {
  const node = findProjectNode(project, snapshot.nodeId)
  if (!node) throw new Error("撤回失败：目标节点不存在")
  await saveNodeScript(projectPath, snapshot.routeId, snapshot.nodeId, snapshot.oldScript)
  node.status = snapshot.oldStatus
  node.updatedAt = snapshot.oldUpdatedAt
  project.updatedAt = new Date().toISOString()
  await saveGalProject(projectPath, project)
}

async function undoInsertStep(projectPath: string, project: GalProject, snapshot: InsertUndoSnapshot): Promise<void> {
  const route = project.routes.find((item) => item.id === snapshot.routeId)
  const afterNode = route?.nodes.find((node) => node.id === snapshot.afterNodeId)
  const beforeNode = route?.nodes.find((node) => node.id === snapshot.beforeNodeId)
  if (!route || !afterNode || !beforeNode || !snapshot.insertedNodeId) {
    throw new Error("撤回失败：插入节点或前后节点不存在")
  }
  const inserted = route.nodes.find((node) => node.id === snapshot.insertedNodeId)
  if (!inserted) throw new Error("撤回失败：插入节点已不存在")
  if (inserted.parents[0] !== afterNode.id || inserted.children[0] !== beforeNode.id) {
    throw new Error("撤回失败：插入节点连接已被后续操作修改")
  }
  afterNode.children = [...snapshot.afterChildren]
  afterNode.choices = cloneChoices(snapshot.afterChoices)
  afterNode.updatedAt = snapshot.afterUpdatedAt
  beforeNode.parents = [...snapshot.beforeParents]
  beforeNode.updatedAt = snapshot.beforeUpdatedAt
  const sequenceByNodeId = new Map(snapshot.routeSequences.map((item) => [item.nodeId, item.sequence]))
  route.nodes = route.nodes
    .filter((node) => node.id !== snapshot.insertedNodeId)
    .map((node) => ({ ...node, sequence: sequenceByNodeId.get(node.id) ?? node.sequence }))
  for (const item of project.routes) {
    const nodeIds = snapshot.routeNodeIds[item.id]
    if (nodeIds) item.nodeIds = [...nodeIds]
  }
  project.updatedAt = new Date().toISOString()
  await deleteNodeScript(projectPath, snapshot.routeId, snapshot.insertedNodeId)
  await saveGalProject(projectPath, project)
}

function findProjectNode(project: GalProject, nodeId: string): GalNode | null {
  for (const route of project.routes) {
    const node = route.nodes.find((item) => item.id === nodeId)
    if (node) return node
  }
  return null
}

function cloneChoices(choices: GalNode["choices"]): GalNode["choices"] {
  return choices.map((choice) => ({
    ...choice,
    condition: choice.condition ? choice.condition.map((item) => ({ ...item })) : undefined,
    effects: choice.effects.map((item) => ({ ...item })),
  }))
}

function buildLonglineBoardHighlight(
  range: GalLonglineRange,
  reviewReport: GalLonglineReviewReport | null,
  optimizationPlan: GalLonglineOptimizationPlan | null,
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
    previewInsertions: (optimizationPlan?.steps ?? [])
      .filter((item) => item.type === "insert_bridge_node" && item.afterNodeId && item.beforeNodeId)
      .map((item) => ({
        id: item.id,
        afterNodeId: item.afterNodeId!,
        beforeNodeId: item.beforeNodeId!,
        title: item.title,
      })),
  }
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

function OptimizationPanel({
  plan,
  error,
  selectedStepIds,
  message,
  executionReport,
  executing,
  undoneStepIds,
  undoSnapshots,
  compareStepId,
  editingStepId,
  editScope,
  editConstraints,
  onSelectNode,
  onStepSelectedChange,
  onExecuteSelected,
  onViewExecutionStep,
  onUndoExecutionStep,
  onStartEditStep,
  onSaveEditStep,
  onCancelEditStep,
  onEditScopeChange,
  onEditConstraintsChange,
}: {
  plan: GalLonglineOptimizationPlan | null
  error: string | null
  selectedStepIds: Set<string>
  message: string | null
  executionReport: GalLonglinePlanExecutionReport | null
  executing: boolean
  undoneStepIds: Set<string>
  undoSnapshots: Record<string, StepUndoSnapshot>
  compareStepId: string | null
  editingStepId: string | null
  editScope: string
  editConstraints: string
  onSelectNode: (nodeId: string) => void
  onStepSelectedChange: (stepId: string, selected: boolean) => void
  onExecuteSelected: () => void
  onViewExecutionStep: (step: GalLonglinePlanExecutionStep) => void
  onUndoExecutionStep: (step: GalLonglinePlanExecutionStep) => void
  onStartEditStep: (stepId: string) => void
  onSaveEditStep: () => void
  onCancelEditStep: () => void
  onEditScopeChange: (value: string) => void
  onEditConstraintsChange: (value: string) => void
}) {
  const selectedExecutableCount = plan?.steps.filter((step) => isExecutablePlanStep(step) && selectedStepIds.has(step.id)).length ?? 0
  return (
    <div className="mt-3 rounded-md border bg-card p-3">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-medium">
        <Sparkles className="h-3.5 w-3.5 text-emerald-400" />
        优化计划
      </div>
      {error && (
        <div className="mb-2 rounded border border-destructive/40 bg-destructive/10 p-2 text-xs leading-5 text-destructive">
          {error}
        </div>
      )}
      {message && (
        <div className="mb-2 rounded border border-blue-500/30 bg-blue-500/10 p-2 text-xs leading-5 text-blue-300">
          {message}
        </div>
      )}
      {!plan ? (
        <div className="text-xs leading-5 text-muted-foreground">
          点击顶部“生成优化方案”后，会在这里显示结构化执行计划。计划本身不会生成正文，也不会保存到磁盘。
        </div>
      ) : (
        <div className="space-y-3 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={executing || selectedExecutableCount === 0}
              onClick={onExecuteSelected}
              className="rounded border px-2 py-1 text-[11px] hover:bg-accent disabled:opacity-50"
            >
              {executing ? "执行中..." : `执行选中计划（${selectedExecutableCount}）`}
            </button>
            <span className="text-[11px] text-muted-foreground">执行后会写回正文或插入中继节点，请只勾选确认要应用的步骤。</span>
          </div>
          <ReportSection title="整体说明">
            <p className="leading-5 text-muted-foreground">{plan.summary}</p>
          </ReportSection>
          <ReportSection title={`计划步骤 (${plan.steps.length})`}>
            {plan.steps.length ? plan.steps.map((item) => (
              <div key={item.id} className="rounded border bg-muted/30 p-2">
                <div className="mb-1 flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={selectedStepIds.has(item.id)}
                    disabled={!isExecutablePlanStep(item)}
                    onChange={(event) => onStepSelectedChange(item.id, event.target.checked)}
                    className="mt-0.5 h-3.5 w-3.5"
                    aria-label={`选择计划步骤：${item.title}`}
                  />
                  <button
                    type="button"
                    onClick={() => item.targetNodeId ? onSelectNode(item.targetNodeId) : undefined}
                    disabled={!item.targetNodeId}
                    className="block min-w-0 flex-1 truncate text-left font-medium hover:text-primary disabled:hover:text-inherit"
                  >
                    {stepTypeLabel(item.type)}：{item.title}
                  </button>
                </div>
                <div className="mb-2 flex flex-wrap gap-1 text-[11px] text-muted-foreground">
                  {item.targetNodeId && <span className="rounded bg-background px-2 py-0.5">目标：{item.targetNodeId}</span>}
                  {item.afterNodeId && item.beforeNodeId && <span className="rounded bg-background px-2 py-0.5">插入：{item.afterNodeId} → {item.beforeNodeId}</span>}
                  <span className="rounded bg-background px-2 py-0.5">优先级：{priorityLabel(item.priority)}</span>
                  <span className="rounded bg-background px-2 py-0.5">风险：{riskLabel(item.risk)}</span>
                </div>
                <div className="mb-1 leading-5 text-muted-foreground">原因：{item.reason}</div>
                <div className="mb-1 leading-5 text-muted-foreground">目标：{item.intent}</div>
                {editingStepId === item.id ? (
                  <div className="space-y-2">
                    <div>
                      <span className="text-[11px] font-medium">范围（可修改）：</span>
                      <textarea
                        value={editScope}
                        onChange={(e) => onEditScopeChange(e.target.value)}
                        className="mt-1 w-full rounded border bg-background p-2 text-[11px] leading-5"
                        rows={3}
                      />
                    </div>
                    <div>
                      <span className="text-[11px] font-medium">约束（每行一条，可修改）：</span>
                      <textarea
                        value={editConstraints}
                        onChange={(e) => onEditConstraintsChange(e.target.value)}
                        className="mt-1 w-full rounded border bg-background p-2 text-[11px] leading-5"
                        rows={3}
                      />
                    </div>
                    <div className="flex gap-1">
                      <button type="button" onClick={onSaveEditStep} className="rounded border border-emerald-500/40 bg-emerald-500/10 px-3 py-1 text-[11px] text-emerald-400 hover:bg-emerald-500/20">
                        保存修改
                      </button>
                      <button type="button" onClick={onCancelEditStep} className="rounded border px-3 py-1 text-[11px] hover:bg-accent">
                        取消
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="mb-1 leading-5 text-muted-foreground">范围：{item.scope}</div>
                    {item.constraints.length > 0 && (
                      <div className="mb-1 leading-5 text-muted-foreground">
                        约束：{item.constraints.join("；")}
                      </div>
                    )}
                    {isExecutablePlanStep(item) && (
                      <button type="button" onClick={() => onStartEditStep(item.id)} className="mt-1 rounded border px-2 py-0.5 text-[10px] text-muted-foreground hover:bg-accent">
                        修改范围与约束
                      </button>
                    )}
                  </>
                )}
              </div>
            )) : <EmptyReportText />}
          </ReportSection>
          {executionReport && (
            <ReportSection title={`执行报告 (${executionReport.steps.length})`}>
              {executionReport.steps.length ? executionReport.steps.map((item, index) => (
                <div key={`${item.stepId}-${index}`} className="rounded border bg-muted/30 p-2">
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate font-medium">{index + 1}. {item.title}</span>
                    <span className="rounded bg-background px-2 py-0.5 text-[11px] text-muted-foreground">
                      {executionStatusLabel(item.status)}
                    </span>
                  </div>
                  <div className="leading-5 text-muted-foreground">{item.message}</div>
                  <div className="mt-1 flex flex-wrap gap-1 text-[11px] text-muted-foreground">
                    {item.nodeTitle && <span className="rounded bg-background px-2 py-0.5">节点：{item.nodeTitle}</span>}
                    {item.insertedNodeTitle && <span className="rounded bg-background px-2 py-0.5">插入：{item.insertedNodeTitle}</span>}
                    <span className={`rounded bg-background px-2 py-0.5 ${item.written === false ? "text-amber-300" : item.written ? "text-emerald-400" : ""}`}>
                      {item.written === false ? "已撤回" : item.written ? "已写回" : "未写回"}
                    </span>
                  </div>
                  {item.error && <div className="mt-1 leading-5 text-destructive">{item.error}</div>}
                  {compareStepId === item.stepId && item.type === "rewrite_node" && (
                    <ExecutionCompare
                      oldScript={(undoSnapshots[item.stepId] as RewriteUndoSnapshot | undefined)?.oldScript ?? ""}
                      newScript={item.updatedScript ?? ""}
                    />
                  )}
                  {item.status === "succeeded" && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {item.type === "rewrite_node" && (
                        <>
                          <button type="button" onClick={() => onViewExecutionStep(item)} className="rounded border px-2 py-1 text-[11px] hover:bg-accent">
                            查看对比
                          </button>
                          <button type="button" disabled={undoneStepIds.has(item.stepId)} onClick={() => onUndoExecutionStep(item)} className="rounded border px-2 py-1 text-[11px] hover:bg-accent disabled:opacity-50">
                            撤回本步
                          </button>
                        </>
                      )}
                      {item.type === "insert_bridge_node" && (
                        <>
                          <button type="button" onClick={() => onViewExecutionStep(item)} className="rounded border px-2 py-1 text-[11px] hover:bg-accent">
                            定位新节点
                          </button>
                          <button type="button" disabled={undoneStepIds.has(item.stepId)} onClick={() => onUndoExecutionStep(item)} className="rounded border px-2 py-1 text-[11px] hover:bg-accent disabled:opacity-50">
                            撤回插入
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )) : <EmptyReportText />}
            </ReportSection>
          )}
        </div>
      )}
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

function ExecutionCompare({ oldScript, newScript }: { oldScript: string; newScript: string }) {
  return (
    <div className="mt-2 grid gap-2 rounded border bg-background/60 p-2 md:grid-cols-2">
      <div className="min-w-0">
        <div className="mb-1 text-[11px] font-medium text-muted-foreground">原正文</div>
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-2 text-[11px] leading-5">
          {oldScript.trim() || "原正文为空。"}
        </pre>
      </div>
      <div className="min-w-0">
        <div className="mb-1 text-[11px] font-medium text-muted-foreground">AI 正文</div>
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-2 text-[11px] leading-5">
          {newScript.trim() || "AI 正文为空。"}
        </pre>
      </div>
    </div>
  )
}

function EmptyReportText() {
  return <div className="text-muted-foreground">无</div>
}

function stepTypeLabel(type: GalLonglineOptimizationPlan["steps"][number]["type"]): string {
  if (type === "rewrite_node") return "改写节点"
  if (type === "insert_bridge_node") return "插入中继节点"
  return "跳过"
}

function isExecutablePlanStep(step: GalLonglineOptimizationPlan["steps"][number]): boolean {
  if (step.type === "skip") return false
  if (step.type === "rewrite_node") return Boolean(step.targetNodeId)
  return Boolean(step.afterNodeId && step.beforeNodeId)
}

function shouldSelectPlanStepByDefault(step: GalLonglineOptimizationPlan["steps"][number]): boolean {
  if (!isExecutablePlanStep(step)) return false
  if (step.risk === "high") return false
  return step.priority === "high" || step.priority === "medium"
}

function priorityLabel(priority: GalLonglineOptimizationPlan["steps"][number]["priority"]): string {
  if (priority === "high") return "高"
  if (priority === "medium") return "中"
  return "低"
}

function riskLabel(risk: GalLonglineOptimizationPlan["steps"][number]["risk"]): string {
  if (risk === "high") return "高"
  if (risk === "medium") return "中"
  return "低"
}

function executionStatusLabel(status: GalLonglinePlanExecutionStep["status"]): string {
  if (status === "pending") return "等待"
  if (status === "running") return "执行中"
  if (status === "succeeded") return "已完成"
  if (status === "failed") return "失败"
  return "已跳过"
}
