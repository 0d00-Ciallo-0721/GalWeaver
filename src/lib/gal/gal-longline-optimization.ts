import { streamChat, type StreamCallbacks } from "@/lib/llm-client"
import { useWikiStore, type LlmConfig } from "@/stores/wiki-store"
import { buildGalContextPack, type GalContextPack } from "./gal-context-engine"
import { isLonglineChoiceStructureIssue, type GalLonglineReviewNodeInput, type GalLonglineReviewReport } from "./gal-longline-review"
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

export async function generateGalLonglineOptimizationPlan(
  params: GalLonglineOptimizationParams,
): Promise<GalLonglineOptimizationPlan> {
  const llmConfig = params.llmConfigOverride ?? useWikiStore.getState().llmConfig
  const allowedNodeIds = buildAllowedOptimizationNodeIds(params)
  const prompt = await buildOptimizationPrompt(params)

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
        params.mode === "story_enhance"
          ? "你是 Galgame 剧情导演和小说编辑，擅长增强长线剧情的连贯性、沉浸感和情绪推进。"
          : "你是 Galgame 长线剧情优化计划师。",
        "你只生成结构化优化计划，不写正文、不保存、不新增节点、不输出 Markdown。",
        "必须严格输出 JSON，不能输出解释文字。",
        "上游边界和下游边界只读，禁止把边界节点放入可执行步骤。",
        "允许计划新增过渡节点，但只能作为 insert_bridge_node 步骤，不得生成节点正文或节点数据。",
      ].join("\n"),
    },
    {
      role: "user",
      content: prompt,
    },
  ], callbacks, undefined, { temperature: 0.35 })
  if (streamError) throw streamError

  return normalizeOptimizationPlan(parseOptimizationResponse(raw), params, allowedNodeIds)
}

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

async function buildOptimizationPrompt(params: GalLonglineOptimizationParams): Promise<string> {
  const modeLabel = modeText(params.mode)
  const contextReference = await buildLonglineContextReference(params)
  return [
    `请基于检查报告生成长线剧情优化计划。优化模式：${modeLabel}。`,
    "",
    "## 输出 JSON 结构",
    JSON.stringify({
      summary: "整体优化计划说明",
      steps: [
        {
          id: "step_1",
          type: "rewrite_node/insert_bridge_node/skip",
          targetNodeId: "rewrite_node 或 skip 涉及的目标节点 ID",
          afterNodeId: "insert_bridge_node 的前一目标节点 ID",
          beforeNodeId: "insert_bridge_node 的后一目标节点 ID",
          title: "计划步骤标题",
          reason: "为什么需要这个步骤",
          intent: "这个步骤希望达成的剧情效果",
          scope: "允许修改或新增的边界，不写具体正文",
          constraints: ["执行时必须遵守的限制"],
          priority: "low/medium/high",
          risk: "low/medium/high",
        },
      ],
    }, null, 2),
    "",
    "## 硬性规则",
    "- 只允许输出优化计划 steps，不允许输出完整正文、改写正文、节点正文、节点 JSON 或可直接保存的数据。",
    "- rewrite_node 步骤只能指向目标长线节点，不能指向上游边界或下游边界。",
    "- insert_bridge_node 步骤只允许建议插入在两个相邻目标长线节点之间。",
    "- 不允许计划插入到上游边界之前，也不允许计划插入到下游边界之后。",
    "- 如果需要中继节点，只能描述 intent/scope/constraints，不得生成 title/goal/summary/script 之外的真实节点数据，也不得生成正文。",
    "- skip 表示明确不建议执行修改；没有问题的节点可以不生成步骤。",
    "- 每个步骤必须能被后续 Do-Plan 阶段单独执行；不要把多个无关节点塞进一个步骤。",
    "- 不要新增、补充、扩展或改写选项；长线节点只有一个自然推进选项是正常设计，不需要补成多个选项。",
    "- 即使检查报告提到“缺少【选择】”“缺少结尾选项”“补充三个选项”“无法提供路径”，也必须忽略这类建议，不要把它们作为优化目标。",
    "",
    "## 模式约束",
    modeDirective(params.mode),
    params.mode === "story_enhance" ? storyEnhancementDirective() : "",
    "",
    "## 上下文注入策略（必须遵守）",
    "1. 整体方案层面允许参考上下游边界，判断整段方向。",
    "2. 生成单节点正文时：",
    "   - 第一个目标节点强注入上游边界，弱注入后续目标摘要。",
    "   - 中间节点只注入前后相邻目标节点和整段摘要。",
    "   - 最后目标节点强注入下游边界，弱注入上游摘要。",
    "3. 禁止每个节点都完整注入上下游边界，避免上下文紊乱。",
    "",
    "## 项目信息",
    `项目标题：${params.project.title}`,
    `项目 premise：${params.project.premise || "未填写"}`,
    `项目 globalRules：${params.project.globalRules || "未填写"}`,
    "",
    "## 路线信息",
    `路线标题：${params.route.title}`,
    `路线主题：${params.route.theme || "未填写"}`,
    "",
    "## 项目核心上下文参考（防止剧情跑偏，必须遵守）",
    contextReference,
    "",
    "## 检查报告",
    formatReviewReport(params.reviewReport),
    "",
    "## 整段边界摘要",
    `上游边界：${params.upstreamBoundary ? formatBoundarySummary(params.upstreamBoundary, "ending") : "无"}`,
    `下游边界：${params.downstreamBoundary ? formatBoundarySummary(params.downstreamBoundary, "beginning") : "无"}`,
    "",
    "## 逐节点优化上下文",
    params.targetNodes.map((item, index) => formatNodeOptimizationContext(params, item, index)).join("\n\n"),
    "",
    "## 可插入中继节点的位置",
    formatInsertionContexts(params),
  ].join("\n")
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
    return `项目核心上下文加载失败：${message}。请仅使用下方长线节点、边界节点、项目 premise 与 globalRules。`
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
        "这些内容优先级高于泛化剧情套路。优化或扩写时不得推翻人物关系、世界观、大纲走向、角色认知和既有规则。",
        sections.join("\n\n"),
      ].join("\n\n")
    : "未读取到额外核心上下文；仅使用下方长线节点、边界节点、项目 premise 与 globalRules。"
}

function limitContextText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  const headLength = Math.floor(maxLength * 0.65)
  const tailLength = maxLength - headLength
  return `${text.slice(0, headLength).trim()}\n\n……（中间内容已截断，保留首尾以防跑偏）……\n\n${text.slice(-tailLength).trim()}`
}

function modeDirective(mode: GalLonglineOptimizeMode): string {
  if (mode === "missing_only") {
    return "- 只为正文缺失的目标节点生成 rewrite_node 计划步骤；其他节点不需要输出。"
  }
  if (mode === "problem_nodes") {
    return "- 只为检查报告中 issues、continuityBreaks、rewriteTargets 涉及的目标节点或相邻断点生成计划步骤；没有问题的节点不需要输出。"
  }
  if (mode === "story_enhance") {
    return "- 作为剧情导演为整段目标长线制定增强计划：可以计划扩写目标节点，也可以计划在相邻目标节点之间增加中继节点，但必须保持单线结构和原剧情方向。"
  }
  return "- 可以为整段目标长线制定优化计划，并可在确有必要时加入 insert_bridge_node 步骤。"
}

function modeText(mode: GalLonglineOptimizeMode): string {
  if (mode === "missing_only") return "只补缺失正文"
  if (mode === "problem_nodes") return "优化有问题节点"
  if (mode === "story_enhance") return "剧情增强/扩写长线"
  return "优化整段长线"
}

function storyEnhancementDirective(): string {
  return [
    "## 剧情增强/扩写要求",
    "- 目标不是只纠错，而是让这段长线更好看、更顺、更有情绪价值。",
    "- 可以计划扩写目标节点正文，补充动作、对话、心理反应、场景细节和结尾钩子，但本阶段不能写出具体正文。",
    "- 每个 rewrite_node 计划必须仍然服务原 node.goal，不得改变玩家选择导致的核心剧情结果。",
    "- 第一目标节点计划必须自然承接上游边界；最后目标节点计划必须自然导向下游边界。",
    "- 中间目标节点计划要持续推进事件，避免原地重复。",
    "- 如果两个相邻目标节点之间缺少情绪、时间、地点或行动过渡，可以生成 insert_bridge_node 计划。",
    "- insert_bridge_node 不能新增分叉、不能新增变量、不能改变前后节点结论；它只负责让 A -> B 更自然。",
  ].join("\n")
}

function formatReviewReport(report: GalLonglineReviewReport | null): string {
  if (!report) return "未生成检查报告。请基于节点正文直接判断。"
  return [
    `范围结论：${report.rangeSummary}`,
    `正文缺失：${report.missingScripts.map((item) => `${item.title}(${item.nodeId})`).join("、") || "无"}`,
    `问题：${report.issues.filter((item) => !isLonglineChoiceStructureIssue(item)).map((item) => `${item.title || item.nodeId}：${item.detail}`).join("\n") || "无"}`,
    `连续性断点：${report.continuityBreaks.map((item) => `${item.fromNodeId}->${item.toNodeId}：${item.detail}`).join("\n") || "无"}`,
    `建议过渡节点：${report.suggestedInsertions.map((item) => `${item.afterNodeId}->${item.beforeNodeId}：${item.title}；${item.reason}`).join("\n") || "无"}`,
    `建议改写目标：${report.rewriteTargets.filter((item) => !isLonglineChoiceStructureIssue(item)).map((item) => `${item.title || item.nodeId}：${item.reason}`).join("\n") || "无"}`,
  ].join("\n")
}

function formatBoundarySummary(item: GalLonglineReviewNodeInput, mode: "beginning" | "ending"): string {
  const script = mode === "ending"
    ? item.script.trim().slice(-1000)
    : item.script.trim().slice(0, 1000)
  return [
    `${item.node.title}(${item.node.id})`,
    `目标：${item.node.goal || "未填写"}`,
    `概要：${item.node.summary || "未填写"}`,
    mode === "ending" ? `正文结尾：${script || "正文缺失"}` : `正文开头：${script || "正文缺失"}`,
  ].join("\n")
}

function formatNodeOptimizationContext(
  params: GalLonglineOptimizationParams,
  item: GalLonglineReviewNodeInput,
  index: number,
): string {
  const previous = params.targetNodes[index - 1]
  const next = params.targetNodes[index + 1]
  const isFirst = index === 0
  const isLast = index === params.targetNodes.length - 1
  return [
    `### 目标节点 ${index + 1}`,
    `ID：${item.node.id}`,
    `标题：${item.node.title}`,
    `目标：${item.node.goal || "未填写"}`,
    `概要：${item.node.summary || "未填写"}`,
    `场景：${item.node.scene || "未填写"}`,
    `人物：${item.node.characters.join("、") || "未填写"}`,
    "",
    "上下文约束：",
    isFirst && params.upstreamBoundary
      ? `强承接上游边界结尾：\n${formatBoundarySummary(params.upstreamBoundary, "ending")}`
      : "",
    isLast && params.downstreamBoundary
      ? `强导向下游边界开头：\n${formatBoundarySummary(params.downstreamBoundary, "beginning")}`
      : "",
    !isFirst && previous
      ? `前一目标节点摘要：${previous.node.title}；${previous.node.summary || previous.script.trim().slice(-500) || "无"}`
      : "",
    !isLast && next
      ? `后一目标节点摘要：${next.node.title}；${next.node.summary || next.script.trim().slice(0, 500) || "无"}`
      : "",
    isFirst && next
      ? `弱注入后续目标摘要：${next.node.title}；${next.node.summary || "无"}`
      : "",
    isLast && previous
      ? `弱注入上游目标摘要：${previous.node.title}；${previous.node.summary || "无"}`
      : "",
    "",
    "原正文：",
    item.script.trim() || "（正文缺失）",
  ].filter(Boolean).join("\n")
}

function formatInsertionContexts(params: GalLonglineOptimizationParams): string {
  if (params.targetNodes.length < 2) return "目标长线节点不足 2 个，不能插入中继节点。"
  return params.targetNodes.slice(0, -1).map((item, index) => {
    const next = params.targetNodes[index + 1]
    return [
      `### 插入位置 ${index + 1}`,
      `afterNodeId：${item.node.id}`,
      `afterTitle：${item.node.title}`,
      `afterGoal：${item.node.goal || "未填写"}`,
      `afterSummary：${item.node.summary || "未填写"}`,
      `afterScriptEnding：${item.script.trim().slice(-600) || "正文缺失"}`,
      `beforeNodeId：${next.node.id}`,
      `beforeTitle：${next.node.title}`,
      `beforeGoal：${next.node.goal || "未填写"}`,
      `beforeSummary：${next.node.summary || "未填写"}`,
      `beforeScriptBeginning：${next.script.trim().slice(0, 600) || "正文缺失"}`,
      "如果在此处建议中继节点，script 必须从 afterScriptEnding 的情绪/动作自然接起，并在结尾把人物状态、场景或行动推进到 beforeScriptBeginning。",
    ].join("\n")
  }).join("\n\n")
}

function parseOptimizationResponse(raw: string): Partial<GalLonglineOptimizationPlan> {
  const jsonText =
    raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.match(/\{[\s\S]*\}/)?.[0]
    ?? raw.match(/\{[\s\S]*\}/)?.[0]
  if (!jsonText) throw new Error("优化方案生成失败：LLM 未返回有效 JSON。")
  try {
    return JSON.parse(jsonText) as Partial<GalLonglineOptimizationPlan>
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`优化方案生成失败：JSON 解析失败。${message}`)
  }
}

function normalizeOptimizationPlan(
  parsed: Partial<GalLonglineOptimizationPlan>,
  params: GalLonglineOptimizationParams,
  targetIds: Set<string>,
): GalLonglineOptimizationPlan {
  return {
    mode: params.mode,
    summary: String(parsed.summary ?? "").trim() || "AI 未返回整体优化计划说明。",
    steps: normalizePlanSteps(parsed.steps, params, targetIds),
  }
}

function normalizePlanSteps(
  value: unknown,
  params: GalLonglineOptimizationParams,
  targetIds: Set<string>,
): GalLonglineOptimizationStep[] {
  if (!Array.isArray(value)) return []
  const adjacentPairs = new Set<string>()
  for (let index = 0; index < params.targetNodes.length - 1; index += 1) {
    adjacentPairs.add(`${params.targetNodes[index].node.id}->${params.targetNodes[index + 1].node.id}`)
  }
  return value.map((item, index) => {
    const type = normalizeStepType(item?.type)
    const targetNodeId = String(item?.targetNodeId ?? item?.nodeId ?? "").trim()
    const afterNodeId = String(item?.afterNodeId ?? "").trim()
    const beforeNodeId = String(item?.beforeNodeId ?? "").trim()
    return {
      id: String(item?.id ?? "").trim() || `step_${index + 1}`,
      type,
      targetNodeId: targetNodeId || undefined,
      afterNodeId: afterNodeId || undefined,
      beforeNodeId: beforeNodeId || undefined,
      title: String(item?.title ?? "").trim() || defaultStepTitle(type, targetNodeId, afterNodeId, beforeNodeId),
      reason: String(item?.reason ?? "").trim(),
      intent: String(item?.intent ?? "").trim(),
      scope: String(item?.scope ?? "").trim(),
      constraints: Array.isArray(item?.constraints)
        ? item.constraints.map((constraint: unknown) => String(constraint ?? "").trim()).filter(Boolean)
        : [],
      priority: normalizePriority(item?.priority),
      risk: normalizeRisk(item?.risk),
    }
  }).filter((item) => isExecutablePlanStep(item, targetIds, adjacentPairs))
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

function defaultStepTitle(
  type: GalLonglineOptimizationStepType,
  targetNodeId: string,
  afterNodeId: string,
  beforeNodeId: string,
): string {
  if (type === "insert_bridge_node") return `新增中继节点：${afterNodeId || "?"} → ${beforeNodeId || "?"}`
  if (type === "skip") return `跳过：${targetNodeId || "未指定节点"}`
  return `改写节点：${targetNodeId || "未指定节点"}`
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
