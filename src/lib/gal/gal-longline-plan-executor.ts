import { streamChat, type StreamCallbacks } from "@/lib/llm-client"
import { useWikiStore, type LlmConfig } from "@/stores/wiki-store"
import { buildGalContextPack, type GalContextPack } from "./gal-context-engine"
import { generateRelayNodeCard, type RelayNodeCardResult } from "./gal-node-generation"
import { areAdjacentRouteNodeIds, insertRelayNodeIntoProject } from "./gal-relay-node-insert"
import type { GalLonglineReviewNodeInput } from "./gal-longline-review"
import type { GalLonglineOptimizationPlan, GalLonglineOptimizationStep } from "./gal-longline-optimization"
import { saveGalProject, saveNodeScript } from "./gal-storage"
import type { GalNode, GalProject, GalRoute } from "./gal-types"

export type GalLonglinePlanStepStatus = "pending" | "running" | "succeeded" | "failed" | "skipped"

export interface GalLonglinePlanExecutionStep {
  stepId: string
  type: GalLonglineOptimizationStep["type"]
  title: string
  status: GalLonglinePlanStepStatus
  message: string
  nodeId?: string
  nodeTitle?: string
  updatedScript?: string
  written?: boolean
  insertedNodeId?: string
  insertedNodeTitle?: string
  error?: string
}

export interface GalLonglinePlanExecutionReport {
  startedAt: string
  finishedAt: string
  steps: GalLonglinePlanExecutionStep[]
}

export interface GalLonglinePlanExecutorParams {
  projectPath: string
  project: GalProject
  route: GalRoute
  plan: GalLonglineOptimizationPlan
  selectedStepIds: Set<string>
  scripts: Record<string, string>
  upstreamBoundary: GalLonglineReviewNodeInput | null
  downstreamBoundary: GalLonglineReviewNodeInput | null
  llmConfigOverride?: LlmConfig
  onStepUpdate?: (step: GalLonglinePlanExecutionStep, index: number) => void
  executeStep?: (step: GalLonglineOptimizationStep, index: number) => Promise<GalLonglinePlanExecutionStep>
}

export async function executeGalLonglinePlan(
  params: GalLonglinePlanExecutorParams,
): Promise<GalLonglinePlanExecutionReport> {
  const startedAt = new Date().toISOString()
  const selectedSteps = params.plan.steps.filter((step) => params.selectedStepIds.has(step.id))
  const steps: GalLonglinePlanExecutionStep[] = selectedSteps.map((step) => ({
    stepId: step.id,
    type: step.type,
    title: step.title,
    status: "pending",
    message: "等待执行",
  }))

  for (let index = 0; index < selectedSteps.length; index += 1) {
    const step = selectedSteps[index]
    const runningStep: GalLonglinePlanExecutionStep = {
      stepId: step.id,
      type: step.type,
      title: step.title,
      status: "running",
      message: "正在执行计划步骤",
    }
    steps[index] = runningStep
    params.onStepUpdate?.(runningStep, index)

    try {
      const result = params.executeStep
        ? await params.executeStep(step, index)
        : await executePlanStep(step, params)
      steps[index] = result
      params.onStepUpdate?.(result, index)
    } catch (err) {
      const failedStep: GalLonglinePlanExecutionStep = {
        stepId: step.id,
        type: step.type,
        title: step.title,
        status: "failed",
        message: "计划步骤执行失败",
        error: err instanceof Error ? err.message : String(err),
      }
      steps[index] = failedStep
      params.onStepUpdate?.(failedStep, index)
    }
  }

  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    steps,
  }
}

async function executePlanStep(
  step: GalLonglineOptimizationStep,
  params: GalLonglinePlanExecutorParams,
): Promise<GalLonglinePlanExecutionStep> {
  if (step.type === "rewrite_node") return rewriteNodeScript(step, params)
  if (step.type === "insert_bridge_node") return insertBridgeNode(step, params)
  return {
    stepId: step.id,
    type: step.type,
    title: step.title,
    status: "skipped",
    message: mockStepMessage(step),
  }
}

export async function rewriteNodeScript(
  step: GalLonglineOptimizationStep,
  params: GalLonglinePlanExecutorParams,
): Promise<GalLonglinePlanExecutionStep> {
  if (!step.targetNodeId) throw new Error("rewrite_node 缺少 targetNodeId")
  const targetNode = params.route.nodes.find((node) => node.id === step.targetNodeId)
  if (!targetNode) throw new Error(`未找到目标节点：${step.targetNodeId}`)

  let lastError: Error | null = null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const script = await generateRewriteScript(step, targetNode, params)
      const validation = validateRewriteScript(script)
      if (!validation.valid) throw new Error(validation.reason)

      await saveNodeScript(params.projectPath, targetNode.routeId, targetNode.id, script)
      const updatedAt = new Date().toISOString()
      targetNode.status = "draft"
      targetNode.updatedAt = updatedAt
      const projectNode: GalNode | undefined = params.project.routes
        .find((route) => route.id === targetNode.routeId)
        ?.nodes.find((node) => node.id === targetNode.id)
      if (projectNode && projectNode !== targetNode) {
        projectNode.status = "draft"
        projectNode.updatedAt = updatedAt
      }
      params.project.updatedAt = updatedAt
      await saveGalProject(params.projectPath, params.project)
      params.scripts[targetNode.id] = script

      return {
        stepId: step.id,
        type: step.type,
        title: step.title,
        status: "succeeded",
        message: attempt === 0 ? "已改写并写回目标节点正文。" : `重试 ${attempt} 次后已写回目标节点正文。`,
        nodeId: targetNode.id,
        nodeTitle: targetNode.title,
        updatedScript: script,
        written: true,
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
    }
  }

  throw lastError ?? new Error("rewrite_node 执行失败")
}

export async function insertBridgeNode(
  step: GalLonglineOptimizationStep,
  params: GalLonglinePlanExecutorParams,
): Promise<GalLonglinePlanExecutionStep> {
  const placement = validateBridgePlacement(step, params)
  let lastError: Error | null = null

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const card = await generateRelayNodeCard({
        projectPath: params.projectPath,
        routeId: params.route.id,
        parentNodeId: placement.afterNode.id,
        childNodeId: placement.beforeNode.id,
        edgeLabel: step.title,
        llmConfigOverride: params.llmConfigOverride,
      })
      const script = await generateBridgeScript(step, placement.afterNode, placement.beforeNode, card, params)
      const validation = validateRewriteScript(script)
      if (!validation.valid) throw new Error(validation.reason)

      const projectDraft = cloneGalProject(params.project)
      const inserted = insertRelayNodeIntoProject({
        project: projectDraft,
        routeId: params.route.id,
        afterNodeId: placement.afterNode.id,
        beforeNodeId: placement.beforeNode.id,
        requireNodeIdsAdjacency: true,
        requireSingleDirectConnection: false,
        draft: {
          ...card,
          script,
          status: "draft",
          boardPosition: midpointPosition(placement.afterNode, placement.beforeNode),
        },
      })
      await saveNodeScript(params.projectPath, inserted.route.id, inserted.node.id, script)
      await saveGalProject(params.projectPath, projectDraft)
      syncProject(params.project, projectDraft)
      const syncedRoute = params.project.routes.find((route) => route.id === inserted.route.id)
      if (syncedRoute && params.route !== syncedRoute) {
        syncDetachedRoute(params.route, syncedRoute)
      }
      params.scripts[inserted.node.id] = script

      return {
        stepId: step.id,
        type: step.type,
        title: step.title,
        status: "succeeded",
        message: attempt === 0
          ? `已插入中继节点「${inserted.node.title}」并写回完整正文。`
          : `重试 ${attempt} 次后已插入中继节点「${inserted.node.title}」。`,
        nodeId: inserted.node.id,
        nodeTitle: inserted.node.title,
        insertedNodeId: inserted.node.id,
        insertedNodeTitle: inserted.node.title,
        updatedScript: script,
        written: true,
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
    }
  }

  throw lastError ?? new Error("insert_bridge_node 执行失败")
}

async function generateRewriteScript(
  step: GalLonglineOptimizationStep,
  targetNode: GalNode,
  params: GalLonglinePlanExecutorParams,
): Promise<string> {
  const llmConfig = params.llmConfigOverride ?? useWikiStore.getState().llmConfig
  const contextPack = await buildGalContextPack(
    params.projectPath,
    `执行长线优化计划，改写节点「${targetNode.title}」完整正文`,
    targetNode.routeId,
    targetNode.id,
  )
  const prompt = buildRewritePrompt(step, targetNode, params, contextPack)
  let raw = ""
  let streamError: Error | null = null
  const callbacks: StreamCallbacks = {
    onToken: (token) => { raw += token },
    onDone: () => {},
    onError: (error) => { streamError = error },
  }

  await streamChat(llmConfig, [
    {
      role: "system",
      content: [
        "你是 Galgame 长线剧情 Do-Plan 执行器，只能改写当前目标节点的完整正文。",
        "只输出最终正文纯文本，不输出 JSON、Markdown 代码块、解释、标题或说明。",
        "禁止新增选项、禁止改变量、禁止改变节点目标。长线节点使用默认出口或单线推进，不需要选项。",
      ].join("\n"),
    },
    { role: "user", content: prompt },
  ], callbacks, undefined, { temperature: 0.45 })
  if (streamError) throw streamError
  return normalizeRewriteOutput(raw)
}

function buildRewritePrompt(
  step: GalLonglineOptimizationStep,
  targetNode: GalNode,
  params: GalLonglinePlanExecutorParams,
  contextPack: GalContextPack,
): string {
  const adjacent = findAdjacentNodes(params.route, targetNode.id)
  const previousScript = adjacent.previous ? params.scripts[adjacent.previous.id] ?? "" : ""
  const nextScript = adjacent.next ? params.scripts[adjacent.next.id] ?? "" : ""
  const originalScript = params.scripts[targetNode.id] ?? ""
  const isFirstTarget = Boolean(params.upstreamBoundary && targetNode.parents.includes(params.upstreamBoundary.node.id))
  const isLastTarget = Boolean(params.downstreamBoundary && targetNode.children.includes(params.downstreamBoundary.node.id))

  return [
    "## 执行的计划步骤",
    `类型：${step.type}`,
    `原因：${step.reason}`,
    `意图：${step.intent}`,
    `范围：${step.scope}`,
    `约束：${step.constraints.join("；") || "无"}`,
    "",
    "## 目标节点",
    `ID：${targetNode.id}`,
    `标题：${targetNode.title}`,
    `目标：${targetNode.goal || "未填写"}`,
    `场景：${targetNode.scene || "未填写"}`,
    `人物：${targetNode.characters.join("、") || "未填写"}`,
    "",
    "## 硬性限制",
    "- 必须输出目标节点的完整正文，不要只输出片段。",
    "- 不要新增、删除、扩写或改写选项。",
    "- 不要改变量、线索、CG、节点目标、父子连接。",
    "- 保持能自然承接前文，并自然接向后文。",
    "",
    "## 原正文",
    originalScript.trim() || "（原正文为空）",
    "",
    "## 前节点结尾",
    previousScript.trim() ? tailText(previousScript, 900) : "（无前节点正文）",
    "",
    "## 后节点开头",
    nextScript.trim() ? headText(nextScript, 900) : "（无后节点正文）",
    "",
    isFirstTarget && params.upstreamBoundary
      ? ["## 上游边界结尾（当前是长线第一个目标节点时必须强承接）", tailText(params.upstreamBoundary.script, 900)].join("\n")
      : "",
    isLastTarget && params.downstreamBoundary
      ? ["## 下游边界开头（当前是长线最后一个目标节点时必须导向）", headText(params.downstreamBoundary.script, 900)].join("\n")
      : "",
    "",
    "## 项目核心上下文（精简）",
    compactContext(contextPack),
    "",
    "现在只输出改写后的完整正文。",
  ].filter(Boolean).join("\n")
}

async function generateBridgeScript(
  step: GalLonglineOptimizationStep,
  afterNode: GalNode,
  beforeNode: GalNode,
  card: RelayNodeCardResult,
  params: GalLonglinePlanExecutorParams,
): Promise<string> {
  const llmConfig = params.llmConfigOverride ?? useWikiStore.getState().llmConfig
  const contextPack = await buildGalContextPack(
    params.projectPath,
    `执行长线优化计划：在「${afterNode.title}」与「${beforeNode.title}」之间生成中继节点完整正文`,
    params.route.id,
    afterNode.id,
  )
  const prompt = buildBridgeScriptPrompt(step, afterNode, beforeNode, card, params, contextPack)
  let raw = ""
  let streamError: Error | null = null
  const callbacks: StreamCallbacks = {
    onToken: (token) => { raw += token },
    onDone: () => {},
    onError: (error) => { streamError = error },
  }

  await streamChat(llmConfig, [
    {
      role: "system",
      content: [
        "你是 Galgame 长线剧情 Do-Plan 执行器，只能为一个新的单线中继节点生成完整正文。",
        "只输出最终正文纯文本，不输出 JSON、Markdown 代码块、解释、标题或说明。",
        "禁止新增选项、禁止新增变量、禁止制造分叉、禁止改变前后节点既定事实和剧情结论。",
      ].join("\n"),
    },
    { role: "user", content: prompt },
  ], callbacks, undefined, { temperature: 0.5 })
  if (streamError) throw streamError
  return normalizeRewriteOutput(raw)
}

function buildBridgeScriptPrompt(
  step: GalLonglineOptimizationStep,
  afterNode: GalNode,
  beforeNode: GalNode,
  card: RelayNodeCardResult,
  params: GalLonglinePlanExecutorParams,
  contextPack: GalContextPack,
): string {
  const afterScript = params.scripts[afterNode.id] ?? ""
  const beforeScript = params.scripts[beforeNode.id] ?? ""
  return [
    "## 执行的计划步骤",
    `类型：${step.type}`,
    `原因：${step.reason}`,
    `意图：${step.intent}`,
    `范围：${step.scope}`,
    `约束：${step.constraints.join("；") || "无"}`,
    "",
    "## 中继节点卡片",
    `标题：${card.title}`,
    `目标：${card.goal}`,
    `摘要：${card.summary}`,
    `场景：${card.scene}`,
    `人物：${card.characters.join("、") || "未填写"}`,
    "",
    "## 上游节点结尾（必须自然承接）",
    afterScript.trim() ? tailText(afterScript, 1000) : nodeFallback(afterNode),
    "",
    "## 下游节点开头（正文结尾必须自然导向这里）",
    beforeScript.trim() ? headText(beforeScript, 1000) : nodeFallback(beforeNode),
    "",
    "## 硬性限制",
    "- 只写这个中继节点的完整正文。",
    "- 不要写【选择】、选项1、frontmatter choices 或任何分叉内容。",
    "- 不要新增变量变化、线索、CG、结局或额外节点。",
    "- 不要改写上游节点和下游节点的事实；只补足两者之间的行动、情绪、时间或场景过渡。",
    "- 正文必须完整，不能是提纲、摘要、占位或说明。",
    "",
    "## 项目核心上下文（精简）",
    compactContext(contextPack),
    "",
    "现在只输出中继节点的完整正文。",
  ].filter(Boolean).join("\n")
}

function validateBridgePlacement(
  step: GalLonglineOptimizationStep,
  params: GalLonglinePlanExecutorParams,
): { afterNode: GalNode; beforeNode: GalNode } {
  if (!step.afterNodeId || !step.beforeNodeId) throw new Error("insert_bridge_node 缺少 afterNodeId 或 beforeNodeId")
  const afterNode = params.route.nodes.find((node) => node.id === step.afterNodeId)
  const beforeNode = params.route.nodes.find((node) => node.id === step.beforeNodeId)
  if (!afterNode || !beforeNode) throw new Error("insert_bridge_node 的前后节点不存在")
  if (!areAdjacentRouteNodeIds(params.route, afterNode.id, beforeNode.id)) {
    throw new Error("insert_bridge_node 只能插入当前长线中相邻的两个节点之间")
  }
  const outgoingTargets = getNodeLinkedTargetIds(afterNode)
  // 放宽：上下游边界可能分别有多个 children/parents（branch_node / merge_node）
  // 只要这两个节点之间存在直连即可，不需要单线
  if (!outgoingTargets.includes(beforeNode.id) || !beforeNode.parents.includes(afterNode.id)) {
    throw new Error("insert_bridge_node 要求前后节点当前存在直连关系")
  }
  return { afterNode, beforeNode }
}

function findAdjacentNodes(route: GalRoute, nodeId: string): { previous: GalNode | null; next: GalNode | null } {
  const orderedIds = Array.isArray(route.nodeIds) && route.nodeIds.length > 0
    ? route.nodeIds
    : [...route.nodes].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0)).map((node) => node.id)
  const index = orderedIds.indexOf(nodeId)
  const previousId = index > 0 ? orderedIds[index - 1] : undefined
  const nextId = index >= 0 ? orderedIds[index + 1] : undefined
  return {
    previous: previousId ? route.nodes.find((node) => node.id === previousId) ?? null : null,
    next: nextId ? route.nodes.find((node) => node.id === nextId) ?? null : null,
  }
}

function compactContext(pack: GalContextPack): string {
  const parts = [
    ["项目灵魂/风格规则", pack.soulDoc, 2500],
    ["大纲/世界观", pack.outline, 3500],
    ["角色状态", pack.novelCharacterStates, 2200],
    ["角色档案", pack.characterProfiles, 2200],
    ["不可违背规则", pack.globalRules, 1800],
    ["当前路线主题", pack.routeTheme, 900],
    ["变量状态", pack.variableState, 1200],
    ["角色情绪", pack.characterMoods, 1200],
  ] as const
  return parts
    .map(([title, content, limit]) => content.trim() ? `### ${title}\n${limitText(content, limit)}` : "")
    .filter(Boolean)
    .join("\n\n") || "（无额外上下文）"
}

function normalizeRewriteOutput(raw: string): string {
  return raw.trim()
}

function validateRewriteScript(script: string): { valid: true } | { valid: false; reason: string } {
  const text = script.trim()
  if (!text) return { valid: false, reason: "AI 返回正文为空" }
  if (text.length < 20) return { valid: false, reason: "AI 返回正文过短" }
  if (/^\s*[\[{]/.test(text) || /"script"\s*:|"正文"\s*:/.test(text)) return { valid: false, reason: "AI 返回了 JSON，而不是纯正文" }
  if (/^```|```$/.test(text)) return { valid: false, reason: "AI 返回了 Markdown 代码块" }
  if (/这里是|以下是|优化正文|改写后的正文|作为AI|我将/.test(text.slice(0, 120))) {
    return { valid: false, reason: "AI 返回了说明话，而不是正文" }
  }
  if (/(TODO|待补充|占位|placeholder|\[.*?待.*?\])/i.test(text)) return { valid: false, reason: "AI 返回正文包含占位内容" }
  return { valid: true }
}

function headText(text: string, maxLength: number): string {
  return limitText(text.trim(), maxLength)
}

function tailText(text: string, maxLength: number): string {
  const normalized = text.trim()
  return normalized.length <= maxLength ? normalized : normalized.slice(-maxLength)
}

function limitText(text: string, maxLength: number): string {
  const normalized = text.trim()
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength).trim()}…`
}

function getNodeLinkedTargetIds(node: GalNode): string[] {
  return Array.from(new Set([
    ...(node.children ?? []),
    ...(node.choices ?? [])
      .map((choice) => choice.nextNodeId)
      .filter((targetId): targetId is string => Boolean(targetId)),
  ]))
}

function midpointPosition(afterNode: GalNode, beforeNode: GalNode): GalNode["boardPosition"] {
  if (!afterNode.boardPosition && !beforeNode.boardPosition) return undefined
  return {
    x: Math.round(((afterNode.boardPosition?.x ?? 0) + (beforeNode.boardPosition?.x ?? afterNode.boardPosition?.x ?? 0)) / 2),
    y: Math.round(((afterNode.boardPosition?.y ?? 0) + (beforeNode.boardPosition?.y ?? afterNode.boardPosition?.y ?? 0)) / 2),
  }
}

function syncDetachedRoute(target: GalRoute, source: GalRoute): void {
  target.nodes = source.nodes
  target.nodeIds = source.nodeIds ? [...source.nodeIds] : undefined
  target.endingNodeIds = [...source.endingNodeIds]
  target.entryNodeId = source.entryNodeId
  target.theme = source.theme
  target.title = source.title
  target.variableDefaults = source.variableDefaults ? { ...source.variableDefaults } : undefined
}

function cloneGalProject(project: GalProject): GalProject {
  return JSON.parse(JSON.stringify(project)) as GalProject
}

function syncProject(target: GalProject, source: GalProject): void {
  target.id = source.id
  target.title = source.title
  target.premise = source.premise
  target.globalRules = source.globalRules
  target.variables = source.variables
  target.routes = source.routes
  target.cgs = source.cgs
  target.clues = source.clues
  target.createdAt = source.createdAt
  target.updatedAt = source.updatedAt
}

function nodeFallback(node: GalNode): string {
  return [
    `标题：${node.title}`,
    `目标：${node.goal || "未填写"}`,
    `摘要：${node.summary || "未填写"}`,
    `场景：${node.scene || "未填写"}`,
    `人物：${node.characters.join("、") || "未填写"}`,
  ].join("\n")
}

function mockStepMessage(step: GalLonglineOptimizationStep): string {
  if (step.type === "rewrite_node") return "当前阶段暂不调用 AI 改写正文，已跳过。"
  if (step.type === "insert_bridge_node") return "当前阶段暂不调用 AI 新增中继节点，已跳过。"
  return "该步骤标记为跳过。"
}
