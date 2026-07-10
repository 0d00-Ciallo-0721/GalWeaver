import { createDirectory, fileExists, listDirectory, readFile, writeFile } from "@/commands/fs"
import { isTauri } from "@/lib/platform"
import { getNodeOutgoingTargets } from "./gal-graph-normalize"
import { loadNodeScript, saveGalProject, saveNodeScript } from "./gal-storage"
import type { GalNode, GalProject, GalRoute } from "./gal-types"

export interface GalIncomingPathOption {
  parentId: string
  parentTitle: string
  choiceText?: string
}

export type GalPathTraceResult =
  | { status: "complete"; nodes: GalNode[] }
  | { status: "needs-selection"; node: GalNode; options: GalIncomingPathOption[] }
  | { status: "error"; message: string }

export interface GalNovelExport {
  content: string
  missingNodes: GalNode[]
}

export interface GalProjectExportResult {
  exportPath: string
  nodeCount: number
  routeCount: number
  missingNodes: GalNode[]
}

export interface GalRouteTreeExportResult {
  exportPath: string
  nodeCount: number
  missingNodes: GalNode[]
  terminalNodeCount: number
}

const GAL_EXPORT_MARKER_FILE = ".qmai-export.json"

export interface GalProjectImportResult {
  nodeCount: number
  scriptCount: number
}

export function traceGalPathToEntry(
  route: GalRoute,
  targetNodeId: string,
  selectedParents: Record<string, string> = {},
): GalPathTraceResult {
  const nodeById = new Map((route.nodes ?? []).map((node) => [node.id, node]))
  const target = nodeById.get(targetNodeId)
  if (!target) {
    return { status: "error", message: "目标节点不存在，无法导出线路。" }
  }
  if (!route.entryNodeId || !nodeById.has(route.entryNodeId)) {
    return { status: "error", message: "主线路没有有效入口节点，无法导出线路。" }
  }

  const reversed: GalNode[] = []
  const visited = new Set<string>()
  let current = target

  while (true) {
    if (visited.has(current.id)) {
      return { status: "error", message: `线路中存在循环：${current.title}` }
    }
    visited.add(current.id)
    reversed.push(current)

    if (current.id === route.entryNodeId) {
      return { status: "complete", nodes: reversed.reverse() }
    }

    const options = getIncomingPathOptions(route, current.id)
    if (options.length === 0) {
      return {
        status: "error",
        message: `节点「${current.title}」无法向上连接到入口节点。`,
      }
    }

    const selectedParentId = options.length === 1
      ? options[0].parentId
      : selectedParents[current.id]

    if (!selectedParentId) {
      return { status: "needs-selection", node: current, options }
    }

    const selected = options.find((option) => option.parentId === selectedParentId)
    if (!selected) {
      return {
        status: "error",
        message: `节点「${current.title}」选择的父节点已经失效。`,
      }
    }

    const parent = nodeById.get(selected.parentId)
    if (!parent) {
      return { status: "error", message: `父节点 ${selected.parentId} 不存在。` }
    }
    current = parent
  }
}

export function getIncomingPathOptions(
  route: GalRoute,
  nodeId: string,
): GalIncomingPathOption[] {
  const nodeById = new Map((route.nodes ?? []).map((node) => [node.id, node]))
  const target = nodeById.get(nodeId)
  if (!target) return []

  const parentIds = new Set(target.parents ?? [])
  for (const candidate of route.nodes ?? []) {
    if (getNodeOutgoingTargets(candidate, nodeById).some((edge) => edge.targetId === nodeId)) {
      parentIds.add(candidate.id)
    }
  }

  const options: GalIncomingPathOption[] = []
  for (const parentId of parentIds) {
    const parent = nodeById.get(parentId)
    if (!parent) continue
    const edge = getNodeOutgoingTargets(parent, nodeById)
      .find((targetEdge) => targetEdge.targetId === nodeId)
    options.push({
      parentId,
      parentTitle: parent.title,
      choiceText: edge?.choiceText,
    })
  }
  return options
}

export async function buildGalNovelMarkdown(
  projectPath: string,
  routeId: string,
  title: string,
  nodes: GalNode[],
): Promise<GalNovelExport> {
  const missingNodes: GalNode[] = []
  const sections: string[] = [`# ${title}`]

  for (const [index, node] of nodes.entries()) {
    const script = (await loadNodeScript(projectPath, routeId, node.id))?.trim() ?? ""
    sections.push(`## ${index + 1}. ${node.title}`)
    if (script) {
      sections.push(script)
    } else {
      missingNodes.push(node)
      sections.push("> 该节点正文尚未生成。")
    }
  }

  return {
    content: `${sections.join("\n\n")}\n`,
    missingNodes,
  }
}

export async function buildGalRouteTreeMarkdown(
  projectPath: string,
  routeId: string,
  route: GalRoute,
): Promise<GalNovelExport> {
  const nodes = route.nodes ?? []
  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  const missingNodes: GalNode[] = []
  const visited = new Set<string>()
  const sections: string[] = [`# ${route.title}`]

  if (route.theme?.trim()) {
    sections.push(route.theme.trim())
  }

  const visit = async (node: GalNode, depth: number) => {
    const headingDepth = Math.min(6, depth + 2)
    const heading = "#".repeat(headingDepth)
    if (visited.has(node.id)) {
      sections.push(`${heading} ${node.title}（已在前文出现）`)
      return
    }
    visited.add(node.id)

    const script = (await loadNodeScript(projectPath, routeId, node.id))?.trim() ?? ""
    sections.push(`${heading} ${node.title}`)
    if (script) {
      sections.push(script)
    } else {
      missingNodes.push(node)
      sections.push("> 该节点正文尚未生成。")
    }

    const outgoing = getNodeOutgoingTargets(node, nodeById)
    if (outgoing.length > 0) {
      sections.push("**选项 / 后续：**")
      sections.push(...outgoing.map((edge) => {
        const target = nodeById.get(edge.targetId)
        return `- ${edge.choiceText || "后续"} -> ${target?.title ?? edge.targetId}`
      }))
    }

    for (const edge of outgoing) {
      const target = nodeById.get(edge.targetId)
      if (target) await visit(target, depth + 1)
    }
  }

  const entry = route.entryNodeId ? nodeById.get(route.entryNodeId) : undefined
  if (entry) await visit(entry, 0)
  for (const node of nodes) {
    if (!visited.has(node.id)) await visit(node, 0)
  }

  return {
    content: `${sections.join("\n\n")}\n`,
    missingNodes,
  }
}

export async function saveGalNovelMarkdown(
  defaultName: string,
  content: string,
): Promise<string | null> {
  const fileName = `${makeSafeExportName(defaultName)}.md`
  if (!isTauri()) {
    const blob = new Blob([content], { type: "text/markdown;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = fileName
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    URL.revokeObjectURL(url)
    return fileName
  }

  const { save } = await import("@tauri-apps/plugin-dialog")
  const selectedPath = await save({
    defaultPath: fileName,
    filters: [{ name: "Markdown 剧情文件", extensions: ["md"] }],
  })
  if (!selectedPath) return null
  await writeFile(selectedPath, content)
  return selectedPath
}

export async function exportGalProjectContents(
  projectPath: string,
  destinationRoot: string,
  project: GalProject,
): Promise<GalProjectExportResult> {
  const exportPath = joinPath(
    destinationRoot,
    `${makeSafeExportName(project.title)}-线路导出-${formatDate(new Date())}`,
  )
  const nodeDir = joinPath(exportPath, "节点正文")
  const routeDir = joinPath(exportPath, "已保存线路")
  await createDirectory(exportPath)
  await writeFile(
    joinPath(exportPath, GAL_EXPORT_MARKER_FILE),
    JSON.stringify({
      kind: "gal-route-export",
      title: project.title,
      exportedAt: new Date().toISOString(),
    }, null, 2),
  )
  await createDirectory(nodeDir)
  await createDirectory(routeDir)

  const mainRoute = project.routes.find((route) => route.id === "main")
    ?? project.routes.find((route) => !Array.isArray(route.nodeIds))
    ?? project.routes[0]
  if (!mainRoute) throw new Error("项目中没有可导出的线路。")

  const missingNodes: GalNode[] = []
  let nodeCount = 0
  for (const route of project.routes.filter((item) => !Array.isArray(item.nodeIds))) {
    for (const node of route.nodes ?? []) {
      const script = (await loadNodeScript(projectPath, route.id, node.id))?.trim() ?? ""
      if (!script) missingNodes.push(node)
      const nodeContent = [
        `# ${node.title}`,
        script || "> 该节点正文尚未生成。",
      ].join("\n\n")
      await writeFile(
        joinPath(nodeDir, `${String(++nodeCount).padStart(3, "0")}-${makeSafeExportName(node.title)}.md`),
        `${nodeContent}\n`,
      )
    }
  }

  let routeCount = 0
  for (const route of project.routes.filter((item) => Array.isArray(item.nodeIds))) {
    const pathNodes = (route.nodeIds ?? [])
      .map((nodeId) => mainRoute.nodes.find((node) => node.id === nodeId))
      .filter((node): node is GalNode => Boolean(node))
    if (pathNodes.length === 0) continue
    const novel = await buildGalNovelMarkdown(projectPath, mainRoute.id, route.title, pathNodes)
    await writeFile(
      joinPath(routeDir, `${makeSafeExportName(route.title)}.md`),
      novel.content,
    )
    routeCount++
  }

  await writeFile(joinPath(exportPath, "完整线路图.svg"), buildGalRouteSvg(mainRoute))
  await writeFile(
    joinPath(exportPath, "graph.json"),
    JSON.stringify(project, null, 2),
  )
  await writeFile(
    joinPath(exportPath, "线路总览.md"),
    buildProjectOverview(project, mainRoute, nodeCount, routeCount, missingNodes),
  )

  return { exportPath, nodeCount, routeCount, missingNodes }
}

export async function exportGalRouteTree(
  projectPath: string,
  destinationRoot: string,
  project: GalProject,
  routeId: string,
): Promise<GalRouteTreeExportResult> {
  const resolved = resolveRouteTreeForExport(project, routeId)
  if (!resolved) throw new Error("未找到要导出的线路树。")
  const { route, scriptRouteId } = resolved
  const exportPath = joinPath(
    destinationRoot,
    `${makeSafeExportName(project.title)}-${makeSafeExportName(route.title)}-树导出-${formatDate(new Date())}`,
  )
  const nodeDir = joinPath(exportPath, "节点正文")
  await createDirectory(exportPath)
  await createDirectory(nodeDir)
  await writeFile(
    joinPath(exportPath, GAL_EXPORT_MARKER_FILE),
    JSON.stringify({
      kind: "gal-route-tree-export",
      projectId: project.id,
      projectTitle: project.title,
      routeId: route.id,
      routeTitle: route.title,
      exportedAt: new Date().toISOString(),
    }, null, 2),
  )

  const missingNodes: GalNode[] = []
  let nodeCount = 0
  for (const node of route.nodes ?? []) {
    const script = (await loadNodeScript(projectPath, scriptRouteId, node.id))?.trim() ?? ""
    if (!script) missingNodes.push(node)
    const nodeContent = [
      `# ${node.title}`,
      script || "> 该节点正文尚未生成。",
    ].join("\n\n")
    await writeFile(
      joinPath(nodeDir, `${String(++nodeCount).padStart(3, "0")}-${makeSafeExportName(node.title)}.md`),
      `${nodeContent}\n`,
    )
  }

  await writeFile(
    joinPath(exportPath, "tree.json"),
    JSON.stringify({
      projectId: project.id,
      projectTitle: project.title,
      route,
    }, null, 2),
  )
  await writeFile(joinPath(exportPath, "tree.svg"), buildGalRouteSvg(route))
  await writeFile(
    joinPath(exportPath, "full-tree.md"),
    (await buildGalRouteTreeMarkdown(projectPath, scriptRouteId, route)).content,
  )
  await writeFile(
    joinPath(exportPath, "tree-overview.md"),
    buildRouteTreeOverview(project, route, nodeCount, missingNodes),
  )

  return {
    exportPath,
    nodeCount,
    missingNodes,
    terminalNodeCount: getRouteTerminalNodes(route).length,
  }
}

export async function canRestoreGalProjectExport(exportPath: string): Promise<boolean> {
  return fileExists(joinPath(exportPath, "graph.json"))
}

export async function restoreGalProjectFromExport(
  targetProjectPath: string,
  exportPath: string,
): Promise<GalProjectImportResult> {
  const rawGraph = await readFile(joinPath(exportPath, "graph.json"))
  const project = JSON.parse(rawGraph) as GalProject
  if (!Array.isArray(project.routes) || project.routes.length === 0) {
    throw new Error("导出目录里的 graph.json 没有可恢复的线路数据。")
  }

  const independentRoutes = project.routes.filter((route) => !Array.isArray(route.nodeIds))
  const exportedScripts = await loadExportedNodeScripts(exportPath)

  await saveGalProject(targetProjectPath, project)

  let nodeCount = 0
  let scriptCount = 0
  for (const route of independentRoutes) {
    for (const node of route.nodes ?? []) {
      const index = nodeCount++
      const script = exportedScripts.byTitle.get(node.title)?.shift()
        ?? exportedScripts.byIndex[index]
        ?? ""
      if (!script.trim()) continue
      await saveNodeScript(targetProjectPath, route.id, node.id, script)
      scriptCount++
    }
  }

  return { nodeCount, scriptCount }
}

export function buildGalRouteSvg(route: GalRoute): string {
  const nodes = route.nodes ?? []
  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  const positions = layoutSvgNodes(route)
  const width = Math.max(960, ...Array.from(positions.values()).map((point) => point.x + 300))
  const height = Math.max(540, ...Array.from(positions.values()).map((point) => point.y + 150))
  const edges: string[] = []

  for (const node of nodes) {
    const source = positions.get(node.id)
    if (!source) continue
    for (const edge of getNodeOutgoingTargets(node, nodeById)) {
      const target = positions.get(edge.targetId)
      if (!target) continue
      const x1 = source.x + 240
      const y1 = source.y + 45
      const x2 = target.x
      const y2 = target.y + 45
      const midX = x1 + Math.max(60, (x2 - x1) / 2)
      edges.push(
        `<path d="M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}" fill="none" stroke="#d97706" stroke-width="2" marker-end="url(#arrow)"/>`,
      )
      if (edge.choiceText) {
        edges.push(
          `<text x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2 - 6}" text-anchor="middle" fill="#334155" font-size="12">${escapeXml(truncate(edge.choiceText, 28))}</text>`,
        )
      }
    }
  }

  const nodeShapes = nodes.map((node) => {
    const point = positions.get(node.id) ?? { x: 40, y: 40 }
    return [
      `<g transform="translate(${point.x} ${point.y})">`,
      `<rect width="240" height="90" rx="6" fill="#111414" stroke="#64748b"/>`,
      `<text x="14" y="26" fill="#fbbf24" font-size="14" font-weight="600">${escapeXml(truncate(node.title, 22))}</text>`,
      `<text x="14" y="49" fill="#cbd5e1" font-size="12">${escapeXml(truncate(node.summary || node.goal, 34))}</text>`,
      `<text x="14" y="72" fill="#94a3b8" font-size="11">${escapeXml(node.type)} · ${escapeXml(node.status)}</text>`,
      "</g>",
    ].join("")
  })

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="100%" height="100%" fill="#f8fafc"/>`,
    `<defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="#d97706"/></marker></defs>`,
    `<text x="32" y="32" fill="#0f172a" font-size="20" font-weight="700">${escapeXml(route.title)}</text>`,
    ...edges,
    ...nodeShapes,
    `</svg>`,
  ].join("\n")
}

function layoutSvgNodes(route: GalRoute): Map<string, { x: number; y: number }> {
  const nodes = route.nodes ?? []
  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  const levels = new Map<string, number>()
  const queue = route.entryNodeId ? [route.entryNodeId] : []
  if (route.entryNodeId) levels.set(route.entryNodeId, 0)

  while (queue.length > 0) {
    const nodeId = queue.shift()!
    const node = nodeById.get(nodeId)
    if (!node) continue
    const nextLevel = (levels.get(nodeId) ?? 0) + 1
    for (const edge of getNodeOutgoingTargets(node, nodeById)) {
      if (!levels.has(edge.targetId)) {
        levels.set(edge.targetId, nextLevel)
        queue.push(edge.targetId)
      }
    }
  }

  let fallbackLevel = Math.max(0, ...levels.values()) + 1
  for (const node of nodes) {
    if (!levels.has(node.id)) levels.set(node.id, fallbackLevel++)
  }

  const rowsByLevel = new Map<number, number>()
  const positions = new Map<string, { x: number; y: number }>()
  for (const node of nodes) {
    if (node.boardPosition) {
      positions.set(node.id, {
        x: Math.max(40, node.boardPosition.x),
        y: Math.max(60, node.boardPosition.y),
      })
      continue
    }
    const level = levels.get(node.id) ?? 0
    const row = rowsByLevel.get(level) ?? 0
    rowsByLevel.set(level, row + 1)
    positions.set(node.id, { x: 40 + level * 340, y: 60 + row * 150 })
  }
  return positions
}

function resolveRouteTreeForExport(
  project: GalProject,
  routeId: string,
): { route: GalRoute; scriptRouteId: string } | null {
  const route = project.routes.find((item) => item.id === routeId)
  if (!route) return null
  if (!Array.isArray(route.nodeIds)) {
    return { route, scriptRouteId: route.id }
  }

  const mainRoute = project.routes.find((item) => item.id === "main")
    ?? project.routes.find((item) => !Array.isArray(item.nodeIds))
    ?? project.routes[0]
  const nodeById = new Map((mainRoute?.nodes ?? []).map((node) => [node.id, node]))
  const nodes = (route.nodeIds ?? [])
    .map((nodeId) => nodeById.get(nodeId))
    .filter((node): node is GalNode => Boolean(node))
  return {
    route: {
      ...route,
      entryNodeId: nodes[0]?.id ?? route.entryNodeId,
      endingNodeIds: (route.endingNodeIds ?? []).filter((nodeId) => nodes.some((node) => node.id === nodeId)),
      nodes,
    },
    scriptRouteId: mainRoute?.id ?? route.id,
  }
}

function getRouteTerminalNodes(route: GalRoute): GalNode[] {
  const nodeById = new Map((route.nodes ?? []).map((node) => [node.id, node]))
  return (route.nodes ?? []).filter((node) => getNodeOutgoingTargets(node, nodeById).length === 0)
}

function buildRouteTreeOverview(
  project: GalProject,
  route: GalRoute,
  nodeCount: number,
  missingNodes: GalNode[],
): string {
  const terminalNodes = getRouteTerminalNodes(route)
  const lines = [
    `# ${route.title} 树导出`,
    "",
    `- 所属项目：${project.title}`,
    `- 线路 ID：${route.id}`,
    `- 节点数：${nodeCount}`,
    `- 末节点：${terminalNodes.length}`,
    `- 缺失正文：${missingNodes.length}`,
    "",
    "## 线路说明",
    "",
    route.theme || "未填写线路说明。",
  ]
  if (terminalNodes.length > 0) {
    lines.push(
      "",
      "## 末节点",
      "",
      ...terminalNodes.map((node) => `- ${node.title}（${node.id}）`),
    )
  }
  if (missingNodes.length > 0) {
    lines.push(
      "",
      "## 缺失正文",
      "",
      ...missingNodes.map((node) => `- ${node.title}（${node.id}）`),
    )
  }
  return `${lines.join("\n")}\n`
}

function buildProjectOverview(
  project: GalProject,
  mainRoute: GalRoute,
  nodeCount: number,
  routeCount: number,
  missingNodes: GalNode[],
): string {
  const lines = [
    `# ${project.title} 线路导出`,
    "",
    `- 主图节点：${nodeCount}`,
    `- 已保存单线：${routeCount}`,
    `- 缺失正文：${missingNodes.length}`,
    "",
    "## 线路",
    "",
    ...project.routes.map((route) => (
      `- ${route.title}：${Array.isArray(route.nodeIds) ? route.nodeIds.length : route.nodes.length} 个节点`
    )),
    "",
    "## 主线路说明",
    "",
    mainRoute.theme || "未填写线路说明。",
  ]
  if (missingNodes.length > 0) {
    lines.push(
      "",
      "## 缺失正文",
      "",
      ...missingNodes.map((node) => `- ${node.title}（${node.id}）`),
    )
  }
  return `${lines.join("\n")}\n`
}

async function loadExportedNodeScripts(exportPath: string): Promise<{
  byTitle: Map<string, string[]>
  byIndex: string[]
}> {
  const nodeDir = joinPath(exportPath, "节点正文")
  const byTitle = new Map<string, string[]>()
  const byIndex: string[] = []
  let entries = []
  try {
    entries = await listDirectory(nodeDir)
  } catch {
    return { byTitle, byIndex }
  }

  const files = entries
    .filter((entry) => !entry.is_dir && entry.name.endsWith(".md"))
    .sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN", { numeric: true }))

  for (const entry of files) {
    const rawContent = await readFile(entry.path)
    const title = extractExportedNodeTitle(rawContent, entry.name)
    const content = stripExportedNodeHeading(rawContent)
    byIndex.push(content)
    const bucket = byTitle.get(title) ?? []
    bucket.push(content)
    byTitle.set(title, bucket)
  }

  return { byTitle, byIndex }
}

function extractExportedNodeTitle(content: string, fileName: string): string {
  const firstLine = content.split(/\r?\n/, 1)[0]?.trim() ?? ""
  if (firstLine.startsWith("# ")) {
    return firstLine.slice(2).trim()
  }
  return fileName.replace(/^\d+-/, "").replace(/\.md$/, "")
}

function stripExportedNodeHeading(content: string): string {
  return content.replace(/^# .*(?:\r?\n){1,2}/, "").trim()
}

function joinPath(base: string, ...segments: string[]): string {
  return [base.replace(/[\\/]+$/, ""), ...segments].join("/")
}

export function makeSafeExportName(name: string): string {
  const safe = name.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/, "")
  return safe || "未命名线路"
}

function formatDate(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("")
}

function truncate(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, " ").trim()
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 1)}…` : compact
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}
