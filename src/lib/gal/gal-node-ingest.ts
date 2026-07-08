/**
 * Galgame 节点记忆摄取
 *
 * 节点保存为 final 后自动触发，从正文中提取结构化信息：
 * - 节点摘要与结尾钩子
 * - 出场人物、场景、事件
 * - 角色状态变化与关系变化
 * - 认知变化
 * - 线索推进
 * - 变量变化
 * - 图谱节点与边
 *
 * 对应小说模式的 chapter-ingest.ts，但：
 * - 不操作 wiki/entities/（图谱暂由 gal-graph-adapter 单独处理）
 * - 状态传播到子节点（incomingState）
 * - 更新 route memory 的时间线
 *
 * ponytail: 一次 LLM 调用完成所有提取。
 */

import { streamChat, type StreamCallbacks } from "@/lib/llm-client"
import {
  saveNodeMemory,
  saveNodeSnapshot,
  loadRouteMemory,
  saveRouteMemory,
  loadGalProject,
  saveGalProject,
  loadNodeScript,
} from "./gal-storage"
import type {
  GalNode,
  GalEffect,
  GalRoute,
  NodeSnapshot,
  GalNodeMemory,
} from "./gal-types"
import { useWikiStore, type LlmConfig } from "@/stores/wiki-store"
import { getOutputLanguage, buildLanguageReminder } from "@/lib/output-language"
import { sanitizeGalChoices } from "./gal-variable-guard"

// ─── 摄取参数 ──────────────────────────────────────────────

export interface IngestNodeParams {
  projectPath: string
  routeId: string
  nodeId: string
  llmConfigOverride?: LlmConfig
  signal?: AbortSignal
}

export interface IngestNodeResult {
  snapshot: NodeSnapshot
  memory: GalNodeMemory
}

// ─── 核心摄取函数 ──────────────────────────────────────────

export async function ingestNode(
  params: IngestNodeParams,
): Promise<IngestNodeResult> {
  const store = useWikiStore.getState()
  const llmConfig = params.llmConfigOverride ?? store.llmConfig

  // 加载项目与节点
  const project = await loadGalProject(params.projectPath)
  if (!project) throw new Error("未找到 Gal 项目")

  const route = project.routes.find((r) => r.id === params.routeId)
  const node = route?.nodes.find((n) => n.id === params.nodeId)
  if (!route || !node) throw new Error(`未找到节点 ${params.nodeId}`)

  // 只摄取 final 状态的节点
  if (node.status !== "final") {
    throw new Error("只能摄取终稿状态的节点")
  }

  // 读取节点正文
  const script = await loadNodeScript(
    params.projectPath,
    params.routeId,
    params.nodeId,
  )
  if (!script) throw new Error("节点正文为空，请先生成")

  // 调用 LLM 提取结构化信息
  const snapshot = await extractNodeSnapshot(
    params.projectPath,
    params.routeId,
    node,
    script,
    project,
    llmConfig,
    params.signal,
  )

  // 构建节点记忆
  const now = new Date().toISOString()
  const memory: GalNodeMemory = {
    nodeId: node.id,
    routeId: params.routeId,
    summary: snapshot.summary,
    endingText: snapshot.endingHook,
    variableChanges: snapshot.variableChanges,
    characterStateChanges: snapshot.characterStateChanges,
    relationshipChanges: snapshot.relationshipChanges,
    choices: snapshot.choices,
    lastUpdated: now,
  }

  // 持久化
  await saveNodeMemory(params.projectPath, memory)
  await saveNodeSnapshot(params.projectPath, snapshot)

  // 更新 route memory 时间线
  await updateRouteTimeline(params.projectPath, params.routeId, node, snapshot)

  // 计算并设置 outgoingState
  node.outgoingState = computeOutgoingState(node, snapshot)
  node.updatedAt = now

  // 传播状态到直接子节点
  await propagateStateToChildren(project, route, node)

  // 保存更新后的项目和线路
  await saveGalProject(params.projectPath, project)

  return { snapshot, memory }
}

// ─── LLM 提取 ──────────────────────────────────────────────

async function extractNodeSnapshot(
  _projectPath: string,
  routeId: string,
  node: GalNode,
  script: string,
  project: Awaited<ReturnType<typeof loadGalProject>>,
  llmConfig: LlmConfig,
  signal?: AbortSignal,
): Promise<NodeSnapshot> {
  const lang = getOutputLanguage()
  const langReminder = buildLanguageReminder(lang)

  const variablesDesc = (project?.variables ?? [])
    .map((v) => `- ${v.id} (${v.name}): ${v.description}`)
    .join("\n")

  const cluesDesc = (project?.clues ?? [])
    .map((c) => `- ${c.id}: ${c.name}（类型：${c.type}，状态：${c.status}）`)
    .join("\n")

  const systemPrompt = `你是一个 Galgame 剧本编辑助手。请从节点正文中提取结构化信息。
严格按照 JSON 格式输出，不要输出任何其他内容。
${langReminder}`

  const userPrompt = `请从以下 Galgame 节点正文中提取结构化信息：

节点信息：
- 节点 ID：${node.id}
- 标题：${node.title}
- 类型：${node.type}
- 剧情目标：${node.goal}

正文：
${script.slice(0, 8000)}

项目变量定义：
${variablesDesc || "（无项目变量）"}

项目线索定义：
${cluesDesc || "（无项目线索）"}

请输出以下格式的 JSON：
{
  "nodeId": "${node.id}",
  "routeId": "${routeId}",
  "nodeTitle": "${node.title}",
  "nodeType": "${node.type}",
  "summary": "节点摘要（200字以内）",
  "characters": ["出场人物列表"],
  "locations": ["出场地点列表"],
  "scenes": ["场景描述列表"],
  "events": ["关键事件列表"],
  "characterStateChanges": ["角色状态变化描述，格式：角色名：变化描述"],
  "relationshipChanges": ["角色关系变化描述，格式：A→B：关系变化"],
  "cognitionChanges": ["角色认知变化描述，格式：角色名：知道/不知道XXX"],
  "clueChanges": ["线索推进描述，格式：发现/推进/回收：线索名"],
  "variableChanges": [],
  "endingHook": "节点结尾钩子描述（50字以内）",
  "choices": [
    {
      "id": "选项ID",
      "text": "选项文本",
      "emotionalIntent": "情感意图",
      "effects": [{ "variable": "变量ID", "op": "set" | "add", "value": 数值 }],
      "nextNodeTitle": "建议下一个节点标题",
      "nextNodeGoal": "建议下一个节点目标"
    }
  ],
  "graphNodes": ["图谱节点ID列表，如 character:角色名、location:地点名"],
  "graphEdges": ["图谱关系边列表，格式：A->关系->B。关系：出场于|发生于|持有|敌对|合作|怀疑|隐瞒|知道|不知道"]
}

注意：
- variableChanges 必须返回空数组。变量数值只由 Gal 编辑器里人工配置的选项 effects 负责，不要从正文推测变量变化。`

  const messages = [
    { role: "system" as const, content: systemPrompt },
    { role: "user" as const, content: userPrompt },
  ]

  let result = ""
  let streamError: Error | null = null
  const callbacks: StreamCallbacks = {
    onToken: (token: string) => { result += token },
    onDone: () => {},
    onError: (error: Error) => { streamError = error },
  }

  await streamChat(llmConfig, messages, callbacks, signal)
  if (streamError) throw streamError

  const jsonMatch =
    result.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.match(/\{[\s\S]*\}/)
    ?? result.match(/\{[\s\S]*\}/)

  if (!jsonMatch) {
    throw new Error("节点记忆提取失败：LLM 未返回有效 JSON")
  }

  const parsed = JSON.parse(jsonMatch[0])

  // 规范化快照
  return {
    nodeId: node.id,
    routeId,
    nodeTitle: node.title,
    nodeType: node.type,
    summary: parsed.summary || "",
    characters: Array.isArray(parsed.characters) ? parsed.characters : [],
    locations: Array.isArray(parsed.locations) ? parsed.locations : [],
    scenes: Array.isArray(parsed.scenes) ? parsed.scenes : [],
    events: Array.isArray(parsed.events) ? parsed.events : [],
    characterStateChanges: Array.isArray(parsed.characterStateChanges) ? parsed.characterStateChanges : [],
    relationshipChanges: Array.isArray(parsed.relationshipChanges) ? parsed.relationshipChanges : [],
    cognitionChanges: Array.isArray(parsed.cognitionChanges) ? parsed.cognitionChanges : [],
    clueChanges: Array.isArray(parsed.clueChanges) ? parsed.clueChanges : [],
    variableChanges: [],
    endingHook: parsed.endingHook || "",
    choices: sanitizeGalChoices(Array.isArray(parsed.choices) ? parsed.choices.map((c: Record<string, unknown>, i: number) => ({
      id: (c.id as string) || `c_${i}`,
      text: (c.text as string) || "",
      emotionalIntent: (c.emotionalIntent as string) || "",
      effects: Array.isArray(c.effects) ? c.effects as GalEffect[] : [],
      nextNodeTitle: (c.nextNodeTitle as string) || "",
      nextNodeGoal: (c.nextNodeGoal as string) || "",
    })) : [], project?.variables ?? []),
    graphNodes: Array.isArray(parsed.graphNodes) ? parsed.graphNodes : [],
    graphEdges: Array.isArray(parsed.graphEdges) ? parsed.graphEdges : [],
    sourceRevision: 1,
    snapshotId: `${node.id}-r1`,
    memorySyncedAt: new Date().toISOString(),
  }
}

// ─── 状态传播 ──────────────────────────────────────────────

/**
 * 从 LLM 提取结果计算节点的 outgoingState。
 *
 * ponytail: 在 incomingState 基础上叠加 variableChanges。
 */
function computeOutgoingState(
  node: GalNode,
  snapshot: NodeSnapshot,
): GalNode["outgoingState"] {
  const incoming = node.incomingState ?? {
    variables: {},
    characterCognition: {},
    acquiredClueIds: [],
    seenCgIds: [],
    visitedNodeIds: [],
    currentScene: "",
    characterMoods: {},
  }

  const outVars = { ...incoming.variables }
  for (const eff of snapshot.variableChanges) {
    if (eff.op === "set") {
      outVars[eff.variable] = eff.value
    } else if (eff.op === "add") {
      const current = Number(outVars[eff.variable] ?? 0)
      outVars[eff.variable] = current + Number(eff.value)
    }
  }

  return {
    ...incoming,
    variables: outVars,
    currentScene: snapshot.scenes[0] || incoming.currentScene,
    visitedNodeIds: [...incoming.visitedNodeIds, node.id],
  }
}

/**
 * 将当前节点的 outgoingState 传播为所有直接子节点的 incomingState。
 */
async function propagateStateToChildren(
  _project: NonNullable<Awaited<ReturnType<typeof loadGalProject>>>,
  route: GalRoute,
  node: GalNode,
): Promise<void> {
  if (!node.outgoingState) return

  for (const childId of node.children) {
    const child = route.nodes.find((n) => n.id === childId)
    if (!child) continue
    const choiceEffects = (node.choices ?? []).find((choice) => choice.nextNodeId === childId)?.effects ?? []
    const nextIncomingState = applyEffectsToState(node.outgoingState, choiceEffects)

    // 合并：对于共同节点，保留已有状态，叠加新状态
    if (child.parents.length > 1) {
      // 共同节点：合并所有父节点的状态（取并集）
      child.incomingState = mergeStates(
        child.incomingState,
        nextIncomingState,
      )
    } else {
      // 单一父节点：直接继承
      child.incomingState = { ...nextIncomingState }
    }
  }
}

function applyEffectsToState(
  state: NonNullable<GalNode["outgoingState"]>,
  effects: GalEffect[],
): NonNullable<GalNode["outgoingState"]> {
  if (effects.length === 0) return { ...state }
  const variables = { ...state.variables }
  for (const effect of effects) {
    if (effect.op === "set") {
      variables[effect.variable] = effect.value
    } else {
      const current = Number(variables[effect.variable] ?? 0)
      const delta = Number(effect.value)
      variables[effect.variable] = Number.isFinite(current) && Number.isFinite(delta)
        ? current + delta
        : effect.value
    }
  }
  return { ...state, variables }
}

function mergeStates(
  existing: GalNode["incomingState"],
  incoming: NonNullable<GalNode["outgoingState"]>,
): NonNullable<GalNode["outgoingState"]> {
  if (!existing) return { ...incoming }

  return {
    variables: { ...existing.variables, ...incoming.variables },
    characterCognition: {
      ...existing.characterCognition,
      ...incoming.characterCognition,
    },
    acquiredClueIds: [
      ...new Set([...existing.acquiredClueIds, ...incoming.acquiredClueIds]),
    ],
    seenCgIds: [
      ...new Set([...existing.seenCgIds, ...incoming.seenCgIds]),
    ],
    visitedNodeIds: [
      ...new Set([...existing.visitedNodeIds, ...incoming.visitedNodeIds]),
    ],
    currentScene:
      incoming.currentScene || existing.currentScene,
    characterMoods: {
      ...existing.characterMoods,
      ...incoming.characterMoods,
    },
  }
}

// ─── 时间线更新 ────────────────────────────────────────────

async function updateRouteTimeline(
  projectPath: string,
  routeId: string,
  node: GalNode,
  snapshot: NodeSnapshot,
): Promise<void> {
  let routeMemory = await loadRouteMemory(projectPath, routeId)
  if (!routeMemory) {
    routeMemory = {
      routeId,
      routeEvents: [],
      timeline: [],
      lastUpdated: new Date().toISOString(),
    }
  }

  // 添加节点事件到时间线
  for (const event of snapshot.events) {
    routeMemory.timeline.push({
      nodeId: node.id,
      nodeTitle: node.title,
      sequence: node.sequence,
      event,
    })
  }

  // 添加节点事件到 routeEvents
  routeMemory.routeEvents.push(
    ...snapshot.events.map((e) => `[${node.title}] ${e}`),
  )

  routeMemory.lastUpdated = new Date().toISOString()
  await saveRouteMemory(projectPath, routeMemory)
}
