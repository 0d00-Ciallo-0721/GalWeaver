import { streamChat, type StreamCallbacks } from "@/lib/llm-client"
import { useWikiStore, type LlmConfig } from "@/stores/wiki-store"
import { buildGalContextPack, type GalContextPack } from "./gal-context-engine"
import {
  extractFindings,
  isLonglineChoiceStructureIssue,
  type GalLonglineFinding,
  type GalLonglineReviewNodeInput,
  type GalLonglineReviewReport,
} from "./gal-longline-review"
import type { GalProject, GalRoute } from "./gal-types"

export type GalLonglineOptimizeMode = "missing_only" | "problem_nodes" | "whole_range" | "story_enhance"

export type GalLonglineOptimizationStepType = "rewrite_node" | "insert_bridge_node" | "skip"
export type GalLonglineOptimizationPriority = "low" | "medium" | "high"
export type GalLonglineOptimizationRisk = "low" | "medium" | "high"

export interface GalLonglineOptimizationParams {
  project: GalProject
  route: GalRoute
  mode: GalLonglineOptimizeMode
  reviewReport: GalLonglineReviewReport | null
  upstreamBoundary: GalLonglineReviewNodeInput | null
  targetNodes: GalLonglineReviewNodeInput[]
  downstreamBoundary: GalLonglineReviewNodeInput | null
  projectPath?: string
  llmConfigOverride?: LlmConfig
  onFindingProgress?: (findingId: string, index: number, total: number) => void
}

export interface GalLonglineOptimizationStep {
  id: string
  type: GalLonglineOptimizationStepType
  targetNodeId?: string
  afterNodeId?: string
  beforeNodeId?: string
  title: string
  reason: string
  intent: string
  scope: string
  constraints: string[]
  priority: GalLonglineOptimizationPriority
  risk: GalLonglineOptimizationRisk
}

export interface GalLonglineOptimizationPlan {
  mode: GalLonglineOptimizeMode
  summary: string
  steps: GalLonglineOptimizationStep[]
}

// ─── Step 衔接审查类型 ──────────────────────────────────────

export interface StepCoherenceConflict {
  fromStepId: string
  toStepId: string
  detail: string
}

export interface StepCoherenceReport {
  ok: boolean
  conflicts: StepCoherenceConflict[]
}

// ═══════════════════════════════════════════════════════════════
// 编排函数：串行 Per-Finding Plan + 衔接审查 + 修复
// ═══════════════════════════════════════════════════════════════

export async function generateGalLonglineOptimizationPlan(
  params: GalLonglineOptimizationParams,
): Promise<GalLonglineOptimizationPlan> {
  const llmConfig = params.llmConfigOverride ?? useWikiStore.getState().llmConfig
  const allowedNodeIds = buildAllowedOptimizationNodeIds(params)

  if (!params.reviewReport) {
    return { mode: params.mode, summary: "无审查报告。", steps: [] }
  }

  // 1. 将审查报告展开为编号发现清单
  const findings = extractFindings(params.reviewReport)
  if (findings.length === 0) {
    return { mode: params.mode, summary: "未发现需要优化的问题。", steps: [] }
  }

  // 2. 串行为每个发现生成 Plan step，记录失败日志
  const allSteps: GalLonglineOptimizationStep[] = []
  const failedFindings: string[] = []
  for (let index = 0; index < findings.length; index += 1) {
    const finding = findings[index]
    params.onFindingProgress?.(finding.id, index + 1, findings.length)
    const step = await generatePlanForFindingWithRetry(finding, params, llmConfig)
    if (step) {
      allSteps.push(step)
    } else {
      failedFindings.push(finding.id)
      console.error(`[GalPlan] 发现 ${finding.id} 生成失败：3 次重试均未返回有效步骤。类型：${finding.type}，标题：${finding.title}`)
    }
  }

  // 3. 去重 + 过滤无效，记录被过滤的步骤
  const adjacentPairs = buildAdjacentPairs(params.targetNodes)
  const validated: GalLonglineOptimizationStep[] = []
  const filteredSteps: string[] = []
  for (const step of allSteps) {
    if (isExecutablePlanStep(step, allowedNodeIds, adjacentPairs)) {
      validated.push(step)
    } else {
      filteredSteps.push(step.id)
      const reason = `${step.type} target=${step.targetNodeId ?? "-"} reason="${step.reason.slice(0, 60)}" intent="${step.intent.slice(0, 60)}" scope="${step.scope.slice(0, 60)}"`
      console.error(`[GalPlan] 步骤 ${step.id} 被过滤（isExecutablePlanStep 返回 false）：${reason}`)
    }
  }

  // 4. Step 衔接审查
  const coherenceReport = validated.length >= 2
    ? await reviewStepCoherenceWithRetry(validated, llmConfig)
    : null

  // 5. 有冲突时修复（最多 1 次）
  const fixedSteps = coherenceReport && !coherenceReport.ok
    ? await fixStepConflictsWithRetry(validated, coherenceReport.conflicts, llmConfig)
    : validated

  return {
    mode: params.mode,
    summary: buildPlanSummary(findings.length, fixedSteps.length, failedFindings, filteredSteps),
    steps: fixedSteps,
  }
}

function buildPlanSummary(
  totalFindings: number,
  stepCount: number,
  failedFindings: string[],
  filteredSteps: string[],
): string {
  const parts = [`共 ${totalFindings} 项发现，生成 ${stepCount} 个计划步骤。`]
  if (failedFindings.length > 0) {
    parts.push(`${failedFindings.length} 项发现 AI 生成失败（${failedFindings.join("、")}），请检查模型连接后重试。`)
  }
  if (filteredSteps.length > 0) {
    parts.push(`${filteredSteps.length} 个步骤因不满足执行条件被过滤（${filteredSteps.join("、")}）。请检查步骤的 targetNodeId、scope、intent 是否有值，或节点是否在允许优化范围内。`)
  }
  return parts.join(" ")
}

// ─── Retry 包装 ─────────────────────────────────────────────

async function generatePlanForFindingWithRetry(
  finding: GalLonglineFinding,
  params: GalLonglineOptimizationParams,
  llmConfig: LlmConfig,
): Promise<GalLonglineOptimizationStep | null> {
  let lastError = ""
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { return await generatePlanForFinding(finding, params, llmConfig) }
    catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
      console.error(`[GalPlan] 发现 ${finding.id} 第 ${attempt + 1}/3 次尝试失败：${lastError}`)
    }
  }
  return null
}

async function reviewStepCoherenceWithRetry(
  steps: GalLonglineOptimizationStep[],
  llmConfig: LlmConfig,
): Promise<StepCoherenceReport | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { return await reviewStepCoherence(steps, llmConfig) }
    catch { /* retry */ }
  }
  return null
}

async function fixStepConflictsWithRetry(
  steps: GalLonglineOptimizationStep[],
  conflicts: StepCoherenceConflict[],
  llmConfig: LlmConfig,
): Promise<GalLonglineOptimizationStep[]> {
  try { return await applyStepConflictFixes(steps, conflicts, llmConfig) }
  catch { return steps }
}

// ═══════════════════════════════════════════════════════════════
// Per-Finding Plan 生成（聚焦单个发现的上下文）
// ═══════════════════════════════════════════════════════════════

async function generatePlanForFinding(
  finding: GalLonglineFinding,
  params: GalLonglineOptimizationParams,
  llmConfig: LlmConfig,
): Promise<GalLonglineOptimizationStep> {
  const prompt = await buildPerFindingPlanPrompt(finding, params)
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
        "你是 Galgame 长线剧情优化计划师。你只为一个具体的检查发现生成一个计划步骤。",
        "只生成结构化优化计划，不写正文、不保存、不新增节点、不输出 Markdown。",
        "必须严格输出 JSON，不能输出解释文字。",
        "禁止任何涉及选项的操作。长线节点使用默认出口即可。",
      ].join("\n"),
    },
    { role: "user", content: prompt },
  ], callbacks, undefined, { temperature: 0.3 })
  if (streamError) throw streamError

  const parsed = parsePlanStepResponse(raw)
  return normalizePlanStep(parsed, finding.id)
}

async function buildPerFindingPlanPrompt(
  finding: GalLonglineFinding,
  params: GalLonglineOptimizationParams,
): Promise<string> {
  const contextReference = params.projectPath
    ? await buildLonglineContextReference(params)
    : "未提供项目路径；仅使用节点上下文。"

  const nodeContext = buildFindingNodeContext(finding, params)

  const typeHint = finding.type === "suggestedInsertion"
    ? "insert_bridge_node"
    : finding.type === "continuityBreak"
      ? "rewrite_node 或 insert_bridge_node"
      : "rewrite_node"

  return [
    `基于以下检查发现生成一个优化计划步骤。发现编号：${finding.id}，类型：${finding.type}。`,
    "",
    "## 输出 JSON 结构（只输出一个 step 对象，不输出数组）",
    JSON.stringify({
      type: "rewrite_node/insert_bridge_node/skip",
      targetNodeId: "rewrite_node 或 skip 的目标节点 ID",
      afterNodeId: "insert_bridge_node 的前一节点 ID",
      beforeNodeId: "insert_bridge_node 的后一节点 ID",
      title: "计划步骤标题",
      reason: `## 对应发现：[${finding.id}]\n修复原因`,
      intent: "这个步骤希望达成的剧情效果",
      scope: "允许修改的范围",
      constraints: ["执行时必须遵守的限制"],
      priority: "low/medium/high",
      risk: "low/medium/high",
    }, null, 2),
    "",
    "## 硬性规则",
    `- reason 必须以 \"## 对应发现：[${finding.id}]\" 开头。`,
    "- 只输出一个 step 对象（不是数组）。",
    "- 禁止任何选项相关操作。",
    `- 类型约束：本发现类型为 ${finding.type}，通常对应 ${typeHint}。`,
    "- 如果不需修改，输出 type=skip。",
    "",
    "## 检查发现",
    `[${finding.id}] ${finding.title}`,
    finding.detail,
    "",
    "## 项目核心上下文",
    contextReference,
    "",
    "## 问题节点上下文",
    nodeContext,
    "",
    `现在为发现 [${finding.id}] 输出一个计划步骤。`,
  ].join("\n")
}

function buildFindingNodeContext(
  finding: GalLonglineFinding,
  params: GalLonglineOptimizationParams,
): string {
  const nodeId = finding.nodeId
  if (!nodeId) {
    const parts: string[] = []
    if (finding.afterNodeId) {
      const after = params.targetNodes.find((item) => item.node.id === finding.afterNodeId)
      if (after) parts.push(`上游节点结尾：\n${after.script.trim().slice(-800) || "（无正文）"}`)
    }
    if (finding.beforeNodeId) {
      const before = params.targetNodes.find((item) => item.node.id === finding.beforeNodeId)
      if (before) parts.push(`下游节点开头：\n${before.script.trim().slice(0, 800) || "（无正文）"}`)
    }
    return parts.join("\n\n") || "无关联节点上下文。"
  }

  const targetIdx = params.targetNodes.findIndex((item) => item.node.id === nodeId)
  if (targetIdx < 0) return `节点 ${nodeId} 不在当前目标长线范围内。`

  const target = params.targetNodes[targetIdx]
  const isFirst = targetIdx === 0
  const isLast = targetIdx === params.targetNodes.length - 1

  const lines = [
    "### 问题节点",
    `ID：${target.node.id}`,
    `标题：${target.node.title}`,
    `目标：${target.node.goal || "未填写"}`,
    `概要：${target.node.summary || "未填写"}`,
    `场景：${target.node.scene || "未填写"}`,
    `人物：${target.node.characters.join("、") || "未填写"}`,
    "",
    "正文：",
    target.script.trim() || "（正文缺失）",
  ]

  if (!isFirst) {
    const prev = params.targetNodes[targetIdx - 1]
    if (prev) {
      lines.push("", "### 前一节点结尾", prev.script.trim().slice(-600) || "（无正文）")
    }
  }
  if (isFirst && params.upstreamBoundary) {
    lines.push("", "### 上游边界结尾", params.upstreamBoundary.script.trim().slice(-800) || "（无正文）")
  }

  if (!isLast) {
    const next = params.targetNodes[targetIdx + 1]
    if (next) {
      lines.push("", "### 后一节点开头", next.script.trim().slice(0, 600) || "（无正文）")
    }
  }
  if (isLast && params.downstreamBoundary) {
    lines.push("", "### 下游边界开头", params.downstreamBoundary.script.trim().slice(0, 800) || "（无正文）")
  }

  return lines.join("\n")
}

// ═══════════════════════════════════════════════════════════════
// Step 衔接审查
// ═══════════════════════════════════════════════════════════════

async function reviewStepCoherence(
  steps: GalLonglineOptimizationStep[],
  llmConfig: LlmConfig,
): Promise<StepCoherenceReport> {
  const prompt = buildCoherenceReviewPrompt(steps)
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
        "你是 Galgame 剧情编辑，只负责检查多个优化步骤之间的衔接是否冲突。",
        "必须严格输出 JSON，不能输出解释文字。",
        "如果没有冲突，输出 { ok: true, conflicts: [] }。",
      ].join("\n"),
    },
    { role: "user", content: prompt },
  ], callbacks, undefined, { temperature: 0.1 })
  if (streamError) throw streamError

  return parseCoherenceResponse(raw)
}

function buildCoherenceReviewPrompt(steps: GalLonglineOptimizationStep[]): string {
  const stepDescriptions = steps.map((step) =>
    `[${step.id}] type=${step.type} target=${step.targetNodeId ?? "-"} after=${step.afterNodeId ?? "-"} before=${step.beforeNodeId ?? "-"}\n  scope: ${step.scope}\n  constraints: ${step.constraints.join("；") || "无"}`
  ).join("\n\n")

  return [
    "检查以下优化步骤之间是否存在衔接冲突。",
    "",
    "## 输出 JSON",
    JSON.stringify({ ok: true, conflicts: [{ fromStepId: "", toStepId: "", detail: "" }] }, null, 2),
    "",
    "## 检查规则",
    "- 两个步骤是否试图改写同一个节点的同一部分？",
    "- 一个步骤插入的中继节点位置是否与另一步骤的改写范围冲突？",
    "- 步骤间的约束是否有矛盾？",
    "",
    "## 计划步骤",
    stepDescriptions,
  ].join("\n")
}

// ═══════════════════════════════════════════════════════════════
// Step 冲突修复
// ═══════════════════════════════════════════════════════════════

async function applyStepConflictFixes(
  steps: GalLonglineOptimizationStep[],
  conflicts: StepCoherenceConflict[],
  llmConfig: LlmConfig,
): Promise<GalLonglineOptimizationStep[]> {
  const stepMap = new Map(steps.map((step) => [step.id, step]))
  const conflictSteps = conflicts.flatMap((conflict) => {
    const from = stepMap.get(conflict.fromStepId)
    const to = stepMap.get(conflict.toStepId)
    return from && to ? [{ conflict, from, to }] : []
  })
  if (conflictSteps.length === 0) return steps

  const prompt = buildConflictFixPrompt(conflictSteps)
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
        "你是 Galgame 剧情编辑，负责修复优化步骤之间的衔接冲突。",
        "只输出修正后的冲突步骤 scope 和 constraints，不改 type、不改 title、不改 reason、不改 intent。",
        "必须严格输出 JSON，不能输出解释文字。",
      ].join("\n"),
    },
    { role: "user", content: prompt },
  ], callbacks, undefined, { temperature: 0.2 })
  if (streamError) return steps

  const fixes = parseFixesResponse(raw)
  for (const fix of fixes) {
    const step = stepMap.get(fix.stepId)
    if (step) {
      if (fix.scope) step.scope = fix.scope
      if (fix.constraints) step.constraints = fix.constraints
    }
  }
  return [...stepMap.values()]
}

function buildConflictFixPrompt(
  conflictSteps: Array<{ conflict: StepCoherenceConflict; from: GalLonglineOptimizationStep; to: GalLonglineOptimizationStep }>,
): string {
  const fixIds = [...new Set(conflictSteps.flatMap(({ from, to }) => [from.id, to.id]))]

  return [
    "修复以下步骤之间的衔接冲突。",
    "",
    "## 输出 JSON",
    JSON.stringify({ fixes: fixIds.map((id) => ({ stepId: id, scope: "修正后的 scope", constraints: ["修正后的 constraints"] })) }, null, 2),
    "",
    "## 冲突列表",
    conflictSteps.map(({ conflict }) => `[${conflict.fromStepId}] ↔ [${conflict.toStepId}]: ${conflict.detail}`).join("\n"),
    "",
    "## 涉及步骤",
    conflictSteps.flatMap(({ from, to }) => [
      `### ${from.id}\ntype: ${from.type}\nscope: ${from.scope}\nconstraints: ${from.constraints.join("；") || "无"}`,
      `### ${to.id}\ntype: ${to.type}\nscope: ${to.scope}\nconstraints: ${to.constraints.join("；") || "无"}`,
    ]).join("\n\n"),
    "",
    "只修改 scope 和 constraints。",
  ].join("\n")
}

// ═══════════════════════════════════════════════════════════════
// 解析辅助
// ═══════════════════════════════════════════════════════════════

function parsePlanStepResponse(raw: string): Partial<GalLonglineOptimizationStep> {
  const jsonText = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.match(/\{[\s\S]*\}/)?.[0]
    ?? raw.match(/\{[\s\S]*\}/)?.[0]
  if (!jsonText) throw new Error("Plan step 生成失败：LLM 未返回有效 JSON。")
  return JSON.parse(jsonText)
}

function parseCoherenceResponse(raw: string): StepCoherenceReport {
  const jsonText = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.match(/\{[\s\S]*\}/)?.[0]
    ?? raw.match(/\{[\s\S]*\}/)?.[0]
  if (!jsonText) return { ok: true, conflicts: [] }
  const parsed = JSON.parse(jsonText) as Partial<StepCoherenceReport>
  return {
    ok: parsed.ok === true,
    conflicts: Array.isArray(parsed.conflicts)
      ? parsed.conflicts.map((c) => ({
        fromStepId: String(c?.fromStepId ?? ""),
        toStepId: String(c?.toStepId ?? ""),
        detail: String(c?.detail ?? ""),
      })).filter((c) => c.fromStepId && c.toStepId)
      : [],
  }
}

function parseFixesResponse(raw: string): Array<{ stepId: string; scope?: string; constraints?: string[] }> {
  const jsonText = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.match(/\{[\s\S]*\}/)?.[0]
    ?? raw.match(/\{[\s\S]*\}/)?.[0]
  if (!jsonText) return []
  try {
    const parsed = JSON.parse(jsonText) as { fixes?: Array<{ stepId?: string; scope?: string; constraints?: string[] }> }
    return (parsed.fixes ?? []).map((f) => ({
      stepId: String(f?.stepId ?? ""),
      scope: f?.scope ? String(f.scope) : undefined,
      constraints: f?.constraints && Array.isArray(f.constraints)
        ? f.constraints.map((c) => String(c ?? "")).filter(Boolean)
        : undefined,
    })).filter((f) => f.stepId)
  } catch { return [] }
}

function normalizePlanStep(parsed: Partial<GalLonglineOptimizationStep>, findingId: string): GalLonglineOptimizationStep {
  const type = normalizeStepType(parsed.type)
  return {
    id: `${findingId}_plan`,
    type,
    targetNodeId: parsed.targetNodeId?.trim() || undefined,
    afterNodeId: parsed.afterNodeId?.trim() || undefined,
    beforeNodeId: parsed.beforeNodeId?.trim() || undefined,
    title: parsed.title?.trim() || `${findingId}: ${type}`,
    reason: parsed.reason?.trim() || "",
    intent: parsed.intent?.trim() || "",
    scope: parsed.scope?.trim() || "",
    constraints: Array.isArray(parsed.constraints)
      ? parsed.constraints.map((c) => String(c ?? "").trim()).filter(Boolean)
      : [],
    priority: normalizePriority(parsed.priority),
    risk: normalizeRisk(parsed.risk),
  }
}

function buildAdjacentPairs(targetNodes: GalLonglineReviewNodeInput[]): Set<string> {
  const pairs = new Set<string>()
  for (let index = 0; index < targetNodes.length - 1; index += 1) {
    pairs.add(`${targetNodes[index].node.id}->${targetNodes[index + 1].node.id}`)
  }
  return pairs
}

// ═══════════════════════════════════════════════════════════════
// 已有辅助函数（保留）
// ═══════════════════════════════════════════════════════════════

function buildAllowedOptimizationNodeIds(params: GalLonglineOptimizationParams): Set<string> {
  if (params.mode === "missing_only") {
    return new Set(params.targetNodes.filter(({ script }) => !script.trim()).map(({ node }) => node.id))
  }
  if (params.mode === "problem_nodes" && params.reviewReport) {
    return new Set([
      ...params.reviewReport.issues
        .filter((item) => !isLonglineChoiceStructureIssue(item))
        .map((item) => item.nodeId),
      ...params.reviewReport.missingScripts.map((item) => item.nodeId),
      ...params.reviewReport.continuityBreaks.flatMap((item) => [item.fromNodeId, item.toNodeId]),
      ...params.reviewReport.rewriteTargets
        .filter((item) => !isLonglineChoiceStructureIssue(item))
        .map((item) => item.nodeId),
    ])
  }
  return new Set(params.targetNodes.map(({ node }) => node.id))
}

async function buildLonglineContextReference(params: GalLonglineOptimizationParams): Promise<string> {
  const anchorNode = params.targetNodes[0]?.node
  if (!params.projectPath || !anchorNode) {
    return "未提供项目路径；仅使用下方长线节点、边界节点、项目 premise 与 globalRules。"
  }
  try {
    const pack = await buildGalContextPack(
      params.projectPath,
      `为长线剧情「${params.route.title}」生成${modeText(params.mode)}方案`,
      params.route.id,
      anchorNode.id,
    )
    return formatContextReference(pack)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return `项目核心上下文加载失败：${message}。`
  }
}

function formatContextReference(pack: GalContextPack): string {
  const sections: string[] = []
  const add = (title: string, content: string, maxLength: number) => {
    const text = content.trim()
    if (text) sections.push(`### ${title}\n${limitContextText(text, maxLength)}`)
  }

  add("项目灵魂文档（写作风格与硬规则）", pack.soulDoc, 5000)
  add("作品大纲与世界观", pack.outline, 7000)
  add("角色状态（来自项目记忆库）", pack.novelCharacterStates, 5000)
  add("角色档案", pack.characterProfiles, 5000)
  add("项目设定文档", pack.projectDocs, 3000)
  add("Gal 全局设定", pack.premise, 2500)
  add("不可违背的规则", pack.globalRules, 3000)
  add("当前线路主题", pack.routeTheme, 1500)
  add("路径摘要（从入口到当前）", pack.pathSummary, 3000)
  add("当前变量状态", pack.variableState, 2000)
  add("角色情绪", pack.characterMoods, 2000)
  add("已获线索", pack.acquiredClues, 2000)
  add("角色认知（谁知道什么）", pack.characterCognition, 3000)

  return sections.length
    ? [
        "这些内容优先级高于泛化剧情套路。",
        sections.join("\n\n"),
      ].join("\n\n")
    : "未读取到额外核心上下文。"
}

function limitContextText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  const headLength = Math.floor(maxLength * 0.65)
  const tailLength = maxLength - headLength
  return `${text.slice(0, headLength).trim()}\n\n……（中间内容已截断，保留首尾以防跑偏）……\n\n${text.slice(-tailLength).trim()}`
}

function modeText(mode: GalLonglineOptimizeMode): string {
  if (mode === "missing_only") return "只补缺失正文"
  if (mode === "problem_nodes") return "优化有问题节点"
  if (mode === "story_enhance") return "剧情增强/扩写长线"
  return "优化整段长线"
}

function normalizeStepType(value: unknown): GalLonglineOptimizationStepType {
  return value === "rewrite_node" || value === "insert_bridge_node" || value === "skip" ? value : "rewrite_node"
}

function normalizePriority(value: unknown): GalLonglineOptimizationPriority {
  return value === "low" || value === "medium" || value === "high" ? value : "medium"
}

function normalizeRisk(value: unknown): GalLonglineOptimizationRisk {
  return value === "low" || value === "medium" || value === "high" ? value : "medium"
}

function isExecutablePlanStep(
  item: GalLonglineOptimizationStep,
  targetIds: Set<string>,
  adjacentPairs: Set<string>,
): boolean {
  if (!item.reason || !item.intent || !item.scope) return false
  if (item.type === "insert_bridge_node") {
    return Boolean(item.afterNodeId && item.beforeNodeId && adjacentPairs.has(`${item.afterNodeId}->${item.beforeNodeId}`))
  }
  if (!item.targetNodeId || !targetIds.has(item.targetNodeId)) return false
  return item.type === "rewrite_node" || item.type === "skip"
}
