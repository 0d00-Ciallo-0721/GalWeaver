import { streamChat, type StreamCallbacks } from "@/lib/llm-client"
import { useWikiStore, type LlmConfig } from "@/stores/wiki-store"
import { buildGalContextPack, galContextPackToPrompt } from "./gal-context-engine"
import type { GalChoice } from "./gal-types"

export interface GenerateNodeChoicesParams {
  count: number
  projectPath?: string
  routeId?: string
  nodeId?: string
  title: string
  characters: string
  goal: string
  scene: string
  scriptContent?: string
  choicePrompt?: string
  existingChoices: GalChoice[]
  llmConfigOverride?: LlmConfig
}

export async function generateNodeChoices(
  params: GenerateNodeChoicesParams,
): Promise<GalChoice[]> {
  const llmConfig = params.llmConfigOverride ?? useWikiStore.getState().llmConfig
  const contextText = await buildChoiceContextText(params)
  const messages = [
    {
      role: "system" as const,
      content: [
        "你是 Galgame 视觉小说分支选项规划师。",
        "严格输出 JSON，不要解释，不要 Markdown。",
        "只生成玩家可点击的剧情选项，不生成正文。",
      ].join("\n"),
    },
    {
      role: "user" as const,
      content: [
        `请基于当前节点卡片生成 ${params.count} 个选项。`,
        "输出 JSON 格式：",
        `{"choices":[{"text":"选项文本","emotionalIntent":"情感意图","nextNodeTitle":"后续节点建议标题","nextNodeGoal":"后续节点剧情目标"}]}`,
        "",
        "要求：",
        "- 选项必须服务当前节点目标，并自然从场景与人物关系中长出来。",
        "- 选项必须承接当前节点正文已经发生的内容，不得跳到上下文中不存在的地点、人物或事件。",
        "- 选项之间要有明确差异，不要只是语气轻重不同。",
        "- 不要输出变量 ID、变量数值、条件、effects 或代码。",
        "- 每个选项文本适合直接给玩家点击。",
        params.choicePrompt?.trim()
          ? `- 用户指定的选项生成方向：${params.choicePrompt.trim()}`
          : "",
        "",
        `标题：${params.title || "未设置"}`,
        `人物：${params.characters || "未设置"}`,
        `目标：${params.goal || "未设置"}`,
        `场景：${params.scene || "未设置"}`,
        params.scriptContent?.trim()
          ? `当前节点正文：\n${params.scriptContent.trim().slice(-3000)}`
          : "当前节点正文：未填写",
        "",
        contextText ? `## 完整上下文参考\n${contextText}` : "",
        "",
        params.existingChoices.length > 0
          ? `已有选项，避免重复：\n${params.existingChoices.map((choice, index) => `${index + 1}. ${choice.text}`).join("\n")}`
          : "当前没有已有选项。",
      ].join("\n"),
    },
  ]

  let raw = ""
  let streamError: Error | null = null
  const callbacks: StreamCallbacks = {
    onToken: (token) => {
      raw += token
    },
    onDone: () => {},
    onError: (error) => {
      streamError = error
    },
  }

  await streamChat(llmConfig, messages, callbacks, undefined, { temperature: 0.7 })
  if (streamError) throw streamError

  const parsed = parseChoiceResponse(raw)
  return parsed.slice(0, params.count).map((choice, index) => ({
    id: `choice_${Date.now().toString(36)}_${index}_${Math.random().toString(36).slice(2, 6)}`,
    text: String(choice.text ?? "").trim() || "新的选项",
    emotionalIntent: String(choice.emotionalIntent ?? "").trim(),
    effects: [],
    nextNodeTitle: String(choice.nextNodeTitle ?? "").trim(),
    nextNodeGoal: String(choice.nextNodeGoal ?? "").trim(),
  }))
}

async function buildChoiceContextText(params: GenerateNodeChoicesParams): Promise<string> {
  if (!params.projectPath || !params.routeId || !params.nodeId) return ""
  const contextPack = await buildGalContextPack(
    params.projectPath,
    `为节点「${params.title || params.nodeId}」生成玩家可点击选项`,
    params.routeId,
    params.nodeId,
  )
  return galContextPackToPrompt(contextPack)
}

function parseChoiceResponse(raw: string): Array<{
  text?: unknown
  emotionalIntent?: unknown
  nextNodeTitle?: unknown
  nextNodeGoal?: unknown
}> {
  const jsonMatch =
    raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.match(/\{[\s\S]*\}/)
    ?? raw.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error("选项生成失败：LLM 未返回有效 JSON")
  const parsed = JSON.parse(jsonMatch[0]) as { choices?: unknown }
  if (!Array.isArray(parsed.choices)) {
    throw new Error("选项生成失败：JSON 中缺少 choices 数组")
  }
  return parsed.choices as Array<{
    text?: unknown
    emotionalIntent?: unknown
    nextNodeTitle?: unknown
    nextNodeGoal?: unknown
  }>
}
