import { streamChat, type StreamCallbacks } from "@/lib/llm-client"
import { useWikiStore, type LlmConfig } from "@/stores/wiki-store"
import { loadGalProject, saveGalProject } from "./gal-storage"

export interface UpdateNodeSummaryParams {
  projectPath: string
  routeId: string
  nodeId: string
  scriptContent: string
  llmConfigOverride?: LlmConfig
}

export async function updateNodeSummary(
  params: UpdateNodeSummaryParams,
): Promise<string> {
  const project = await loadGalProject(params.projectPath)
  if (!project) throw new Error("未找到 Gal 项目")

  const route = project.routes.find((item) => item.id === params.routeId)
  const node = route?.nodes.find((item) => item.id === params.nodeId)
  if (!route || !node) throw new Error("未找到当前节点")

  const llmConfig = params.llmConfigOverride ?? useWikiStore.getState().llmConfig
  const fallback = buildFallbackSummary(node.title, node.goal, node.scene, params.scriptContent)
  const messages = [
    {
      role: "system" as const,
      content: [
        "你是 Galgame 视觉小说节点摘要编辑。",
        "只输出一句中文摘要，不要解释，不要列表，不要 Markdown。",
        "摘要用于线路画布卡片展示，必须概括当前节点真实内容。",
      ].join("\n"),
    },
    {
      role: "user" as const,
      content: [
        "请基于当前节点卡片和正文生成 40-90 字摘要。",
        "要求：",
        "- 优先概括已经写出的正文剧情。",
        "- 正文不足时，使用标题、目标、场景、人物补足。",
        "- 不要写变量 ID、变量数值、选项列表或“尚未生成”等占位话。",
        "",
        `标题：${node.title}`,
        `人物：${node.characters.join("、") || "未设置"}`,
        `目标：${node.goal || "未设置"}`,
        `场景：${node.scene || "未设置"}`,
        `当前旧摘要：${node.summary || "无"}`,
        "",
        `正文：\n${params.scriptContent.trim().slice(0, 6000) || fallback}`,
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

  await streamChat(llmConfig, messages, callbacks, undefined, { temperature: 0.2 })
  if (streamError) throw streamError

  const summary = cleanSummary(raw) || fallback
  node.summary = summary
  node.updatedAt = new Date().toISOString()
  await saveGalProject(params.projectPath, project)
  return summary
}

function buildFallbackSummary(title: string, goal: string, scene: string, script: string): string {
  const scriptText = cleanSummary(script)
  if (scriptText) return scriptText.slice(0, 90)
  return cleanSummary([title, goal, scene].filter(Boolean).join("；")).slice(0, 90)
}

function cleanSummary(value: string): string {
  return value
    .replace(/```(?:\w+)?/g, "")
    .replace(/```/g, "")
    .replace(/^摘要[：:]\s*/u, "")
    .replace(/^[“"']|[”"']$/g, "")
    .replace(/\s+/g, " ")
    .trim()
}
