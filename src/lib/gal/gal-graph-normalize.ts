import type { GalChoice, GalNode, GalNodeType, GalProject, GalRoute } from "./gal-types"

type LegacyChoice = GalChoice & {
  targetNodeId?: unknown
  targetId?: unknown
  nodeId?: unknown
  next?: unknown
}

export interface GalOutgoingTarget {
  targetId: string
  choiceId?: string
  choiceText?: string
  source: "choice" | "direct"
}

export function normalizeGalProjectRelations(project: GalProject): GalProject {
  const routes = (project.routes ?? []).map((route) => normalizeGalRouteRelations(route))
  const mainRoute = routes.find((route) => route.id === "main") ?? routes[0]
  const mainNodeIds = new Set((mainRoute?.nodes ?? []).map((node) => node.id))

  return {
    ...project,
    routes: routes.map((route) => ({
      ...route,
      nodeIds: Array.isArray(route.nodeIds)
        ? Array.from(new Set(route.nodeIds.filter((nodeId) => mainNodeIds.has(nodeId))))
        : undefined,
    })),
  }
}

export function normalizeGalRouteRelations(route: GalRoute): GalRoute {
  const nodes = collectRealRouteNodes(route)
    .map((node) => normalizeGalNodeRelationFields(node))
  const nodeIds = new Set(nodes.map((node) => node.id))
  const outgoingByNode = new Map<string, Set<string>>()
  for (const node of nodes) {
    outgoingByNode.set(node.id, new Set())
  }

  for (const node of nodes) {
    const outgoing = outgoingByNode.get(node.id) ?? new Set<string>()
    for (const childId of node.children ?? []) {
      if (nodeIds.has(childId) && childId !== node.id) outgoing.add(childId)
    }
    for (const choice of node.choices ?? []) {
      if (choice.nextNodeId && nodeIds.has(choice.nextNodeId) && choice.nextNodeId !== node.id) {
        outgoing.add(choice.nextNodeId)
      }
    }
    outgoingByNode.set(node.id, outgoing)
  }

  for (const node of nodes) {
    for (const parentId of node.parents ?? []) {
      if (!nodeIds.has(parentId) || parentId === node.id) continue
      outgoingByNode.get(parentId)?.add(node.id)
    }
  }

  for (const node of nodes) {
    node.children = Array.from(outgoingByNode.get(node.id) ?? [])
  }

  for (const node of nodes) {
    const parents = new Set(
      (node.parents ?? []).filter((parentId) => nodeIds.has(parentId) && parentId !== node.id),
    )
    for (const [parentId, childIds] of outgoingByNode) {
      if (childIds.has(node.id)) parents.add(parentId)
    }
    node.parents = Array.from(parents)
  }

  return {
    ...route,
    endingNodeIds: Array.from(new Set([
      ...(route.endingNodeIds ?? []).filter((id) => nodeIds.has(id)),
      ...nodes.filter((node) => node.type === "ending").map((node) => node.id),
    ])),
    nodes,
  }
}

export function normalizeGalNodeRelationFields(node: GalNode): GalNode {
  return {
    ...node,
    type: normalizeGalNodeType(node.type),
    parents: Array.isArray(node.parents) ? Array.from(new Set(node.parents.filter(Boolean))) : [],
    children: Array.isArray(node.children) ? Array.from(new Set(node.children.filter(Boolean))) : [],
    choices: Array.isArray(node.choices)
      ? node.choices.map((choice) => normalizeGalChoiceTarget(choice))
      : [],
  }
}

export function normalizeGalNodeType(type: unknown): GalNodeType {
  return isGalNodeType(type) ? type : "daily"
}

function isGalNodeType(type: unknown): type is GalNodeType {
  return typeof type === "string" && [
    "entry",
    "daily",
    "choice",
    "common",
    "clue",
    "cg",
    "ending",
  ].includes(type)
}

export function normalizeGalChoiceTarget(choice: GalChoice): GalChoice {
  const legacy = choice as LegacyChoice
  const target =
    stringOrEmpty(choice.nextNodeId)
    || stringOrEmpty(legacy.targetNodeId)
    || stringOrEmpty(legacy.targetId)
    || stringOrEmpty(legacy.nodeId)
    || stringOrEmpty(legacy.next)

  return {
    ...choice,
    nextNodeId: target || undefined,
    condition: Array.isArray(choice.condition) ? choice.condition : undefined,
    effects: Array.isArray(choice.effects) ? choice.effects : [],
  }
}

export function getNodeOutgoingTargets(
  node: GalNode,
  nodeById?: Map<string, GalNode>,
): GalOutgoingTarget[] {
  const targets: GalOutgoingTarget[] = []
  const seen = new Set<string>()
  for (const choice of node.choices ?? []) {
    const targetId = choice.nextNodeId?.trim()
    if (!targetId || seen.has(`choice:${choice.id}:${targetId}`)) continue
    if (nodeById && !nodeById.has(targetId)) continue
    targets.push({
      targetId,
      choiceId: choice.id,
      choiceText: choice.text,
      source: "choice",
    })
    seen.add(`choice:${choice.id}:${targetId}`)
    seen.add(`target:${targetId}`)
  }
  for (const childId of node.children ?? []) {
    if (!childId || seen.has(`target:${childId}`)) continue
    if (nodeById && !nodeById.has(childId)) continue
    targets.push({
      targetId: childId,
      source: "direct",
    })
    seen.add(`target:${childId}`)
  }
  return targets
}

export function hasNodeOutgoingTarget(node: GalNode, nodeById?: Map<string, GalNode>): boolean {
  return getNodeOutgoingTargets(node, nodeById).length > 0
}

export function detectGalGraphIssues(route: GalRoute): string[] {
  const issues: string[] = []
  const nodeIds = new Set<string>()

  for (const node of route.nodes ?? []) {
    const nodeId = stringOrEmpty(node?.id)
    if (!nodeId) {
      issues.push("节点列表中存在缺少 id 的无效节点")
      continue
    }
    if (nodeIds.has(nodeId)) {
      issues.push(`节点列表中存在重复 id：${nodeId}`)
      continue
    }
    nodeIds.add(nodeId)
  }

  for (const node of route.nodes ?? []) {
    if (!nodeIds.has(node.id)) continue
    for (const choice of node.choices ?? []) {
      const targetId = choice.nextNodeId?.trim()
      if (targetId && !nodeIds.has(targetId)) {
        issues.push(`节点 ${node.id} 的选项 ${choice.id} 指向不存在的节点：${targetId}`)
      }
    }
    for (const childId of node.children ?? []) {
      if (childId && !nodeIds.has(childId)) {
        issues.push(`节点 ${node.id} 的默认出口指向不存在的节点：${childId}`)
      }
    }
  }

  return issues
}

function collectRealRouteNodes(route: GalRoute): GalNode[] {
  const nodes: GalNode[] = []
  const seen = new Set<string>()

  for (const node of route.nodes ?? []) {
    const nodeId = stringOrEmpty(node?.id)
    if (!nodeId) {
      console.warn("[GhostNode] 已忽略缺少 id 的无效节点", node)
      continue
    }
    if (seen.has(nodeId)) {
      console.warn("[GhostNode] 已忽略重复 id 的占位节点", nodeId, node)
      continue
    }
    seen.add(nodeId)
    nodes.push(node)
  }

  return nodes
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}
