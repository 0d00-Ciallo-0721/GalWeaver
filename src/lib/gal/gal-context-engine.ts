/**
 * Galgame 上下文引擎
 *
 * 替换小说模式的"最近 N 章窗口"为"当前路径祖先节点窗口"。
 * 同时复用小说模式的项目文档（大纲、灵魂文档、角色状态等），
 * 确保 Gal AI 写作时能感知项目设定。
 *
 * 上下文组装顺序：
 *   项目灵魂 → 项目大纲 → 角色档案 → Gal 全局设定
 *   → 线路主题 → 当前节点卡片 → 父节点结尾 → 子节点前文
 *   → 路径摘要 → 变量状态 → 角色情绪 → 线索 → 角色认知
 */

import { readFile } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import {
  loadGalProject,
  loadNodeScript,
  loadNodeMemory,
  loadGlobalMemory,
} from "./gal-storage"
import type {
  GalProject,
  GalNode,
  GalRoute,
} from "./gal-types"
import { readSoulDoc } from "@/lib/novel/soul-doc"
import { loadCharacterStates } from "@/lib/novel/character-state"
import { readOutlineContent } from "@/lib/novel/context-engine"

// ─── 上下文包 ──────────────────────────────────────────────

export interface GalContextPack {
  /** 用户请求原文 */
  task: string
  /** 项目灵魂文档（soul.md） */
  soulDoc: string
  /** 项目大纲 */
  outline: string
  /** 角色状态（从 novel 记忆库） */
  novelCharacterStates: string
  /** 项目全局设定（purpose.md / schema.md） */
  projectDocs: string
  /** Gal 全局设定 / 世界观 */
  premise: string
  /** 不可违背的规则 */
  globalRules: string
  /** 当前线路主题 */
  routeTheme: string
  /** 角色档案 */
  characterProfiles: string
  /** 当前节点信息（标题、类型、目标、场景） */
  nodeCard: string
  /** 父节点结尾 */
  parentEndings: string
  /** 子节点前文 */
  childBeginnings: string
  /** 路径摘要（从入口到父节点的各节点摘要链） */
  pathSummary: string
  /** 当前变量状态 */
  variableState: string
  /** 角色情绪状态 */
  characterMoods: string
  /** 已获线索 */
  acquiredClues: string
  /** 角色认知 */
  characterCognition: string
}

// ─── 核心函数 ──────────────────────────────────────────────

/**
 * 为指定节点构建上下文包。
 *
 * @param projectPath - 项目根目录
 * @param task - 用户任务描述
 * @param routeId - 当前线路 ID
 * @param nodeId - 当前节点 ID
 */
export async function buildGalContextPack(
  projectPath: string,
  task: string,
  routeId: string,
  nodeId: string,
): Promise<GalContextPack> {
  const pp = normalizePath(projectPath)

  // 加载项目数据
  const project = await loadGalProject(pp)
  if (!project) {
    return emptyGalContextPack(task)
  }

  const route = project.routes.find((r) => r.id === routeId)
  const node = route?.nodes.find((n) => n.id === nodeId)
  if (!route || !node) {
    return emptyGalContextPack(task)
  }

  const globalMemory = await loadGlobalMemory(pp)

  // 并行加载：项目文档 + Gal 数据
  const [
    soulDoc,
    outline,
    novelCharStates,
    projectDocs,
    parentEndings,
    childBeginnings,
    pathSummary,
    variableStateText,
    characterMoodsText,
    clueText,
    cognitionText,
  ] = await Promise.all([
    loadSoulDocSafe(pp),
    loadOutlineSafe(pp),
    loadCharacterStatesSafe(pp),
    loadProjectDocs(pp),
    buildParentEndings(pp, route, node),
    buildChildBeginnings(pp, route, node),
    buildPathSummary(pp, route, node),
    buildVariableState(node),
    buildCharacterMoods(node),
    buildClueContext(pp, project, node),
    buildCognitionContext(node),
  ])

  return {
    task,
    soulDoc,
    outline,
    novelCharacterStates: novelCharStates,
    projectDocs,
    premise: project.premise || "",
    globalRules: project.globalRules || (globalMemory?.canonRules ?? ""),
    routeTheme: route.theme || "",
    characterProfiles: buildCharacterProfiles(globalMemory, novelCharStates),
    nodeCard: buildNodeCard(node),
    parentEndings,
    childBeginnings,
    pathSummary,
    variableState: variableStateText,
    characterMoods: characterMoodsText,
    acquiredClues: clueText,
    characterCognition: cognitionText,
  }
}

/**
 * 将上下文包序列化为 LLM 提示词注入文本。
 *
 * 模仿 context-engine.ts 的 contextPackToPrompt 风格，
 * 但针对 Galgame 字段重新组织。
 */
export function galContextPackToPrompt(pack: GalContextPack): string {
  const sections: string[] = []

  const add = (title: string, content: unknown) => {
    const text = coerceText(content)
    if (text.trim()) {
      sections.push(`## ${title}\n${text.trim()}`)
    }
  }

  add("当前任务", pack.task)
  add("项目灵魂文档（写作风格与规则）", pack.soulDoc)
  add("项目大纲与世界观", pack.outline)
  add("角色状态（来自项目记忆库）", pack.novelCharacterStates)
  add("项目设定文档", pack.projectDocs)
  add("Gal 全局设定", pack.premise)
  add("不可违背的规则", pack.globalRules)
  add("当前线路主题", pack.routeTheme)
  add("角色档案", pack.characterProfiles)
  add("当前节点卡片（重要提示词部分）", pack.nodeCard)
  add("父节点结尾", pack.parentEndings)
  add("子节点前文", pack.childBeginnings)
  add("路径摘要（从入口到当前）", pack.pathSummary)
  add("当前变量状态", pack.variableState)
  add("角色情绪", pack.characterMoods)
  add("已获线索", pack.acquiredClues)
  add("角色认知（谁知道什么）", pack.characterCognition)

  return sections.join("\n\n")
}

// ─── 上下文构建辅助函数 ─────────────────────────────────────

function buildNodeCard(node: GalNode): string {
  const lines = [
    `- 节点ID：${node.id}`,
    `- 标题：${node.title}`,
    `- 类型：${node.type}`,
    `- 剧情目标：${node.goal}`,
    `- 场景：${node.scene}`,
    `- 出场人物：${node.characters.join("、")}`,
  ]

  if (node.choices.length > 0) {
    lines.push("- 当前选项：")
    node.choices.forEach((choice, index) => {
      lines.push(
        `  ${index + 1}. [${choice.id}] ${choice.text}；情感意图：${choice.emotionalIntent || "未设置"}；建议后续：${choice.nextNodeTitle || "未设置"} ${choice.nextNodeGoal || ""}`.trimEnd(),
      )
    })
  } else {
    lines.push("- 当前选项：未预设，不要生成新选项")
  }

  return lines.join("\n")
}

function buildCharacterProfiles(
  globalMemory: Awaited<ReturnType<typeof loadGlobalMemory>>,
  novelCharStates: string,
): string {
  const parts: string[] = []

  // Gal 全局记忆中的角色档案
  if (globalMemory?.characterProfiles) {
    parts.push(
      Object.entries(globalMemory.characterProfiles)
        .map(
          ([name, profile]) =>
            `### ${name}\n` +
            `- 身份：${profile.identity}\n` +
            `- 性格：${profile.personality}\n` +
            `- 外貌：${profile.appearance}\n` +
            `- 背景：${profile.background}`,
        )
        .join("\n\n"),
    )
  }

  // 小说模式角色状态
  if (novelCharStates.trim()) {
    parts.push(novelCharStates)
  }

  return parts.join("\n\n")
}

/**
 * 读取所有父节点的结尾文本。
 *
 * ponytail: 只取结尾 500 字，不加载完整正文。
 */
async function buildParentEndings(
  projectPath: string,
  route: GalRoute,
  node: GalNode,
): Promise<string> {
  if (node.parents.length === 0) return "（入口节点，无父节点）"

  const endings: string[] = []
  for (const parentId of node.parents) {
    const parentNode = route.nodes.find((n) => n.id === parentId)
    // 优先从节点记忆中获取结尾
    const memory = await loadNodeMemory(projectPath, parentId)
    if (memory?.endingText?.trim()) {
      endings.push(`### 父节点 ${parentId}\n${memory.endingText}`)
      continue
    }

    // 降级：读取正文取末 500 字
    const script = await loadNodeScript(projectPath, route.id, parentId)
    if (script?.trim()) {
      const tail = script.slice(-500).trim()
      endings.push(`### 父节点 ${parentId}\n...${tail}`)
      continue
    }

    endings.push(`### 父节点 ${parentId}\n${buildNodeFallbackText(parentNode)}`)
  }

  const prefix = node.parents.length > 1
    ? "该节点是收束节点。以下为多个直接父节点的结尾，请生成能兼容所有入口的共同正文，不要只承接其中一条。\n\n"
    : "该节点是普通剧情节点。以下为唯一直接父节点的结尾，请自然承接。\n\n"

  return `${prefix}${endings.join("\n\n")}`.trim()
}

async function buildChildBeginnings(
  projectPath: string,
  route: GalRoute,
  node: GalNode,
): Promise<string> {
  const childIds = collectDirectChildIds(node)
  if (childIds.length === 0) return "（无后继节点）"

  const beginnings: string[] = []
  for (const childId of childIds) {
    const childNode = route.nodes.find((n) => n.id === childId)
    const script = await loadNodeScript(projectPath, route.id, childId)
    if (script?.trim()) {
      beginnings.push(`### 子节点 ${childId}\n${script.slice(0, 500).trim()}...`)
      continue
    }

    beginnings.push(`### 子节点 ${childId}\n${buildNodeFallbackText(childNode)}`)
  }

  const prefix = childIds.length > 1
    ? "当前节点有多个直接后继节点。以下为后继节点开头/卡片信息，请让当前正文自然停在能通向这些后继的断点。\n\n"
    : "当前节点有一个直接后继节点。以下为后继节点开头/卡片信息，请让当前正文自然衔接它。\n\n"

  return `${prefix}${beginnings.join("\n\n")}`.trim()
}

function collectDirectChildIds(node: GalNode): string[] {
  return Array.from(new Set([
    ...(node.children ?? []),
    ...(node.choices ?? [])
      .map((choice) => choice.nextNodeId)
      .filter((id): id is string => Boolean(id)),
  ]))
}

function buildNodeFallbackText(node: GalNode | undefined): string {
  if (!node) return ""

  return [
    `标题：${node.title || ""}`,
    `人物：${(node.characters ?? []).join("、")}`,
    `目标：${node.goal || ""}`,
    `场景：${node.scene || ""}`,
  ].filter((line) => line.replace(/^(标题|人物|目标|场景)：/, "").trim()).join("\n")
}

/**
 * 从入口节点到当前节点的路径摘要。
 *
 * ponytail: 每个祖先节点只取摘要（节点记忆 > 节点卡片 summary），
 * 不取完整正文，避免上下文膨胀。
 */
async function buildPathSummary(
  projectPath: string,
  route: GalRoute,
  currentNode: GalNode,
): Promise<string> {
  // BFS 从入口找路径（简化：取所有祖先链）
  const chain = findAncestorChain(route, currentNode.id)
  if (chain.length <= 1) return "（入口节点）"

  const summaries: string[] = []
  for (const ancestorId of chain) {
    if (ancestorId === currentNode.id) break // 不包含当前节点自己

    const ancestorNode = route.nodes.find((n) => n.id === ancestorId)
    if (!ancestorNode) continue

    // 优先节点记忆的摘要
    const memory = await loadNodeMemory(projectPath, ancestorId)
    const summary = memory?.summary || ancestorNode.summary || "（无摘要）"

    summaries.push(
      `[${ancestorNode.title}] ${summary}`,
    )
  }

  return summaries.length > 0
    ? summaries.join("\n→ ")
    : "（无路径历史）"
}

/**
 * 在 DAG 中查找从入口节点到目标节点的一条路径。
 *
 * ponytail: BFS 最短路径，O(n+e)。不处理多路径，返回第一条找到的。
 */
function findAncestorChain(route: GalRoute, targetId: string): string[] {
  const entryId = route.entryNodeId
  const routeNodes = Array.isArray(route.nodes) ? route.nodes : []
  const nodeMap = new Map(routeNodes.map((n) => [n.id, n]))

  // BFS
  const visited = new Set<string>()
  const parent = new Map<string, string | null>()
  const queue = [entryId]
  parent.set(entryId, null)

  while (queue.length > 0) {
    const current = queue.shift()!
    if (current === targetId) break
    if (visited.has(current)) continue
    visited.add(current)

    const node = nodeMap.get(current)
    if (node) {
      for (const childId of node.children) {
        if (!parent.has(childId)) {
          parent.set(childId, current)
          queue.push(childId)
        }
      }
    }
  }

  // 回溯路径
  const chain: string[] = []
  let cursor: string | null = targetId
  while (cursor) {
    chain.unshift(cursor)
    cursor = parent.get(cursor) ?? null
  }

  return chain
}

function buildVariableState(node: GalNode): string {
  const vars = node.incomingState?.variables
  if (!vars || Object.keys(vars).length === 0) {
    return "（所有变量均为初始值）"
  }
  return Object.entries(vars)
    .map(([key, val]) => `- ${key}: ${JSON.stringify(val)}`)
    .join("\n")
}

function buildCharacterMoods(node: GalNode): string {
  const moods = node.incomingState?.characterMoods
  if (!moods || Object.keys(moods).length === 0) {
    return "（无情绪记录）"
  }
  return Object.entries(moods)
    .map(([char, mood]) => `- ${char}: ${mood}`)
    .join("\n")
}

async function buildClueContext(
  _projectPath: string,
  project: GalProject,
  node: GalNode,
): Promise<string> {
  const acquiredIds = node.incomingState?.acquiredClueIds ?? []
  if (acquiredIds.length === 0) return "（未获得任何线索）"

  const clues = project.clues.filter((c) => acquiredIds.includes(c.id))
  if (clues.length === 0) return "（未获得任何线索）"

  return clues
    .map(
      (c) =>
        `- [${c.type}] ${c.name}：${c.description}（状态：${c.status}）`,
    )
    .join("\n")
}

function buildCognitionContext(node: GalNode): string {
  const cognition = node.incomingState?.characterCognition
  if (!cognition || Object.keys(cognition).length === 0) {
    return "（无认知记录）"
  }

  return Object.entries(cognition)
    .map(([char, cog]) => {
      const parts: string[] = []
      if (cog.knows.length > 0) {
        parts.push(`  知道：${cog.knows.join("、")}`)
      }
      if (cog.doesNotKnow.length > 0) {
        parts.push(`  不知道：${cog.doesNotKnow.join("、")}`)
      }
      if (cog.readerKnowsButCharacterDoesNot.length > 0) {
        parts.push(
          `  读者知道但角色不知道：${cog.readerKnowsButCharacterDoesNot.join("、")}`,
        )
      }
      return `- ${char}：\n${parts.join("\n")}`
    })
    .join("\n")
}

// ─── 项目文档加载辅助 ─────────────────────────────────────────

async function loadSoulDocSafe(pp: string): Promise<string> {
  try {
    return await readSoulDoc(pp)
  } catch {
    return ""
  }
}

async function loadOutlineSafe(pp: string): Promise<string> {
  try {
    return await readOutlineContent(pp)
  } catch {
    return ""
  }
}

async function loadCharacterStatesSafe(pp: string): Promise<string> {
  try {
    const store = await loadCharacterStates(pp)
    if (!store || store.characters.length === 0) return ""
    return store.characters
      .map(
        (c) =>
          `- ${c.characterName}：${c.status}（位置：${c.currentLocation || "未知"}）`,
      )
      .join("\n")
  } catch {
    return ""
  }
}

async function loadProjectDocs(pp: string): Promise<string> {
  const docs: string[] = []
  // purpose.md
  try {
    const content = coerceText(await readFile(`${pp}/purpose.md`))
    if (content.trim()) docs.push(content.slice(0, 500))
  } catch {}
  // schema.md 通常不是写作相关，跳过
  // soul.md 已通过 readSoulDoc 单独加载，不重复
  return docs.join("\n\n")
}

function coerceText(value: unknown): string {
  if (typeof value === "string") return value
  if (value === null || value === undefined) return ""
  if (typeof value === "object") {
    const record = value as Record<string, unknown>
    if (typeof record.content === "string") return record.content
    if (typeof record.text === "string") return record.text
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  return String(value)
}

// ─── 空上下文包 ────────────────────────────────────────────

function emptyGalContextPack(task: string): GalContextPack {
  return {
    task,
    soulDoc: "",
    outline: "",
    novelCharacterStates: "",
    projectDocs: "",
    premise: "",
    globalRules: "",
    routeTheme: "",
    characterProfiles: "",
    nodeCard: "",
    parentEndings: "",
    childBeginnings: "",
    pathSummary: "",
    variableState: "",
    characterMoods: "",
    acquiredClues: "",
    characterCognition: "",
  }
}
