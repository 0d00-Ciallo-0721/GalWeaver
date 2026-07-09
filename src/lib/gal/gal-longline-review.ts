import { streamChat, type StreamCallbacks } from "@/lib/llm-client"
import { useWikiStore, type LlmConfig } from "@/stores/wiki-store"
import type { GalNode, GalProject, GalRoute } from "./gal-types"

export interface GalLonglineReviewNodeInput {
  node: GalNode
  script: string
}

export interface GalLonglineReviewParams {
  project: GalProject
  route: GalRoute
  upstreamBoundary: GalLonglineReviewNodeInput | null
  targetNodes: GalLonglineReviewNodeInput[]
  downstreamBoundary: GalLonglineReviewNodeInput | null
  llmConfigOverride?: LlmConfig
}

export interface GalLonglineIssue {
  nodeId: string
  title: string
  severity: "info" | "warning" | "error"
  category: string
  detail: string
}

export interface GalLonglineContinuityBreak {
  fromNodeId: string
  toNodeId: string
  type: "time" | "place" | "character" | "emotion" | "plot" | "other"
  detail: string
}

export interface GalLonglineSuggestedInsertion {
  afterNodeId: string
  beforeNodeId: string
  title: string
  reason: string
  goal: string
}

export interface GalLonglineRewriteTarget {
  nodeId: string
  title: string
  reason: string
}

export interface GalLonglineReviewReport {
  rangeSummary: string
  issues: GalLonglineIssue[]
  missingScripts: Array<{ nodeId: string; title: string }>
  continuityBreaks: GalLonglineContinuityBreak[]
  suggestedInsertions: GalLonglineSuggestedInsertion[]
  rewriteTargets: GalLonglineRewriteTarget[]
}

// ─── 编号发现 ──────────────────────────────────────────────

export interface GalLonglineFinding {
  id: string
  type: "issue" | "missingScript" | "continuityBreak" | "suggestedInsertion" | "rewriteTarget"
  nodeId?: string
  afterNodeId?: string
  beforeNodeId?: string
  title: string
  detail: string
}

export function extractFindings(report: GalLonglineReviewReport): GalLonglineFinding[] {
  const findings: GalLonglineFinding[] = []
  let counter = 0
  const nextId = () => { counter += 1; return `F-${counter}` }

  for (const item of report.missingScripts) {
    findings.push({
      id: nextId(), type: "missingScript",
      nodeId: item.nodeId, title: item.title,
      detail: `节点「${item.title}」正文缺失，需补全完整正文。`,
    })
  }
  for (const item of report.issues) {
    findings.push({
      id: nextId(), type: "issue",
      nodeId: item.nodeId, title: item.title || item.nodeId,
      detail: item.detail,
    })
  }
  for (const item of report.continuityBreaks) {
    findings.push({
      id: nextId(), type: "continuityBreak",
      afterNodeId: item.fromNodeId, beforeNodeId: item.toNodeId,
      title: `${item.fromNodeId} -> ${item.toNodeId}`,
      detail: `类型：${item.type}；${item.detail}`,
    })
  }
  for (const item of report.suggestedInsertions) {
    findings.push({
      id: nextId(), type: "suggestedInsertion",
      afterNodeId: item.afterNodeId, beforeNodeId: item.beforeNodeId,
      title: item.title,
      detail: `建议在 ${item.afterNodeId} -> ${item.beforeNodeId} 之间插入过渡节点：${item.reason}。目标：${item.goal}`,
    })
  }
  for (const item of report.rewriteTargets) {
    findings.push({
      id: nextId(), type: "rewriteTarget",
      nodeId: item.nodeId, title: item.title || item.nodeId,
      detail: item.reason,
    })
  }
  return findings
}

export async function reviewGalLongline(params: GalLonglineReviewParams): Promise<GalLonglineReviewReport> {
  const llmConfig = params.llmConfigOverride ?? useWikiStore.getState().llmConfig
  const targetIds = new Set(params.targetNodes.map(({ node }) => node.id))
  const missingScripts = params.targetNodes
    .filter(({ script }) => !script.trim())
    .map(({ node }) => ({ nodeId: node.id, title: node.title }))
  const prompt = buildLonglineReviewPrompt(params, missingScripts)

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
        "你是 Galgame 长线剧情连续性审稿人。",
        "你只做检查报告，不改写正文，不新增真实节点，不输出 Markdown。",
        "必须严格输出 JSON，不能输出解释文字。",
        "上游边界节点和下游边界节点是只读边界，不能建议修改它们，也不能把它们放入 rewriteTargets。",
      ].join("\n"),
    },
    {
      role: "user",
      content: prompt,
    },
  ], callbacks, undefined, { temperature: 0.2 })
  if (streamError) throw streamError

  const parsed = parseReviewResponse(raw)
  return normalizeReviewReport(parsed, missingScripts, targetIds)
}

function buildLonglineReviewPrompt(
  params: GalLonglineReviewParams,
  missingScripts: Array<{ nodeId: string; title: string }>,
): string {
  return [
    "请检查这段 Galgame 长线剧情是否连贯。",
    "",
    "## 输出 JSON 结构",
    JSON.stringify({
      rangeSummary: "一句话概括这段长线剧情的整体问题或状态",
      issues: [
        { nodeId: "目标节点 ID", title: "节点标题", severity: "warning", category: "正文缺失/承接/导向/跳变/重复/目标冲突", detail: "问题说明" },
      ],
      missingScripts: [
        { nodeId: "正文缺失的目标节点 ID", title: "节点标题" },
      ],
      continuityBreaks: [
        { fromNodeId: "上一个目标节点 ID", toNodeId: "下一个目标节点 ID", type: "time", detail: "跳变说明" },
      ],
      suggestedInsertions: [
        { afterNodeId: "前一目标节点 ID", beforeNodeId: "后一目标节点 ID", title: "建议过渡节点标题", reason: "为什么需要", goal: "过渡节点目标" },
      ],
      rewriteTargets: [
        { nodeId: "只允许目标节点 ID", title: "节点标题", reason: "建议改写原因" },
      ],
    }, null, 2),
    "",
    "## 硬性规则",
    "- 只检查目标长线节点。",
    "- 上游边界和下游边界只用于判断承接与导向，不能建议修改。",
    "- rewriteTargets 只能包含目标长线节点，不能包含边界节点。",
    "- missingScripts 只列出目标长线节点正文缺失。",
    "- 如果建议新增过渡节点，只能放在 suggestedInsertions，不要直接生成节点数据。",
    "- 长线剧情目标节点允许只有一个自然推进选项；不要把“选项数量不足”“只有一个选项”“不利于分支”当成问题。",
    "- 不要建议新增、补充、扩展或改写选项；不要把“缺少【选择】部分”“缺少结尾选项”“无法提供路径”当成问题。",
    "- 本检查只判断正文连续性，不检查选项数量、分支丰富度、玩家选择数量或选项完整度。",
    "- 如果没有问题，对应数组输出空数组。",
    "",
    "## 检查重点",
    "1. 正文缺失。",
    "2. 第一个目标节点是否承接上游边界。",
    "3. 最后一个目标节点是否导向下游边界。",
    "4. 节点间是否有时间/地点/人物/情绪跳变。",
    "5. 是否重复描写、原地打转。",
    "6. 是否和节点 goal/summary 冲突。",
    "7. 是否建议新增过渡节点。",
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
    "## 已检测到的正文缺失目标节点",
    missingScripts.length
      ? missingScripts.map((item) => `- ${item.title} (${item.nodeId})`).join("\n")
      : "无",
    "",
    "## 上游边界节点（只读，只用于判断第一个目标节点是否承接）",
    params.upstreamBoundary ? formatBoundary(params.upstreamBoundary, "ending") : "无上游边界",
    "",
    "## 目标长线节点（完整正文，按顺序检查）",
    params.targetNodes.map((item, index) => formatTargetNode(item, index)).join("\n\n"),
    "",
    "## 下游边界节点（只读，只用于判断最后一个目标节点是否导向）",
    params.downstreamBoundary ? formatBoundary(params.downstreamBoundary, "beginning") : "无下游边界",
  ].join("\n")
}

function formatNodeMeta(node: GalNode): string {
  return [
    `ID：${node.id}`,
    `标题：${node.title}`,
    `类型：${node.type}`,
    `状态：${node.status}`,
    `目标：${node.goal || "未填写"}`,
    `概要：${node.summary || "未填写"}`,
    `场景：${node.scene || "未填写"}`,
    `人物：${node.characters.join("、") || "未填写"}`,
  ].join("\n")
}

function formatBoundary(item: GalLonglineReviewNodeInput, mode: "beginning" | "ending"): string {
  const rawScript = mode === "ending"
    ? item.script.trim().slice(-1200)
    : item.script.trim().slice(0, 1200)
  // 剥离【选择】块，防止下游边界的选项污染审稿人的判断
  const script = rawScript.replace(/【选择】[\s\S]*$/, "（选项部分已略去，只读边界不评估选项结构）").trim()
  return [
    `ID：${item.node.id}`,
    `标题：${item.node.title}`,
    `概要：${item.node.summary || "未填写"}`,
    // 不注入 node.goal——下游边界的 goal 常含 "需要生成选项" 等设计笔记，不应喂给 AI
    mode === "ending" ? "正文结尾：" : "正文开头：",
    script || "（正文缺失）",
  ].join("\n")
}

function formatTargetNode(item: GalLonglineReviewNodeInput, index: number): string {
  return [
    `### 目标节点 ${index + 1}`,
    formatNodeMeta(item.node),
    "完整正文：",
    item.script.trim() || "（正文缺失）",
  ].join("\n")
}

function parseReviewResponse(raw: string): Partial<GalLonglineReviewReport> {
  const jsonText =
    raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.match(/\{[\s\S]*\}/)?.[0]
    ?? raw.match(/\{[\s\S]*\}/)?.[0]
  if (!jsonText) throw new Error("长线检查失败：LLM 未返回有效 JSON。")
  try {
    return JSON.parse(jsonText) as Partial<GalLonglineReviewReport>
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`长线检查失败：JSON 解析失败。${message}`)
  }
}

function normalizeReviewReport(
  parsed: Partial<GalLonglineReviewReport>,
  detectedMissingScripts: Array<{ nodeId: string; title: string }>,
  targetIds: Set<string>,
): GalLonglineReviewReport {
  const missingById = new Map<string, { nodeId: string; title: string }>()
  for (const item of detectedMissingScripts) {
    missingById.set(item.nodeId, item)
  }
  for (const item of Array.isArray(parsed.missingScripts) ? parsed.missingScripts : []) {
    const nodeId = String(item?.nodeId ?? "").trim()
    if (targetIds.has(nodeId)) {
      missingById.set(nodeId, { nodeId, title: String(item?.title ?? nodeId).trim() || nodeId })
    }
  }

  return {
    rangeSummary: String(parsed.rangeSummary ?? "").trim() || "AI 未返回范围摘要。",
    issues: normalizeIssues(parsed.issues, targetIds),
    missingScripts: Array.from(missingById.values()),
    continuityBreaks: normalizeBreaks(parsed.continuityBreaks, targetIds),
    suggestedInsertions: normalizeInsertions(parsed.suggestedInsertions, targetIds),
    rewriteTargets: normalizeRewriteTargets(parsed.rewriteTargets, targetIds),
  }
}

function normalizeIssues(value: unknown, targetIds: Set<string>): GalLonglineIssue[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => ({
    nodeId: String(item?.nodeId ?? "").trim(),
    title: String(item?.title ?? "").trim(),
    severity: normalizeSeverity(item?.severity),
    category: String(item?.category ?? "").trim(),
    detail: String(item?.detail ?? "").trim(),
  })).filter((item) => targetIds.has(item.nodeId) && item.detail && !isLonglineChoiceStructureIssue(item))
}

function normalizeBreaks(value: unknown, targetIds: Set<string>): GalLonglineContinuityBreak[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => ({
    fromNodeId: String(item?.fromNodeId ?? "").trim(),
    toNodeId: String(item?.toNodeId ?? "").trim(),
    type: normalizeBreakType(item?.type),
    detail: String(item?.detail ?? "").trim(),
  })).filter((item) => targetIds.has(item.fromNodeId) && targetIds.has(item.toNodeId) && item.detail)
}

function normalizeInsertions(value: unknown, targetIds: Set<string>): GalLonglineSuggestedInsertion[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => ({
    afterNodeId: String(item?.afterNodeId ?? "").trim(),
    beforeNodeId: String(item?.beforeNodeId ?? "").trim(),
    title: String(item?.title ?? "").trim(),
    reason: String(item?.reason ?? "").trim(),
    goal: String(item?.goal ?? "").trim(),
  })).filter((item) => targetIds.has(item.afterNodeId) && targetIds.has(item.beforeNodeId) && item.reason)
}

function normalizeRewriteTargets(value: unknown, targetIds: Set<string>): GalLonglineRewriteTarget[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => ({
    nodeId: String(item?.nodeId ?? "").trim(),
    title: String(item?.title ?? "").trim(),
    reason: String(item?.reason ?? "").trim(),
  })).filter((item) => targetIds.has(item.nodeId) && item.reason && !isLonglineChoiceStructureIssue(item))
}

function normalizeSeverity(value: unknown): GalLonglineIssue["severity"] {
  return value === "info" || value === "warning" || value === "error" ? value : "warning"
}

export function isLonglineChoiceStructureIssue(item: Pick<GalLonglineIssue, "category" | "detail"> | Pick<GalLonglineRewriteTarget, "reason">): boolean {
  const text = "reason" in item
    ? item.reason.toLowerCase()
    : `${item.category}\n${item.detail}`.toLowerCase()
  return [
    "选项数量",
    "選項數量",
    "选项不足",
    "選項不足",
    "选项缺失",
    "選項缺失",
    "只有一个选项",
    "只有一個選項",
    "只提供了一个选项",
    "只提供了一個選項",
    "未提供任何选项",
    "未提供任何選項",
    "缺少【选择】",
    "缺少【選擇】",
    "缺少选择",
    "缺少選擇",
    "缺少结尾选项",
    "缺少結尾選項",
    "结尾选项",
    "結尾選項",
    "添加结尾选项",
    "添加結尾選項",
    "新增选项",
    "新增選項",
    "增加选项",
    "增加選項",
    "补充选项",
    "補充選項",
    "补全选项",
    "補全選項",
    "补充三个选项",
    "補充三個選項",
    "补充三项选项",
    "補充三項選項",
    "三个选项",
    "三個選項",
    "三项选项",
    "三項選項",
    "不利于线路分支",
    "不利於線路分支",
    "无法提供路径",
    "無法提供路徑",
    "无法导向下游",
    "無法導向下游",
    "player choice",
    "choice count",
    "missing choice",
    "add choice",
    "add option",
    "more options",
    "only one option",
    // 新增变体：审查报告和计划阶段常见的选项相关漏网表述
    "结尾没有选项",
    "結尾沒有選項",
    "添加选项",
    "添加選項",
    "生成选项",
    "生成選項",
    "补全选项",
    "補全選項",
    "输出选项",
    "輸出選項",
  ].some((keyword) => text.includes(keyword))
}

function normalizeBreakType(value: unknown): GalLonglineContinuityBreak["type"] {
  return value === "time" || value === "place" || value === "character" || value === "emotion" || value === "plot"
    ? value
    : "other"
}
