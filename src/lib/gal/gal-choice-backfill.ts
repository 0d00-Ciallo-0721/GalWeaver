import { streamChat, type StreamCallbacks } from "@/lib/llm-client"
import { useWikiStore, type LlmConfig } from "@/stores/wiki-store"
import { loadGalProject, loadNodeScript, saveGalProject } from "./gal-storage"

export interface BackfillIncomingChoicesParams {
  projectPath: string
  routeId: string
  nodeId: string
  scriptContent?: string
  llmConfigOverride?: LlmConfig
}

interface IncomingChoice {
  parentNodeId: string
  parentTitle: string
  choiceId: string
  currentText: string
  currentIntent: string
  parentEnding: string
}

interface GeneratedChoicePatch {
  parentNodeId?: unknown
  choiceId?: unknown
  text?: unknown
  emotionalIntent?: unknown
}

export async function backfillIncomingChoices(
  params: BackfillIncomingChoicesParams,
): Promise<number> {
  const project = await loadGalProject(params.projectPath)
  if (!project) throw new Error("未找到 Gal 项目")

  const route = project.routes.find((item) => item.id === params.routeId)
  const childNode = route?.nodes.find((item) => item.id === params.nodeId)
  if (!route || !childNode) throw new Error("未找到需要回写的后继节点")

  const childScript = (
    params.scriptContent
    ?? (await loadNodeScript(params.projectPath, params.routeId, params.nodeId) ?? "")
  ).trim()
  if (!childScript) return 0

  const linkedChoices = route.nodes.flatMap((parentNode) =>
    (parentNode.choices ?? [])
      .filter((choice) => choice.nextNodeId === childNode.id)
      .map((choice) => ({ parentNode, choice })),
  )
  if (linkedChoices.length === 0) return 0

  const incomingChoices: IncomingChoice[] = await Promise.all(
    linkedChoices.map(async ({ parentNode, choice }) => {
      const parentScript = await loadNodeScript(
        params.projectPath,
        params.routeId,
        parentNode.id,
      )
      return {
        parentNodeId: parentNode.id,
        parentTitle: parentNode.title,
        choiceId: choice.id,
        currentText: choice.text,
        currentIntent: choice.emotionalIntent,
        parentEnding: (parentScript ?? "").trim().slice(-600),
      }
    }),
  )

  const llmConfig = params.llmConfigOverride ?? useWikiStore.getState().llmConfig
  const messages = [
    {
      role: "system" as const,
      content: [
        "你负责校准 Galgame 父节点中通往后继节点的选项文案。",
        "后继节点的实际正文是唯一权威依据。",
        "只输出 JSON，不得补充输入中不存在的人物、地点、事件或关系。",
        "不要输出变量名、变量数值或变量影响。",
      ].join("\n"),
    },
    {
      role: "user" as const,
      content: [
        "请为每条父节点入口重写选项文本和情感意图，使其准确进入下面的后继节点。",
        "选项文本应描述玩家在父节点末尾作出的行动或回应，不要直接复述后继节点整段剧情。",
        "必须为每条输入返回一项，并原样保留 parentNodeId 与 choiceId。",
        '输出格式：{"choices":[{"parentNodeId":"...","choiceId":"...","text":"...","emotionalIntent":"..."}]}',
        "",
        "## 后继节点实际内容",
        `标题：${childNode.title}`,
        `人物：${childNode.characters.join("、") || "未设置"}`,
        `目标：${childNode.goal || "未设置"}`,
        `场景：${childNode.scene || "未设置"}`,
        `摘要：${childNode.summary || "未设置"}`,
        `正文开头：\n${childScript.slice(0, 3000)}`,
        "",
        "## 需要回写的父节点选项",
        ...incomingChoices.map((item, index) => [
          `${index + 1}. parentNodeId=${item.parentNodeId}`,
          `choiceId=${item.choiceId}`,
          `父节点标题：${item.parentTitle}`,
          `父节点正文结尾：${item.parentEnding || "无"}`,
          `原选项文本：${item.currentText || "无"}`,
          `原情感意图：${item.currentIntent || "无"}`,
        ].join("\n")),
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
  await streamChat(llmConfig, messages, callbacks, undefined, { temperature: 0.1 })
  if (streamError) throw streamError

  const patches = parseChoicePatches(raw)
  const patchByKey = new Map(
    patches.map((patch) => [`${patch.parentNodeId}:${patch.choiceId}`, patch]),
  )
  const actualGoal = buildActualGoal(childNode.goal, childNode.summary, childScript)
  let updatedCount = 0

  for (const { parentNode, choice } of linkedChoices) {
    const patch = patchByKey.get(`${parentNode.id}:${choice.id}`)
    const text = cleanText(patch?.text)
    const emotionalIntent = cleanText(patch?.emotionalIntent)
    if (text) choice.text = text
    if (emotionalIntent) choice.emotionalIntent = emotionalIntent
    choice.nextNodeTitle = childNode.title
    choice.nextNodeGoal = actualGoal
    parentNode.updatedAt = new Date().toISOString()
    updatedCount += 1
  }

  await saveGalProject(params.projectPath, project)
  return updatedCount
}

function parseChoicePatches(raw: string): Array<{
  parentNodeId: string
  choiceId: string
  text: string
  emotionalIntent: string
}> {
  const jsonText =
    raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.match(/\{[\s\S]*\}/)?.[0]
    ?? raw.match(/\{[\s\S]*\}/)?.[0]
  if (!jsonText) throw new Error("前置选项回写失败：AI 未返回有效 JSON")

  const parsed = JSON.parse(jsonText) as { choices?: GeneratedChoicePatch[] }
  if (!Array.isArray(parsed.choices)) {
    throw new Error("前置选项回写失败：JSON 中缺少 choices 数组")
  }
  return parsed.choices.map((item) => ({
    parentNodeId: cleanText(item.parentNodeId),
    choiceId: cleanText(item.choiceId),
    text: cleanText(item.text),
    emotionalIntent: cleanText(item.emotionalIntent),
  }))
}

function buildActualGoal(goal: string, summary: string, script: string): string {
  return cleanText(goal) || cleanText(summary) || cleanText(script).slice(0, 160)
}

function cleanText(value: unknown): string {
  return typeof value === "string"
    ? value.replace(/\s+/g, " ").trim()
    : ""
}
