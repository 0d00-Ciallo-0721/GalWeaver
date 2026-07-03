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
} from "./gal-types"
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

  // 从 frontmatter 或正文中提取选项
  const generatedChoices = extractChoices(frontmatter, body)
  const choices = node.choices.length > 0 ? node.choices : generatedChoices

  // 保存正文到磁盘
  await saveNodeScript(params.projectPath, params.routeId, params.nodeId, body)
  if (node.choices.length === 0 && generatedChoices.length > 0) {
    node.choices = generatedChoices
  }
  node.status = "draft"
  node.updatedAt = new Date().toISOString()
  await saveGalProject(params.projectPath, project)

  return { script: body, frontmatter, choices }
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
  id: string
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

  // 构建变量状态文本
  const varState = buildVarStateText(parentNode, choice)

  // 调用 LLM
  const prompt = buildChildNodeCardPrompt({
    parentNodeTitle: parentNode.title,
    parentEndingText: parentEnding,
    choiceText: choice.text,
    choiceIntent: choice.emotionalIntent,
    routeTheme: route.theme,
    premise: project.premise,
    globalRules: project.globalRules,
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
    id: parsed.id || `${params.routeId}_${Date.now()}`,
    title: parsed.title || choice.nextNodeTitle || "未命名节点",
    type: parsed.type || "daily",
    goal: parsed.goal || choice.nextNodeGoal || "",
    summary: parsed.summary || "",
    scene: parsed.scene || parentNode.scene,
    characters: parsed.characters || parentNode.characters,
    effects: (parsed.effects || []).map((e: { variable: string; op: string; value: unknown }) => ({
      variable: e.variable,
      op: (e.op === "set" ? "set" : "add") as "set" | "add",
      value: e.value,
    })),
    choices: (parsed.choices || []).map((c: { id?: string; text: string; emotionalIntent: string; effects: { variable: string; op: string; value: unknown }[]; nextNodeTitle: string; nextNodeGoal: string }) => ({
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
    })),
  }
}

// ─── 辅助函数 ──────────────────────────────────────────────

function buildChoiceDirective(choices: GalChoice[]): string {
  if (choices.length === 0) {
    return [
      "## 选项生成策略",
      "当前节点没有预设选项。你可以根据剧情自由发挥，在自然断点处生成适量有分支意义的选项，不限制为固定数量。",
      "如果输出 frontmatter 的 choices 字段，请为每个选项包含 text、emotionalIntent、effects、nextNodeTitle、nextNodeGoal。",
    ].join("\n")
  }

  return [
    "## 选项生成策略",
    "当前节点已经有预设选项。正文必须基于这些选项铺垫剧情，并在结尾自然停到这些选项出现的位置。",
    "不要新增额外选项，不要删除选项，不要改写选项文本。手动选项是用户设定，优先级高于模型生成。",
    "如果输出 frontmatter 的 choices 字段，请原样保留这些选项的 id/text/emotionalIntent/effects/nextNodeTitle/nextNodeGoal。",
    "",
    ...choices.map((choice, index) => {
      const effects = choice.effects.length > 0
        ? choice.effects.map((eff) => `${eff.variable} ${eff.op === "add" ? "+" : "="}${String(eff.value)}`).join("，")
        : "无"
      return `${index + 1}. id=${choice.id}；选项=${choice.text}；意图=${choice.emotionalIntent || "未设置"}；影响=${effects}`
    }),
  ].join("\n")
}

function extractChoices(
  frontmatter: Record<string, unknown> | null,
  _body: string,
): GalChoice[] {
  // 优先从 frontmatter 的 choices 字段提取
  if (frontmatter && Array.isArray(frontmatter.choices)) {
    return (frontmatter.choices as Record<string, unknown>[]).map(
      (c: Record<string, unknown>, i: number) => ({
        id: (c.id as string) || `choice_${i + 1}`,
        text: (c.text as string) || "",
        emotionalIntent: (c.emotionalIntent as string) || "",
        condition: Array.isArray(c.condition)
          ? (c.condition as GalChoice["condition"])
          : undefined,
        effects: Array.isArray(c.effects)
          ? (c.effects as GalEffect[])
          : [],
        nextNodeId: (c.next as string) || undefined,
        nextNodeTitle: (c.nextNodeTitle as string) || "",
        nextNodeGoal: (c.nextNodeGoal as string) || "",
      }),
    )
  }

  return []
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
