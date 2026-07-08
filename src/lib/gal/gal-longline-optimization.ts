import { streamChat, type StreamCallbacks } from "@/lib/llm-client"
import { useWikiStore, type LlmConfig } from "@/stores/wiki-store"
import type { GalLonglineReviewNodeInput, GalLonglineReviewReport } from "./gal-longline-review"
import type { GalProject, GalRoute } from "./gal-types"

export type GalLonglineOptimizeMode = "missing_only" | "problem_nodes" | "whole_range" | "story_enhance"

export type GalLonglineOptimizeSuggestion = "keep" | "rewrite" | "patch"

export interface GalLonglineOptimizationParams {
  project: GalProject
  route: GalRoute
  mode: GalLonglineOptimizeMode
  reviewReport: GalLonglineReviewReport | null
  upstreamBoundary: GalLonglineReviewNodeInput | null
  targetNodes: GalLonglineReviewNodeInput[]
  downstreamBoundary: GalLonglineReviewNodeInput | null
  llmConfigOverride?: LlmConfig
}

export interface GalLonglineNodeOptimization {
  nodeId: string
  title: string
  originalScript: string
  optimizedScript: string
  reason: string
  suggestion: GalLonglineOptimizeSuggestion
}

export interface GalLonglineSuggestedNodeInsertion {
  id: string
  afterNodeId: string
  beforeNodeId: string
  title: string
  goal: string
  summary: string
  script: string
  reason: string
}

export interface GalLonglineOptimizationPlan {
  mode: GalLonglineOptimizeMode
  summary: string
  nodeOptimizations: GalLonglineNodeOptimization[]
  suggestedInsertions: GalLonglineSuggestedNodeInsertion[]
}

export async function generateGalLonglineOptimizationPlan(
  params: GalLonglineOptimizationParams,
): Promise<GalLonglineOptimizationPlan> {
  const llmConfig = params.llmConfigOverride ?? useWikiStore.getState().llmConfig
  const allowedNodeIds = buildAllowedOptimizationNodeIds(params)
  const prompt = buildOptimizationPrompt(params)

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
          : "你是 Galgame 长线剧情正文优化编辑。",
        "你只生成优化预览方案，不保存、不新增节点、不输出 Markdown。",
        "必须严格输出 JSON，不能输出解释文字。",
        "上游边界和下游边界只读，禁止改写边界节点，禁止把边界节点放入 nodeOptimizations。",
        "允许在 suggestedInsertions 中提出过渡节点建议，但只能作为预览方案，禁止直接写入项目。",
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
      ...params.reviewReport.issues.map((item) => item.nodeId),
      ...params.reviewReport.missingScripts.map((item) => item.nodeId),
      ...params.reviewReport.continuityBreaks.flatMap((item) => [item.fromNodeId, item.toNodeId]),
      ...params.reviewReport.rewriteTargets.map((item) => item.nodeId),
    ])
  }
  return new Set(params.targetNodes.map(({ node }) => node.id))
}

function buildOptimizationPrompt(params: GalLonglineOptimizationParams): string {
  const modeLabel = modeText(params.mode)
  return [
    `请基于检查报告生成长线剧情优化预览方案。优化模式：${modeLabel}。`,
    "",
    "## 输出 JSON 结构",
    JSON.stringify({
      summary: "整体优化说明",
      nodeOptimizations: [
        {
          nodeId: "目标节点 ID",
          title: "节点标题",
          optimizedScript: "AI 优化后的完整正文",
          reason: "修改原因",
          suggestion: "keep/rewrite/patch",
        },
      ],
      suggestedInsertions: [
        {
          afterNodeId: "前一个目标节点 ID",
          beforeNodeId: "后一个目标节点 ID",
          title: "新增过渡节点标题",
          goal: "新增节点剧情目标",
          summary: "新增节点概要",
          script: "新增节点完整正文",
          reason: "为什么需要插入",
        },
      ],
    }, null, 2),
    "",
    "## 硬性规则",
    "- 只允许输出目标长线节点的优化方案。",
    "- 不允许输出上游边界节点或下游边界节点的优化方案。",
    "- suggestedInsertions 只允许建议插入在两个相邻目标长线节点之间。",
    "- 不允许插入到上游边界之前，也不允许插入到下游边界之后。",
    "- suggestedInsertions 必须包含完整 title、goal、summary、script、reason；没有完整正文就不要输出该建议。",
    "- 如果需要中继节点，必须基于前后相邻目标节点生成基础信息，并确保剧情入口承接 afterNodeId、剧情出口导向 beforeNodeId。",
    "- suggestedInsertions 只是预览建议，不会自动写入 project。",
    "- optimizedScript 必须是该目标节点的完整正文，不要只给片段。",
    "- suggestion 只能是 keep、rewrite、patch。",
    "- keep 表示原文基本保留；rewrite 表示建议整段重写；patch 表示局部补丁式优化。",
    "- 如果某个目标节点无需优化，可以不放入 nodeOptimizations，或放入 suggestion=keep 且 optimizedScript 等于原文。",
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

function modeDirective(mode: GalLonglineOptimizeMode): string {
  if (mode === "missing_only") {
    return "- 只为正文缺失的目标节点生成 optimizedScript；其他节点不需要输出。"
  }
  if (mode === "problem_nodes") {
    return "- 只优化检查报告中 issues、continuityBreaks、rewriteTargets 涉及的目标节点；没有问题的节点不需要输出。"
  }
  if (mode === "story_enhance") {
    return "- 作为剧情导演增强整段目标长线：允许扩写目标节点正文，允许在相邻目标节点之间建议中继节点，但必须保持单线结构和原剧情方向。"
  }
  return "- 可以优化整段目标长线，并可在确有必要时建议新增过渡节点；新增节点只能放在 suggestedInsertions。"
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
    "- 可以扩写目标节点正文，补充动作、对话、心理反应、场景细节和结尾钩子。",
    "- 每个被改写的目标节点必须仍然服务原 node.goal，不得改变玩家选择导致的核心剧情结果。",
    "- 第一目标节点必须自然承接上游边界；最后目标节点必须自然导向下游边界。",
    "- 中间目标节点要持续推进事件，避免原地重复。",
    "- 如果两个相邻目标节点之间缺少情绪、时间、地点或行动过渡，可以建议新增一个中继节点。",
    "- 中继节点不能新增分叉、不能新增变量、不能改变前后节点结论；它只负责让 A -> B 更自然。",
    "- 中继节点 script 必须是完整正文，且正文开头承接 afterNodeId，正文结尾导向 beforeNodeId。",
  ].join("\n")
}

function formatReviewReport(report: GalLonglineReviewReport | null): string {
  if (!report) return "未生成检查报告。请基于节点正文直接判断。"
  return [
    `范围结论：${report.rangeSummary}`,
    `正文缺失：${report.missingScripts.map((item) => `${item.title}(${item.nodeId})`).join("、") || "无"}`,
    `问题：${report.issues.map((item) => `${item.title || item.nodeId}：${item.detail}`).join("\n") || "无"}`,
    `连续性断点：${report.continuityBreaks.map((item) => `${item.fromNodeId}->${item.toNodeId}：${item.detail}`).join("\n") || "无"}`,
    `建议过渡节点：${report.suggestedInsertions.map((item) => `${item.afterNodeId}->${item.beforeNodeId}：${item.title}；${item.reason}`).join("\n") || "无"}`,
    `建议改写目标：${report.rewriteTargets.map((item) => `${item.title || item.nodeId}：${item.reason}`).join("\n") || "无"}`,
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
  const originalById = new Map(params.targetNodes.map((item) => [item.node.id, item]))
  const nodeOptimizations = Array.isArray(parsed.nodeOptimizations)
    ? parsed.nodeOptimizations.map((item) => {
        const nodeId = String(item?.nodeId ?? "").trim()
        const original = originalById.get(nodeId)
        return {
          nodeId,
          title: String(item?.title ?? original?.node.title ?? nodeId).trim() || nodeId,
          originalScript: original?.script ?? "",
          optimizedScript: String(item?.optimizedScript ?? "").trim(),
          reason: String(item?.reason ?? "").trim(),
          suggestion: normalizeSuggestion(item?.suggestion),
        }
      }).filter((item) => targetIds.has(item.nodeId) && item.optimizedScript)
    : []

  return {
    mode: params.mode,
    summary: String(parsed.summary ?? "").trim() || "AI 未返回整体优化说明。",
    nodeOptimizations,
    suggestedInsertions: normalizeSuggestedInsertions(parsed.suggestedInsertions, params),
  }
}

function normalizeSuggestion(value: unknown): GalLonglineOptimizeSuggestion {
  return value === "keep" || value === "rewrite" || value === "patch" ? value : "patch"
}

function normalizeSuggestedInsertions(
  value: unknown,
  params: GalLonglineOptimizationParams,
): GalLonglineSuggestedNodeInsertion[] {
  if (!Array.isArray(value)) return []
  const adjacentPairs = new Set<string>()
  for (let index = 0; index < params.targetNodes.length - 1; index += 1) {
    adjacentPairs.add(`${params.targetNodes[index].node.id}->${params.targetNodes[index + 1].node.id}`)
  }
  const normalized = value.map((item, index) => {
    const afterNodeId = String(item?.afterNodeId ?? "").trim()
    const beforeNodeId = String(item?.beforeNodeId ?? "").trim()
    return {
      id: `insert_${afterNodeId}_${beforeNodeId}_${index}`,
      afterNodeId,
      beforeNodeId,
      title: String(item?.title ?? "").trim(),
      goal: String(item?.goal ?? "").trim(),
      summary: String(item?.summary ?? "").trim(),
      script: String(item?.script ?? "").trim(),
      reason: String(item?.reason ?? "").trim(),
    }
  })
  const incompleteAdjacent = normalized.filter((item) =>
    adjacentPairs.has(`${item.afterNodeId}->${item.beforeNodeId}`)
    && (!item.title || !item.goal || !item.summary || !item.script || !item.reason)
  )
  if (params.mode === "story_enhance" && incompleteAdjacent.length > 0) {
    throw new Error("剧情增强生成了不完整的中继节点建议，已触发自动重试。中继节点必须包含标题、目标、摘要、完整正文和原因。")
  }
  return normalized.filter((item) =>
    adjacentPairs.has(`${item.afterNodeId}->${item.beforeNodeId}`)
    && item.title
    && item.goal
    && item.summary
    && item.script,
  )
}
