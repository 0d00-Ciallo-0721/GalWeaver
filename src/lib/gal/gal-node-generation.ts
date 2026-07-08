/**
 * Galgame 节点生成引擎
 *
 * 根据上下文引擎组装的上下文，调用 LLM 生成节点正文。
 *
 * 支持两种模式：
 * 1. 生成完整节点正文（write_node）
 * 2. 仅生成子节点卡片（expand_child_nodes）
 *
 * ponytail: 复用 streamChat 和 buildGalContextPack，不重复造轮子。
 */

import { streamChat, type StreamCallbacks } from "@/lib/llm-client"
import {
  buildEntryNodePrompt,
  buildNodeGenerationPrompt,
  buildChildNodeCardPrompt,
  buildChoiceLongLinePrompt,
  buildRelayNodeCardPrompt,
} from "./gal-prompts"
import { buildGalContextPack, galContextPackToPrompt } from "./gal-context-engine"
import {
  saveNodeScript,
  loadGalProject,
  loadNodeScript,
  saveGalProject,
} from "./gal-storage"
import type {
  GalNode,
  GalChoice,
  GalEffect,
  GalVariable,
} from "./gal-types"
import { sanitizeGalChoices, sanitizeGalEffects } from "./gal-variable-guard"
import { useWikiStore, type LlmConfig } from "@/stores/wiki-store"
import { parseFrontmatter } from "@/lib/frontmatter"
import { getOutputLanguage } from "@/lib/output-language"

// ─── 生成完整节点正文 ──────────────────────────────────────

export interface GenerateNodeParams {
  projectPath: string
  routeId: string
  nodeId: string
  llmConfigOverride?: LlmConfig
  userPrompt?: string
  /** 流式回调：用于 UI 显示生成过程 */
  onToken?: (token: string) => void
}

export interface GenerateNodeResult {
  script: string
  frontmatter: Record<string, unknown> | null
  choices: GalChoice[]
}

export async function generateNodeScript(
  params: GenerateNodeParams,
): Promise<GenerateNodeResult> {
  const store = useWikiStore.getState()
  const llmConfig = params.llmConfigOverride ?? store.llmConfig
  const lang = getOutputLanguage()

  // 加载项目与节点
  const project = await loadGalProject(params.projectPath)
  if (!project) throw new Error("未找到 Gal 项目")

  const route = project.routes.find((r) => r.id === params.routeId)
  const node = route?.nodes.find((n) => n.id === params.nodeId)
  if (!route || !node) throw new Error(`未找到节点 ${params.nodeId}`)

  // 构建上下文
  const contextPack = await buildGalContextPack(
    params.projectPath,
    `生成节点「${node.title}」的完整剧本正文`,
    params.routeId,
    params.nodeId,
  )
  const contextText = galContextPackToPrompt(contextPack)

  // 提取核心设定，用强调标记包裹（仿小说模式的大纲注入方式）
  const coreContext = [
    contextPack.soulDoc?.trim()
      ? `# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n# 【强制遵守】项目灵魂文档\n# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n${contextPack.soulDoc.trim()}`
      : "",
    contextPack.outline?.trim()
      ? `# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n# 【强制遵守】作品完整大纲\n# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n**必须严格遵守大纲中的线路主题、场景设定、角色行为和剧情走向。**\n\n${contextPack.outline.trim()}`
      : "",
    contextPack.novelCharacterStates?.trim()
      ? `# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n# 【参考】角色当前状态\n# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n${contextPack.novelCharacterStates.trim()}`
      : "",
  ].filter(Boolean).join("\n\n")

  // 根据节点类型选择提示词
  const isEntry = node.type === "entry" && node.parents.length === 0
  let systemPrompt: string

  if (isEntry) {
    systemPrompt = buildEntryNodePrompt({
      nodeTitle: node.title,
      nodeGoal: node.goal,
      scene: node.scene,
      characters: node.characters.join("、"),
      childBeginnings: contextPack.childBeginnings,
      soulDoc: contextPack.soulDoc,
      outline: contextPack.outline,
      language: lang === "Chinese" ? "中文" : lang,
    })
  } else {
    systemPrompt = buildNodeGenerationPrompt({
      nodeTitle: node.title,
      nodeGoal: node.goal,
      nodeType: node.type,
      scene: node.scene,
      characters: node.characters.join("、"),
      parentEndings: contextPack.parentEndings,
      childBeginnings: contextPack.childBeginnings,
      soulDoc: contextPack.soulDoc,
      outline: contextPack.outline,
      variableState: contextPack.variableState,
      characterMoods: contextPack.characterMoods,
      routeContext: contextPack.routeTheme,
      clueContext: contextPack.acquiredClues,
      language: lang === "Chinese" ? "中文" : lang,
    })
  }

  // 组装消息：核心设定 → 系统指令 → 完整上下文
  const choiceDirective = buildChoiceDirective(node.choices)
  const userDirective = params.userPrompt?.trim()
    ? [
        "## 用户本次硬性写作约束（最高优先级）",
        "以下要求必须逐条落实到本次生成的正文中，不得省略、弱化、改写或仅部分采用。",
        "如果这些要求与大纲、角色记忆或既有措辞冲突，以本段要求为准。",
        "输出前必须自检其中涉及的称呼、口癖、禁用词、出现条件和句式位置。",
        params.userPrompt.trim(),
      ].join("\n")
    : ""
  const messages = [
    {
      role: "system" as const,
      content: [
        `你是一个专业的 Galgame 视觉小说剧本作家。`,
        coreContext,
        userDirective,
      ].filter(Boolean).join("\n\n"),
    },
    {
      role: "user" as const,
      content: [
        systemPrompt,
        choiceDirective,
        `## 完整上下文\n${contextText}`,
        userDirective
          ? `## 生成前再次确认\n${userDirective}`
          : "",
      ].filter(Boolean).join("\n\n"),
    },
  ]

  // 流式调用 LLM
  let result = ""
  let streamError: Error | null = null
  const callbacks: StreamCallbacks = {
    onToken: (token: string) => {
      result += token
      params.onToken?.(token)
    },
    onDone: () => {},
    onError: (error: Error) => {
      streamError = error
    },
  }

  await streamChat(llmConfig, messages, callbacks)
  if (streamError) throw streamError

  // 解析 frontmatter 和正文
  const { frontmatter, body } = parseFrontmatter(result)

  const choices = node.choices.length > 0 ? node.choices : []
  const normalizedBody = normalizeChoiceBlock(body, node.choices)
  await saveNodeScript(params.projectPath, params.routeId, params.nodeId, normalizedBody)

  // 保存正文到磁盘
  await saveNodeScript(params.projectPath, params.routeId, params.nodeId, normalizedBody)
  const latestProject = await loadGalProject(params.projectPath)
  const latestRoute = latestProject?.routes.find((r) => r.id === params.routeId)
  const latestNode = latestRoute?.nodes.find((n) => n.id === params.nodeId)
  if (!latestProject || !latestRoute || !latestNode) {
    throw new Error(`鏈壘鍒拌妭鐐?${params.nodeId}`)
  }
  latestNode.status = "draft"
  latestNode.updatedAt = new Date().toISOString()
  await saveGalProject(params.projectPath, latestProject)

  return { script: normalizedBody, frontmatter, choices }
}

// ─── 生成子节点卡片 ────────────────────────────────────────

export interface ExpandChildNodesParams {
  projectPath: string
  routeId: string
  parentNodeId: string
  choiceId: string
  llmConfigOverride?: LlmConfig
}

export interface ChildNodeCardResult {
  title: string
  type: GalNode["type"]
  goal: string
  summary: string
  scene: string
  characters: string[]
  effects: GalEffect[]
  choices: GalChoice[]
}

export async function expandChildNodeCard(
  params: ExpandChildNodesParams,
): Promise<ChildNodeCardResult> {
  const store = useWikiStore.getState()
  const llmConfig = params.llmConfigOverride ?? store.llmConfig
  const lang = getOutputLanguage()

  // 加载项目数据
  const project = await loadGalProject(params.projectPath)
  if (!project) throw new Error("未找到 Gal 项目")

  const route = project.routes.find((r) => r.id === params.routeId)
  const parentNode = route?.nodes.find((n) => n.id === params.parentNodeId)
  if (!route || !parentNode) throw new Error("未找到父节点")

  // 找到指定选项
  const choice = parentNode.choices.find((c) => c.id === params.choiceId)
  if (!choice) throw new Error("未找到指定选项")

  // 获取父节点结尾
  const script = await loadNodeScript(params.projectPath, params.routeId, params.parentNodeId)
  const parentEnding = script ? script.slice(-500).trim() : "（无父节点正文）"
  const contextPack = await buildGalContextPack(
    params.projectPath,
    `基于父节点「${parentNode.title}」的选项「${choice.text}」生成后续节点卡片`,
    params.routeId,
    params.parentNodeId,
  )
  const contextText = galContextPackToPrompt(contextPack)

  // 构建变量状态文本
  const varState = buildVarStateText(parentNode, choice)

  // 调用 LLM
  const prompt = buildChildNodeCardPrompt({
    parentNodeTitle: parentNode.title,
    parentNodeGoal: parentNode.goal,
    parentNodeScene: parentNode.scene,
    parentNodeSummary: parentNode.summary,
    parentCharacters: parentNode.characters.join("、"),
    parentEndingText: parentEnding,
    choiceText: choice.text,
    choiceIntent: choice.emotionalIntent,
    choiceNextNodeTitle: choice.nextNodeTitle ?? "",
    choiceNextNodeGoal: choice.nextNodeGoal ?? "",
    routeTheme: route.theme,
    premise: project.premise,
    globalRules: project.globalRules,
    contextText,
    variableState: varState,
    language: lang === "Chinese" ? "中文" : lang,
  })

  const messages = [
    {
      role: "system" as const,
      content: "你是一个 Galgame 剧本规划师。请严格按照 JSON 格式输出。",
    },
    { role: "user" as const, content: prompt },
  ]

  let result = ""
  let streamError: Error | null = null
  const callbacks: StreamCallbacks = {
    onToken: (token: string) => { result += token },
    onDone: () => {},
    onError: (error: Error) => { streamError = error },
  }

  await streamChat(llmConfig, messages, callbacks)
  if (streamError) throw streamError

  // 解析 JSON
  const jsonMatch =
    result.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.match(/\{[\s\S]*\}/)
    ?? result.match(/\{[\s\S]*\}/)

  if (!jsonMatch) {
    throw new Error("子节点卡片生成失败：LLM 未返回有效 JSON")
  }

  const parsed = JSON.parse(jsonMatch[0])

  return {
    title: parsed.title || choice.nextNodeTitle || "未命名节点",
    type: parsed.type || "daily",
    goal: parsed.goal || choice.nextNodeGoal || "",
    summary: parsed.summary || "",
    scene: parsed.scene || parentNode.scene,
    characters: parsed.characters || parentNode.characters,
    effects: sanitizeGalEffects(parsed.effects, project.variables),
    choices: sanitizeGalChoices((Array.isArray(parsed.choices) ? parsed.choices : []).map((c: { id?: string; text: string; emotionalIntent: string; effects: { variable: string; op: string; value: unknown }[]; nextNodeTitle: string; nextNodeGoal: string }) => ({
        id: c.id || `choice_${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      text: c.text || "",
      emotionalIntent: c.emotionalIntent || "",
      effects: (c.effects || []).map((e) => ({
        variable: e.variable,
        op: (e.op === "set" ? "set" : "add") as "set" | "add",
        value: e.value,
      })),
      nextNodeTitle: c.nextNodeTitle || "",
      nextNodeGoal: c.nextNodeGoal || "",
    })), project.variables),
  }
}

export interface GenerateChoiceLongLineParams extends ExpandChildNodesParams {
  nodeCount: number
  userPrompt?: string
}

export async function generateChoiceLongLineCards(
  params: GenerateChoiceLongLineParams,
): Promise<ChildNodeCardResult[]> {
  const store = useWikiStore.getState()
  const llmConfig = params.llmConfigOverride ?? store.llmConfig
  const lang = getOutputLanguage()
  const project = await loadGalProject(params.projectPath)
  if (!project) throw new Error("未找到 Gal 项目")

  const route = project.routes.find((r) => r.id === params.routeId)
  const parentNode = route?.nodes.find((n) => n.id === params.parentNodeId)
  if (!route || !parentNode) throw new Error("未找到父节点")

  const choice = parentNode.choices.find((c) => c.id === params.choiceId)
  if (!choice) throw new Error("未找到指定选项")

  const script = await loadNodeScript(params.projectPath, params.routeId, params.parentNodeId)
  const parentEnding = script ? script.slice(-500).trim() : "（无父节点正文）"
  const contextPack = await buildGalContextPack(
    params.projectPath,
    `基于父节点「${parentNode.title}」的选项「${choice.text}」生成 ${params.nodeCount} 个连续剧情节点卡片`,
    params.routeId,
    params.parentNodeId,
  )
  const contextText = galContextPackToPrompt(contextPack)
  const varState = buildVarStateText(parentNode, choice)
  const nodeCount = Math.max(1, Math.min(12, Math.floor(params.nodeCount)))

  const prompt = buildChoiceLongLinePrompt({
    parentNodeTitle: parentNode.title,
    parentNodeGoal: parentNode.goal,
    parentNodeScene: parentNode.scene,
    parentNodeSummary: parentNode.summary,
    parentCharacters: parentNode.characters.join("、"),
    parentEndingText: parentEnding,
    choiceText: choice.text,
    choiceIntent: choice.emotionalIntent,
    choiceNextNodeTitle: choice.nextNodeTitle ?? "",
    choiceNextNodeGoal: choice.nextNodeGoal ?? "",
    routeTheme: route.theme,
    premise: project.premise,
    globalRules: project.globalRules,
    contextText,
    variableState: varState,
    nodeCount,
    userPrompt: params.userPrompt?.trim() ?? "",
    language: lang === "Chinese" ? "中文" : lang,
  })

  const messages = [
    {
      role: "system" as const,
      content: "你是一个 Galgame 长线剧情规划师。请严格按照 JSON 格式输出。",
    },
    { role: "user" as const, content: prompt },
  ]

  let result = ""
  let streamError: Error | null = null
  const callbacks: StreamCallbacks = {
    onToken: (token: string) => { result += token },
    onDone: () => {},
    onError: (error: Error) => { streamError = error },
  }

  await streamChat(llmConfig, messages, callbacks)
  if (streamError) throw streamError

  const jsonMatch =
    result.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.match(/\{[\s\S]*\}/)
    ?? result.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    throw new Error("长线剧情生成失败：LLM 未返回有效 JSON")
  }

  const parsed = JSON.parse(jsonMatch[0]) as { nodes?: unknown[] }
  const rawNodes = Array.isArray(parsed.nodes) ? parsed.nodes.slice(0, nodeCount) : []
  if (rawNodes.length === 0) {
    throw new Error("长线剧情生成失败：JSON 中没有 nodes 数组")
  }

  return rawNodes.map((raw, index) => normalizeChildNodeCard(raw, {
    fallbackTitle: index === 0 ? choice.nextNodeTitle : "",
    fallbackGoal: index === 0 ? choice.nextNodeGoal : "",
    fallbackScene: parentNode.scene,
    fallbackCharacters: parentNode.characters,
    variables: project.variables,
  }))
}

export interface GenerateRelayNodeCardParams {
  projectPath: string
  routeId: string
  parentNodeId: string
  childNodeId: string
  edgeLabel?: string
  llmConfigOverride?: LlmConfig
}

export interface RelayNodeCardResult {
  title: string
  goal: string
  summary: string
  scene: string
  characters: string[]
  entryChoiceText: string
  entryChoiceIntent: string
}

export async function generateRelayNodeCard(
  params: GenerateRelayNodeCardParams,
): Promise<RelayNodeCardResult> {
  const store = useWikiStore.getState()
  const llmConfig = params.llmConfigOverride ?? store.llmConfig
  const lang = getOutputLanguage()
  const project = await loadGalProject(params.projectPath)
  if (!project) throw new Error("未找到 Gal 项目")

  const route = project.routes.find((item) => item.id === params.routeId)
  const parentNode = route?.nodes.find((item) => item.id === params.parentNodeId)
  const childNode = route?.nodes.find((item) => item.id === params.childNodeId)
  if (!route || !parentNode || !childNode) {
    throw new Error("中继节点生成失败：父节点或子节点不存在")
  }

  const [parentScript, childScript] = await Promise.all([
    loadNodeScript(params.projectPath, params.routeId, params.parentNodeId),
    loadNodeScript(params.projectPath, params.routeId, params.childNodeId),
  ])
  const parentEnding = parentScript?.trim()
    ? parentScript.trim().slice(-800)
    : buildRelayNodeFallback(parentNode)
  const childBeginning = childScript?.trim()
    ? childScript.trim().slice(0, 800)
    : buildRelayNodeFallback(childNode)

  const prompt = buildRelayNodeCardPrompt({
    parentTitle: parentNode.title,
    parentEnding,
    childTitle: childNode.title,
    childBeginning,
    edgeLabel: params.edgeLabel ?? "",
    routeTheme: route.theme,
    premise: project.premise,
    globalRules: project.globalRules,
    language: lang === "Chinese" ? "中文" : lang,
  })

  let result = ""
  let streamError: Error | null = null
  await streamChat(
    llmConfig,
    [
      {
        role: "system",
        content: "你是 Galgame 剧情结构规划师。严格输出指定 JSON，不编写节点正文。",
      },
      { role: "user", content: prompt },
    ],
    {
      onToken: (token) => { result += token },
      onDone: () => {},
      onError: (error) => { streamError = error },
    },
  )
  if (streamError) throw streamError

  const jsonText =
    result.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.match(/\{[\s\S]*\}/)?.[0]
    ?? result.match(/\{[\s\S]*\}/)?.[0]
  if (!jsonText) {
    throw new Error("中继节点生成失败：LLM 未返回有效 JSON")
  }

  const parsed = JSON.parse(jsonText) as Partial<RelayNodeCardResult>
  return {
    title: String(parsed.title ?? "").trim() || `${parentNode.title}与${childNode.title}之间`,
    goal: String(parsed.goal ?? "").trim(),
    summary: String(parsed.summary ?? "").trim(),
    scene: String(parsed.scene ?? "").trim() || parentNode.scene || childNode.scene,
    characters: Array.isArray(parsed.characters)
      ? parsed.characters.map((item) => String(item).trim()).filter(Boolean)
      : Array.from(new Set([...parentNode.characters, ...childNode.characters])),
    entryChoiceText: String(parsed.entryChoiceText ?? "").trim() || `继续前往${childNode.title}`,
    entryChoiceIntent: String(parsed.entryChoiceIntent ?? "").trim() || "自然承接后续剧情",
  }
}

// ─── 辅助函数 ──────────────────────────────────────────────

function normalizeChildNodeCard(
  raw: unknown,
  fallback: {
    fallbackTitle?: string
    fallbackGoal?: string
    fallbackScene: string
    fallbackCharacters: string[]
    variables: GalVariable[]
  },
): ChildNodeCardResult {
  const item = isRecord(raw) ? raw : {}
  return {
    title: readString(item.title) || fallback.fallbackTitle || "未命名节点",
    type: normalizeNodeType(item.type),
    goal: readString(item.goal) || fallback.fallbackGoal || "",
    summary: readString(item.summary),
    scene: readString(item.scene) || fallback.fallbackScene,
    characters: Array.isArray(item.characters)
      ? item.characters.map((name) => String(name).trim()).filter(Boolean)
      : fallback.fallbackCharacters,
    effects: sanitizeGalEffects(Array.isArray(item.effects) ? item.effects : [], fallback.variables),
    choices: sanitizeGalChoices(
      (Array.isArray(item.choices) ? item.choices : []).map((choice) => normalizeGeneratedChoice(choice)),
      fallback.variables,
    ),
  }
}

function normalizeGeneratedChoice(raw: unknown): GalChoice {
  const item = isRecord(raw) ? raw : {}
  return {
    id: readString(item.id) || `choice_${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    text: readString(item.text),
    emotionalIntent: readString(item.emotionalIntent),
    effects: (Array.isArray(item.effects) ? item.effects : []).map((effect) => {
      const effectItem = isRecord(effect) ? effect : {}
      return {
        variable: readString(effectItem.variable),
        op: readString(effectItem.op) === "set" ? "set" : "add",
        value: readEffectValue(effectItem.value),
      }
    }),
    nextNodeTitle: readString(item.nextNodeTitle),
    nextNodeGoal: readString(item.nextNodeGoal),
  }
}

function normalizeNodeType(value: unknown): GalNode["type"] {
  const type = readString(value)
  return ["entry", "daily", "choice", "common", "clue", "cg", "ending"].includes(type)
    ? type as GalNode["type"]
    : "daily"
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function readEffectValue(value: unknown): number | string | boolean {
  if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") return value
  return 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function buildRelayNodeFallback(node: GalNode): string {
  return [
    `标题：${node.title || ""}`,
    `人物：${node.characters.join("、")}`,
    `目标：${node.goal || ""}`,
    `场景：${node.scene || ""}`,
    `摘要：${node.summary || ""}`,
  ].filter((line) => line.split("：")[1]?.trim()).join("\n")
}

function buildChoiceDirective(choices: GalChoice[]): string {
  if (choices.length === 0) {
    return [
      "## 选项生成策略",
      "当前节点没有预设选项。只生成剧本正文，不要生成【选择】、选项①、选项1、frontmatter choices 或任何新的分支选项。",
      "如果需要承接后续节点，请在正文结尾留下自然过渡或情绪断点，不要自行补选项。",
    ].join("\n")
  }

  return [
    "## 选项生成策略",
    `当前节点已经有 ${choices.length} 个预设选项。正文必须基于这些选项铺垫剧情，并在结尾自然停到这些选项出现的位置。`,
    `最终只能出现这 ${choices.length} 个选项；不要新增额外选项，不要删除选项，不要改写选项文本。手动选项是用户设定，优先级高于模型生成。`,
    "如果输出 frontmatter 的 choices 字段，请原样保留这些选项的 id/text/emotionalIntent/nextNodeTitle/nextNodeGoal。",
    "生成正文时必须把下面每个选项的文本、情感意图、后续节点建议标题和后续剧情目标当作硬上下文使用。",
    "不要在正文或选项文案里写出变量 ID、具体变量名、数值变化或类似 intimacy +1 的内容。",
    "",
    ...choices.map((choice, index) => {
      return [
        `${index + 1}. id=${choice.id}`,
        `选项文本：${choice.text}`,
        `情感意图：${choice.emotionalIntent || "未设置"}`,
        `下个节点建议标题：${choice.nextNodeTitle || "未设置"}`,
        `下个节点剧情目标：${choice.nextNodeGoal || "未设置"}`,
      ].join("；")
    }),
  ].join("\n")
}

function normalizeChoiceBlock(body: string, choices: GalChoice[]): string {
  const cleaned = stripTrailingChoiceBlock(body)
  if (choices.length === 0) return cleaned

  const choiceLines = choices.map((choice, index) => {
    const next = choice.nextNodeTitle?.trim() ? `，进入${choice.nextNodeTitle.trim()}` : ""
    return `选项${index + 1}: ${choice.text}${next}`
  })
  return `${cleaned}\n\n【选择】\n${choiceLines.join("\n")}`.trim()
}

function stripTrailingChoiceBlock(body: string): string {
  return body
    .replace(/\n{0,2}【选择】[\s\S]*$/u, "")
    .replace(/\n{0,2}##\s*选择[\s\S]*$/u, "")
    .replace(/\n{0,2}(?:选项[①②③④⑤⑥⑦⑧⑨⑩]?[：:].*(?:\n|$))+$/u, "")
    .trim()
}

function buildVarStateText(node: GalNode, choice: GalChoice): string {
  const vars = node.incomingState?.variables ?? {}
  const lines = Object.keys(vars).length === 0
    ? ["所有变量均为初始值"]
    : Object.entries(vars).map(
        ([k, v]) => `- ${k}: ${JSON.stringify(v)}`,
      )

  // 标注该选项会影响的变量
  if (choice.effects.length > 0) {
    lines.push("\n选择后将变化：")
    for (const eff of choice.effects) {
      lines.push(
        `- ${eff.variable}: ${eff.op === "add" ? "+" : "="}${JSON.stringify(eff.value)}`,
      )
    }
  }

  return lines.join("\n")
}
