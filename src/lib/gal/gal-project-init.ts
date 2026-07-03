/** Galgame project initialization. */

import { streamChat, type StreamCallbacks } from "@/lib/llm-client"
import { buildGalInitPrompt } from "./gal-prompts"
import {
  initGalDirectory,
  saveGalProject,
  saveGlobalMemory,
} from "./gal-storage"
import type {
  GalProject,
  GalRoute,
  GalNode,
  GalChoice,
  GalVariable,
  GalGlobalMemory,
} from "./gal-types"
import { useWikiStore, type LlmConfig } from "@/stores/wiki-store"
import { getOutputLanguage } from "@/lib/output-language"
import { normalizePath } from "@/lib/path-utils"
import { buildContextPack, contextPackToPrompt } from "@/lib/novel/context-engine"

export interface GalInitParams {
  projectPath: string
  title: string
}

interface LLMInitResponse {
  routes?: Array<{
    id?: string
    title?: string
    theme?: string
    entryNode?: {
      id?: string
      title?: string
      goal?: string
      summary?: string
      scene?: string
      characters?: string[]
      choices?: Array<{
        id?: string
        text?: string
        emotionalIntent?: string
        effects?: Array<{ variable: string; op?: "set" | "add"; value: number | string | boolean }>
        nextNodeTitle?: string
        nextNodeGoal?: string
      }>
    }
  }>
  variables?: Array<{
    id?: string
    name?: string
    type?: "intimacy" | "love" | "flag" | "custom"
    defaultValue?: number | string | boolean
    min?: number
    max?: number
    description?: string
  }>
  globalRules?: string
}

export async function buildGalInitContextPreview(
  projectPath: string,
  title = "Galgame 项目初始化",
): Promise<string> {
  const pp = normalizePath(projectPath)
  const store = useWikiStore.getState()
  const task = [
    `为《${title}》初始化 Gal 创作树。`,
    "只需要创建主线路的开头入口节点，具体分支和角色线后续由用户手动用节点拼接。",
    "必须复用现有小说大纲、人物设定、角色记忆、时间线、伏笔、正史规则和写作风格。",
  ].join("\n")

  try {
    const contextPack = await buildContextPack(pp, task, undefined, { force: true })
    const budget = store.novelConfig.contextTokenBudget > 0
      ? store.novelConfig.contextTokenBudget
      : undefined
    return contextPackToPrompt(contextPack, budget)
  } catch (err) {
    const msg = err instanceof Error
      ? `${err.message}\n${err.stack?.split("\n").slice(0, 8).join("\n") ?? ""}`
      : String(err)
    console.error("[Gal InitContext] failed:", err)
    return `上下文加载失败\n\n${msg}`
  }
}

export async function initGalProject(
  params: GalInitParams,
  llmConfigOverride?: LlmConfig,
): Promise<GalProject> {
  const lang = getOutputLanguage()
  const store = useWikiStore.getState()
  const llmConfig = llmConfigOverride ?? store.llmConfig
  if (!llmConfig.apiKey && !llmConfig.model) {
    throw new Error("请先在设置中配置 LLM 模型")
  }

  const projectContext = await buildGalInitContextPreview(params.projectPath, params.title)
  const prompt = buildGalInitPrompt({
    title: params.title,
    projectContext,
    language: lang === "Chinese" ? "中文" : lang,
  })

  const messages = [
    {
      role: "system" as const,
      content: "你是专业 Galgame 视觉小说结构师。严格输出 JSON，不要输出解释。",
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

  const parsed = parseLLMResponse(result)
  if (!parsed) {
    throw new Error("项目初始化失败：LLM 未返回有效 JSON")
  }

  const now = new Date().toISOString()
  const premise = [
    "【Gal 项目上下文】",
    projectContext,
    "",
    "【初始化规则】只初始化主线路的开头入口节点；后续具体线路由用户通过节点树手动拼接。",
  ].join("\n")

  const project: GalProject = {
    id: uid(),
    title: params.title,
    premise,
    globalRules: parsed.globalRules || "",
    variables: buildVariables(parsed.variables ?? []),
    routes: buildRoutes(parsed.routes ?? [], now),
    cgs: [],
    clues: [],
    createdAt: now,
    updatedAt: now,
  }

  await initGalDirectory(params.projectPath)
  await saveGalProject(params.projectPath, project)

  const globalMemory: GalGlobalMemory = {
    projectId: project.id,
    canonRules: parsed.globalRules || "",
    characterProfiles: {},
    worldSettings: premise,
    lastUpdated: now,
  }
  await saveGlobalMemory(params.projectPath, globalMemory)

  return project
}

function uid(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  }
}

function parseLLMResponse(raw: string): LLMInitResponse | null {
  try {
    const jsonMatch =
      raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.match(/\{[\s\S]*\}/)
      ?? raw.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return null
    return JSON.parse(jsonMatch[0]) as LLMInitResponse
  } catch {
    console.error("[Gal Init] failed to parse LLM response:", raw.slice(0, 500))
    return null
  }
}

function buildVariables(raw: NonNullable<LLMInitResponse["variables"]>): GalVariable[] {
  return raw.map((v, i) => ({
    id: v.id || `var_${i + 1}`,
    name: v.name || `变量 ${i + 1}`,
    type: v.type || "flag",
    defaultValue: v.defaultValue ?? 0,
    min: v.min,
    max: v.max,
    description: v.description || "",
  }))
}

function buildRoutes(
  raw: NonNullable<LLMInitResponse["routes"]>,
  now: string,
): GalRoute[] {
  const first = raw[0]
  const routeId = "main"
  const entryNode = buildEntryNode(first?.entryNode, routeId, now)
  return [{
    id: routeId,
    title: "主线路",
    theme: first?.theme || "主线树",
    entryNodeId: entryNode.id,
    endingNodeIds: [],
    nodes: [entryNode],
  }]
}

function buildEntryNode(
  raw: NonNullable<NonNullable<LLMInitResponse["routes"]>[number]["entryNode"]> | undefined,
  routeId: string,
  now: string,
): GalNode {
  const nodeId = raw?.id || `${routeId}_001_entry`
  const choices: GalChoice[] = (raw?.choices ?? []).map((c, index) => ({
    id: c.id || `choice_${index + 1}`,
    text: c.text || "",
    emotionalIntent: c.emotionalIntent || "",
    condition: undefined,
    effects: (c.effects ?? []).map((e) => ({
      variable: e.variable,
      op: e.op || "add",
      value: e.value,
    })),
    nextNodeId: undefined,
    nextNodeTitle: c.nextNodeTitle || "",
    nextNodeGoal: c.nextNodeGoal || "",
  }))

  return {
    id: nodeId,
    routeId,
    title: raw?.title || "开头节点",
    type: "entry",
    status: "card",
    parents: [],
    children: [],
    goal: raw?.goal || "建立 Gal 主线树的开场。",
    summary: raw?.summary || "开头入口节点，后续由用户在节点树中继续拼接分支。",
    scriptPath: `nodes/${routeId}/${nodeId}.md`,
    incomingState: createEmptyStateSnapshot(),
    outgoingState: undefined,
    choices,
    memoryScope: "node",
    characters: raw?.characters || [],
    scene: raw?.scene || "",
    cgId: undefined,
    clueIds: [],
    sequence: 1,
    createdAt: now,
    updatedAt: now,
  }
}

function createEmptyStateSnapshot() {
  return {
    variables: {} as Record<string, number | string | boolean>,
    characterCognition: {} as Record<string, { knows: string[]; doesNotKnow: string[]; readerKnowsButCharacterDoesNot: string[] }>,
    acquiredClueIds: [],
    seenCgIds: [],
    visitedNodeIds: [],
    currentScene: "",
    characterMoods: {} as Record<string, string>,
  }
}