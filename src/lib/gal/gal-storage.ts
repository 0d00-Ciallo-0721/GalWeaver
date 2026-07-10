/**
 * Galgame 鍓ф湰瀛樺偍灞? *
 * 璐熻矗 .gal/ 鐩綍涓嬫墍鏈夋暟鎹殑鎸佷箙鍖栬鍐欍€? * 澶嶇敤鐜版湁 Tauri FS 鍛戒护锛坮eadFile / writeFileAtomic / createDirectory / listDirectory / fileExists锛夈€? *
 * 鐩綍缁撴瀯锛? * project/
 *   .gal/
 *     project.json              鈫?GalProject锛堜笉鍚?nodes 瀹屾暣鏁版嵁锛屽彧鍚矾鐢卞厓鏁版嵁锛? *     variables.json            鈫?GalVariable[]
 *     clues.json                鈫?GalClue[]
 *     cgs.json                  鈫?GalCg[]
 *     global-memory.json        鈫?GalGlobalMemory
 *     routes.json               鈫?GalRoute[]锛堜粎鍏冩暟鎹紝涓嶅惈 nodes 姝ｆ枃锛? *     routes/{routeId}.json     鈫?鍗曟潯绾胯矾鐨勫畬鏁?node 鍒楄〃锛堜笉鍚鏂囷級
 *     nodes/{routeId}/{nodeId}.md  鈫?鑺傜偣姝ｆ枃锛圡arkdown + frontmatter锛? *     memory/
 *       route/{routeId}.json    鈫?GalRouteMemory
 *       node/{nodeId}.json      鈫?GalNodeMemory
 *
 * ponytail: 鐩存帴鐢?JSON + Markdown锛屼笉寮曞叆鏁版嵁搴撱€? */

import {
  readFile,
  writeFileAtomic,
  createDirectory,
  fileExists,
  listDirectory,
  deleteFile,
} from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import type {
  GalProject,
  GalRoute,
  GalNode,
  GalVariable,
  GalClue,
  GalCg,
  GalGlobalMemory,
  GalRouteMemory,
  GalNodeMemory,
  NodeSnapshot,
} from "./gal-types"
import { normalizeGalProjectRelations, normalizeGalRouteRelations } from "./gal-graph-normalize"
import { sanitizeGalProjectVariables } from "./gal-variable-guard"

type GalRouteMeta = Partial<GalRoute> & { id: string }

// 鈹€鈹€鈹€ 璺緞宸ュ叿 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

function galDir(projectPath: string): string {
  return `${normalizePath(projectPath)}/.gal`
}

function galPath(projectPath: string, ...segments: string[]): string {
  return [galDir(projectPath), ...segments].join("/")
}

async function ensureDir(dirPath: string): Promise<void> {
  if (!(await fileExists(dirPath))) {
    await createDirectory(dirPath)
  }
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    const raw = stripJsonBom(coerceText(await readFile(filePath)))
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

async function readRequiredJson<T>(filePath: string): Promise<T> {
  let raw: string
  try {
    raw = stripJsonBom(coerceText(await readFile(filePath)))
  } catch (err) {
    throw new Error(`读取 Gal 项目文件失败：${filePath}；${err instanceof Error ? err.message : String(err)}`)
  }
  try {
    return JSON.parse(raw) as T
  } catch (err) {
    throw new Error(`解析 Gal 项目文件失败：${filePath}；${err instanceof Error ? err.message : String(err)}`)
  }
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await writeFileAtomic(filePath, JSON.stringify(data, null, 2))
}

// 鈹€鈹€鈹€ 鐩綍鍒濆鍖?鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

export async function initGalDirectory(projectPath: string): Promise<void> {
  const dir = galDir(projectPath)
  await ensureDir(dir)
  await ensureDir(galPath(projectPath, "routes"))
  await ensureDir(galPath(projectPath, "nodes"))
  await ensureDir(galPath(projectPath, "memory"))
  await ensureDir(galPath(projectPath, "memory", "route"))
  await ensureDir(galPath(projectPath, "memory", "node"))
}

/** 妫€鏌ユ槸鍚﹀凡鍒濆鍖?Gal 椤圭洰 */
export async function isGalProject(projectPath: string): Promise<boolean> {
  return fileExists(galPath(projectPath, "project.json"))
}

// 鈹€鈹€鈹€ 椤圭洰璇诲啓 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

export async function saveGalProject(
  projectPath: string,
  project: GalProject,
): Promise<void> {
  await initGalDirectory(projectPath)
  const normalizedProject = normalizeGalProjectRelations(
    sanitizeGalProjectVariables(project),
  )

  // 鍒嗙锛歱roject.json 涓嶅瓨瀹屾暣鑺傜偣鏁版嵁锛屽彧瀛樿矾鐢卞厓鏁版嵁
  const projectRoutes = Array.isArray(normalizedProject.routes) ? normalizedProject.routes : []
  const routesMeta = projectRoutes.map((r) => ({
    id: r.id,
    title: r.title,
    theme: r.theme,
    nodeIds: Array.isArray(r.nodeIds) ? r.nodeIds : undefined,
    entryNodeId: r.entryNodeId,
    endingNodeIds: Array.isArray(r.endingNodeIds) ? r.endingNodeIds : [],
    nodeCount: Array.isArray(r.nodes) ? r.nodes.length : 0,
  }))

  await writeJson(galPath(projectPath, "project.json"), {
    ...normalizedProject,
    routes: routesMeta,
    // ponytail: nodes 鍜?clues 鍗曠嫭瀛橈紝閬垮厤 project.json 鑶ㄨ儉
  } as GalProject & { routes: typeof routesMeta })

  // 鍙橀噺
  await writeJson(galPath(projectPath, "variables.json"), normalizedProject.variables)

  // 绾跨储
  await writeJson(galPath(projectPath, "clues.json"), normalizedProject.clues)

  // CG
  await writeJson(galPath(projectPath, "cgs.json"), normalizedProject.cgs)

  // 路线元数据
  await writeJson(galPath(projectPath, "routes.json"), routesMeta)

  // 閫愭潯绾胯矾淇濆瓨锛堝惈鑺傜偣鍏冩暟鎹級
  for (const route of projectRoutes) {
    await saveGalRoute(projectPath, route)
  }
}

export async function loadGalProject(projectPath: string): Promise<GalProject | null> {
  const projectPathJson = galPath(projectPath, "project.json")
  if (!(await fileExists(projectPathJson))) return null
  const project = await readRequiredJson<GalProject>(projectPathJson)

  const variables = await readJson<GalVariable[]>(
    galPath(projectPath, "variables.json"),
  )
  const clues = await readJson<GalClue[]>(galPath(projectPath, "clues.json"))
  const cgs = await readJson<GalCg[]>(galPath(projectPath, "cgs.json"))

  // 鍔犺浇瀹屾暣绾胯矾鏁版嵁
  const routes: GalRoute[] = []
  const routesMeta = await loadRouteMetas(projectPath, project)

  for (const meta of routesMeta) {
    const route = await loadGalRoute(projectPath, meta.id)
    if (route) {
      routes.push(route)
    } else {
      routes.push({
        id: meta.id,
        title: typeof meta.title === "string" ? meta.title : "未命名线路",
        theme: typeof meta.theme === "string" ? meta.theme : "",
        ...(Array.isArray(meta.nodeIds) ? { nodeIds: meta.nodeIds } : {}),
        entryNodeId: typeof meta.entryNodeId === "string" ? meta.entryNodeId : "",
        endingNodeIds: Array.isArray(meta.endingNodeIds) ? meta.endingNodeIds : [],
        nodes: [],
      })
    }
  }

  return normalizeGalProjectRelations({
    ...project,
    variables: variables ?? [],
    clues: clues ?? [],
    cgs: cgs ?? [],
    routes: normalizeLoadedRoutes(routes),
  })
}

async function loadRouteMetas(
  projectPath: string,
  project: GalProject,
): Promise<GalRouteMeta[]> {
  const merged = new Map<string, GalRouteMeta>()
  const add = (meta: Partial<GalRoute>) => {
    if (typeof meta.id === "string" && meta.id.trim()) {
      merged.set(meta.id, { ...(merged.get(meta.id) ?? {}), ...meta, id: meta.id })
    }
  }
  const routesMeta = await readJson<Partial<GalRoute>[]>(
    galPath(projectPath, "routes.json"),
  )

  if (Array.isArray(routesMeta)) {
    for (const meta of routesMeta) add(meta)
  }
  if (Array.isArray(project.routes)) {
    for (const meta of project.routes) add(meta)
  }

  if (merged.size === 0) {
    try {
      const entries = await listDirectory(galPath(projectPath, "routes"))
      for (const entry of entries) {
        if (entry.is_dir || !entry.name.endsWith(".json") || entry.name.includes(".bak")) continue
        add({ id: entry.name.replace(/\.json$/, "") })
      }
    } catch {
      // routes.json/project.json 是主索引；目录扫描只做兜底。
    }
  }

  return Array.from(merged.values())
}

// 鈹€鈹€鈹€ 绾胯矾璇诲啓 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

export async function saveGalRoute(
  projectPath: string,
  route: GalRoute,
): Promise<void> {
  const normalizedRoute = normalizeGalRouteRelations(route)
  // 绾胯矾 JSON锛坣ode 鍏冩暟鎹笉鍚鏂囷級
  const routeData: Omit<GalRoute, "nodes"> & {
    nodes: Omit<GalNode, "scriptPath">[]
  } = {
    ...normalizedRoute,
    nodes: (Array.isArray(normalizedRoute.nodes) ? normalizedRoute.nodes : []).map((n) => {
      const { scriptPath: _sp, ...rest } = n
      return {
        ...normalizeNodeArrays(rest as GalNode),
        // scriptPath 鐢辩害瀹氭帹鏂細nodes/{routeId}/{nodeId}.md
      }
    }),
  }

  await ensureDir(galPath(projectPath, "routes"))
  await writeJson(galPath(projectPath, "routes", `${route.id}.json`), routeData)

  // 为每个路线确保节点目录存在
  await ensureDir(galPath(projectPath, "nodes", route.id))
}

export async function loadGalRoute(
  projectPath: string,
  routeId: string,
): Promise<GalRoute | null> {
  const data = await readJson<
    Omit<GalRoute, "nodes"> & {
      nodes: Omit<GalNode, "scriptPath">[]
    }
  >(galPath(projectPath, "routes", `${routeId}.json`))

  if (!data) return null

  const rawNodes = Array.isArray(data.nodes) ? data.nodes : []
  const nodes: GalNode[] = rawNodes.map((n) => ({
    ...normalizeNodeArrays(n as GalNode),
    scriptPath: `nodes/${routeId}/${n.id}.md`,
  }))

  return normalizeGalRouteRelations({
    ...data,
    endingNodeIds: Array.isArray(data.endingNodeIds) ? data.endingNodeIds : [],
    nodes,
  } as GalRoute)
}

// 鈹€鈹€鈹€ 鑺傜偣姝ｆ枃璇诲啓 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

export function getNodeScriptPath(
  projectPath: string,
  routeId: string,
  nodeId: string,
): string {
  return galPath(projectPath, "nodes", routeId, `${nodeId}.md`)
}

export async function saveNodeScript(
  projectPath: string,
  routeId: string,
  nodeId: string,
  content: string,
): Promise<void> {
  const nodeDir = galPath(projectPath, "nodes", routeId)
  await ensureDir(nodeDir)
  const filePath = getNodeScriptPath(projectPath, routeId, nodeId)
  await writeFileAtomic(filePath, content)
}

export async function loadNodeScript(
  projectPath: string,
  routeId: string,
  nodeId: string,
): Promise<string | null> {
  try {
    return coerceText(await readFile(getNodeScriptPath(projectPath, routeId, nodeId)))
  } catch {
    return null
  }
}

export async function deleteNodeScript(
  projectPath: string,
  routeId: string,
  nodeId: string,
): Promise<void> {
  const filePath = getNodeScriptPath(projectPath, routeId, nodeId)
  if (await fileExists(filePath)) {
    await deleteFile(filePath)
  }
}

// 鈹€鈹€鈹€ 璁板繂璇诲啓 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

export async function saveGlobalMemory(
  projectPath: string,
  memory: GalGlobalMemory,
): Promise<void> {
  await writeJson(galPath(projectPath, "global-memory.json"), memory)
}

export async function loadGlobalMemory(
  projectPath: string,
): Promise<GalGlobalMemory | null> {
  return readJson<GalGlobalMemory>(galPath(projectPath, "global-memory.json"))
}

export async function saveRouteMemory(
  projectPath: string,
  memory: GalRouteMemory,
): Promise<void> {
  await ensureDir(galPath(projectPath, "memory", "route"))
  await writeJson(
    galPath(projectPath, "memory", "route", `${memory.routeId}.json`),
    memory,
  )
}

export async function loadRouteMemory(
  projectPath: string,
  routeId: string,
): Promise<GalRouteMemory | null> {
  return readJson<GalRouteMemory>(
    galPath(projectPath, "memory", "route", `${routeId}.json`),
  )
}

export async function saveNodeMemory(
  projectPath: string,
  memory: GalNodeMemory,
): Promise<void> {
  await ensureDir(galPath(projectPath, "memory", "node"))
  await writeJson(
    galPath(projectPath, "memory", "node", `${memory.nodeId}.json`),
    memory,
  )
}

export async function loadNodeMemory(
  projectPath: string,
  nodeId: string,
): Promise<GalNodeMemory | null> {
  return readJson<GalNodeMemory>(
    galPath(projectPath, "memory", "node", `${nodeId}.json`),
  )
}

// 鈹€鈹€鈹€ 蹇収璇诲啓 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

export async function saveNodeSnapshot(
  projectPath: string,
  snapshot: NodeSnapshot,
): Promise<void> {
  await ensureDir(galPath(projectPath, "memory", "node"))
  await writeJson(
    galPath(projectPath, "memory", "node", `${snapshot.nodeId}.snapshot.json`),
    snapshot,
  )
}

export async function loadNodeSnapshot(
  projectPath: string,
  nodeId: string,
): Promise<NodeSnapshot | null> {
  return readJson<NodeSnapshot>(
    galPath(projectPath, "memory", "node", `${nodeId}.snapshot.json`),
  )
}

/** 鍒楀嚭鏌愭潯绾胯矾涓嬫墍鏈夎妭鐐圭殑 ID */
export async function listRouteNodeIds(
  projectPath: string,
  routeId: string,
): Promise<string[]> {
  const nodeDir = galPath(projectPath, "nodes", routeId)
  try {
    const entries = await listDirectory(nodeDir)
    return entries
      .filter((e) => e.name.endsWith(".md"))
      .map((e) => e.name.replace(/\.md$/, ""))
  } catch {
    return []
  }
}

// 鈹€鈹€鈹€ 绾跨储璇诲啓 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

export async function saveClues(
  projectPath: string,
  clues: GalClue[],
): Promise<void> {
  await writeJson(galPath(projectPath, "clues.json"), clues)
}

export async function loadClues(
  projectPath: string,
): Promise<GalClue[]> {
  return (await readJson<GalClue[]>(galPath(projectPath, "clues.json"))) ?? []
}

// 鈹€鈹€鈹€ 鍙橀噺璇诲啓 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

export async function saveVariables(
  projectPath: string,
  variables: GalVariable[],
): Promise<void> {
  await writeJson(galPath(projectPath, "variables.json"), variables)
}

export async function loadVariables(
  projectPath: string,
): Promise<GalVariable[]> {
  return (
    (await readJson<GalVariable[]>(galPath(projectPath, "variables.json"))) ?? []
  )
}

function normalizeNodeArrays(node: GalNode): GalNode {
  return {
    ...node,
    parents: Array.isArray(node.parents) ? node.parents : [],
    children: Array.isArray(node.children) ? node.children : [],
    choices: Array.isArray(node.choices)
      ? node.choices.map((choice) => ({
          ...choice,
          condition: Array.isArray(choice.condition) ? choice.condition : undefined,
          effects: Array.isArray(choice.effects) ? choice.effects : [],
        }))
      : [],
    characters: Array.isArray(node.characters) ? node.characters : [],
    clueIds: Array.isArray(node.clueIds) ? node.clueIds : [],
    aiPrompt: typeof node.aiPrompt === "string" ? node.aiPrompt : "",
  }
}

function normalizeLoadedRoutes(routes: GalRoute[]): GalRoute[] {
  if (routes.length === 0) {
    return [{
      id: "main",
      title: "主线路",
      theme: "主线树",
      nodeIds: undefined,
      entryNodeId: "",
      endingNodeIds: [],
      nodes: [],
    }]
  }

  const mainIndex = routes.findIndex((route) => route.id === "main")
  if (mainIndex >= 0) {
    return routes.map((route, index) => (
      index === mainIndex ? { ...route, title: "主线路", nodeIds: undefined } : route
    ))
  }

  const [first, ...rest] = routes
  return [
    { ...first, title: "主线路", nodeIds: undefined },
    ...rest,
  ]
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

function stripJsonBom(value: string): string {
  return value.charCodeAt(0) === 0xFEFF ? value.slice(1) : value
}
