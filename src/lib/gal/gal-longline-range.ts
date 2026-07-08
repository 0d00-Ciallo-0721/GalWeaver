import { getNodeOutgoingTargets } from "./gal-graph-normalize"
import type { GalNode, GalRoute } from "./gal-types"

export type GalLonglineDirection = "upstream" | "downstream"

export type GalLonglineStopReason =
  | "entry_node"
  | "ending_node"
  | "branch_node"
  | "merge_node"
  | "dead_end"
  | "broken_link"
  | "cycle"
  | "missing_selected_node"

export interface GalLonglineStop {
  direction: GalLonglineDirection
  reason: GalLonglineStopReason
  nodeId?: string
  relatedNodeId?: string
}

export interface GalLonglineRangeWarning {
  type: "broken_parent" | "broken_child" | "broken_choice" | "cycle" | "missing_selected_node"
  nodeId: string
  relatedNodeId?: string
  message: string
}

export interface GalLonglineRange {
  upstreamBoundary: GalNode | null
  targetNodes: GalNode[]
  downstreamBoundary: GalNode | null
  stopReasons: GalLonglineStop[]
  warnings: GalLonglineRangeWarning[]
}

interface RouteIndex {
  nodeById: Map<string, GalNode>
  incomingByNodeId: Map<string, Set<string>>
}

export function detectGalLonglineRange(route: GalRoute, selectedNodeId: string): GalLonglineRange {
  const index = buildRouteIndex(route)
  const selectedNode = index.nodeById.get(selectedNodeId)
  const warnings: GalLonglineRangeWarning[] = []
  const stopReasons: GalLonglineStop[] = []

  if (!selectedNode) {
    return {
      upstreamBoundary: null,
      targetNodes: [],
      downstreamBoundary: null,
      stopReasons: [{ direction: "upstream", reason: "missing_selected_node", nodeId: selectedNodeId }],
      warnings: [{
        type: "missing_selected_node",
        nodeId: selectedNodeId,
        message: `Selected node does not exist: ${selectedNodeId}`,
      }],
    }
  }

  const targetNodes = [selectedNode]
  const targetIds = new Set([selectedNode.id])

  const upstreamBoundary = walkUpstream(selectedNode, index, targetNodes, targetIds, stopReasons, warnings)
  const downstreamBoundary = walkDownstream(selectedNode, index, targetNodes, targetIds, stopReasons, warnings)

  return {
    upstreamBoundary,
    targetNodes,
    downstreamBoundary,
    stopReasons,
    warnings,
  }
}

function walkUpstream(
  selectedNode: GalNode,
  index: RouteIndex,
  targetNodes: GalNode[],
  targetIds: Set<string>,
  stopReasons: GalLonglineStop[],
  warnings: GalLonglineRangeWarning[],
): GalNode | null {
  let current = selectedNode

  while (true) {
    const currentKind = getNodeKind(current, index)
    if (currentKind === "entry") {
      stopReasons.push({ direction: "upstream", reason: "entry_node", nodeId: current.id })
      return null
    }
    if (currentKind === "ending") {
      stopReasons.push({ direction: "upstream", reason: "ending_node", nodeId: current.id })
      return null
    }
    if (currentKind === "branch") {
      stopReasons.push({ direction: "upstream", reason: "branch_node", nodeId: current.id })
      return null
    }
    if (currentKind === "merge") {
      stopReasons.push({ direction: "upstream", reason: "merge_node", nodeId: current.id })
      return null
    }

    const parentIds = getEffectiveParentIds(current, index, warnings)
    if (parentIds.length === 0) {
      const brokenParentId = getMissingParentIds(current, index)[0]
      stopReasons.push(brokenParentId
        ? { direction: "upstream", reason: "broken_link", nodeId: current.id, relatedNodeId: brokenParentId }
        : { direction: "upstream", reason: "dead_end", nodeId: current.id })
      return null
    }
    if (parentIds.length > 1) {
      stopReasons.push({ direction: "upstream", reason: "merge_node", nodeId: current.id })
      return null
    }

    const parentId = parentIds[0]
    const parent = index.nodeById.get(parentId)
    if (!parent) {
      stopReasons.push({ direction: "upstream", reason: "broken_link", nodeId: current.id, relatedNodeId: parentId })
      return null
    }
    if (targetIds.has(parent.id)) {
      warnings.push({
        type: "cycle",
        nodeId: current.id,
        relatedNodeId: parent.id,
        message: `Cycle detected while walking upstream: ${current.id} -> ${parent.id}`,
      })
      stopReasons.push({ direction: "upstream", reason: "cycle", nodeId: current.id, relatedNodeId: parent.id })
      return null
    }

    const parentKind = getNodeKind(parent, index)
    if (parentKind !== "linear") {
      stopReasons.push({
        direction: "upstream",
        reason: nodeKindToStopReason(parentKind),
        nodeId: current.id,
        relatedNodeId: parent.id,
      })
      return parent
    }

    targetNodes.unshift(parent)
    targetIds.add(parent.id)
    current = parent
  }
}

function walkDownstream(
  selectedNode: GalNode,
  index: RouteIndex,
  targetNodes: GalNode[],
  targetIds: Set<string>,
  stopReasons: GalLonglineStop[],
  warnings: GalLonglineRangeWarning[],
): GalNode | null {
  let current = selectedNode

  while (true) {
    const currentKind = getNodeKind(current, index)
    if (currentKind === "entry") {
      stopReasons.push({ direction: "downstream", reason: "entry_node", nodeId: current.id })
      return null
    }
    if (currentKind === "ending") {
      stopReasons.push({ direction: "downstream", reason: "ending_node", nodeId: current.id })
      return null
    }
    if (currentKind === "branch") {
      stopReasons.push({ direction: "downstream", reason: "branch_node", nodeId: current.id })
      return null
    }
    if (currentKind === "merge") {
      stopReasons.push({ direction: "downstream", reason: "merge_node", nodeId: current.id })
      return null
    }

    const outgoingIds = getEffectiveOutgoingIds(current, index, warnings)
    if (outgoingIds.length === 0) {
      const brokenOutgoingId = getMissingOutgoingIds(current, index)[0]
      stopReasons.push(brokenOutgoingId
        ? { direction: "downstream", reason: "broken_link", nodeId: current.id, relatedNodeId: brokenOutgoingId }
        : { direction: "downstream", reason: "dead_end", nodeId: current.id })
      return null
    }
    if (outgoingIds.length > 1) {
      stopReasons.push({ direction: "downstream", reason: "branch_node", nodeId: current.id })
      return null
    }

    const nextId = outgoingIds[0]
    const next = index.nodeById.get(nextId)
    if (!next) {
      stopReasons.push({ direction: "downstream", reason: "broken_link", nodeId: current.id, relatedNodeId: nextId })
      return null
    }
    if (targetIds.has(next.id)) {
      warnings.push({
        type: "cycle",
        nodeId: current.id,
        relatedNodeId: next.id,
        message: `Cycle detected while walking downstream: ${current.id} -> ${next.id}`,
      })
      stopReasons.push({ direction: "downstream", reason: "cycle", nodeId: current.id, relatedNodeId: next.id })
      return null
    }

    const nextKind = getNodeKind(next, index)
    if (nextKind !== "linear") {
      stopReasons.push({
        direction: "downstream",
        reason: nodeKindToStopReason(nextKind),
        nodeId: current.id,
        relatedNodeId: next.id,
      })
      return next
    }

    targetNodes.push(next)
    targetIds.add(next.id)
    current = next
  }
}

function buildRouteIndex(route: GalRoute): RouteIndex {
  const nodeById = new Map((route.nodes ?? []).map((node) => [node.id, node]))
  const incomingByNodeId = new Map<string, Set<string>>()

  for (const node of route.nodes ?? []) {
    if (!incomingByNodeId.has(node.id)) incomingByNodeId.set(node.id, new Set())
  }

  for (const node of route.nodes ?? []) {
    for (const parentId of node.parents ?? []) {
      if (nodeById.has(parentId) && parentId !== node.id) {
        incomingByNodeId.get(node.id)?.add(parentId)
      }
    }
    for (const outgoing of getNodeOutgoingTargets(node, nodeById)) {
      if (outgoing.targetId !== node.id) {
        const incoming = incomingByNodeId.get(outgoing.targetId) ?? new Set<string>()
        incoming.add(node.id)
        incomingByNodeId.set(outgoing.targetId, incoming)
      }
    }
  }

  return { nodeById, incomingByNodeId }
}

type NodeKind = "linear" | "entry" | "ending" | "branch" | "merge"

function getNodeKind(node: GalNode, index: RouteIndex): NodeKind {
  if (node.type === "entry") return "entry"
  if (node.type === "ending") return "ending"
  if (getEffectiveParentIds(node, index).length > 1) return "merge"
  if (getEffectiveOutgoingIds(node, index).length > 1 || getValidChoiceTargetCount(node, index) > 1) return "branch"
  return "linear"
}

function nodeKindToStopReason(kind: NodeKind): GalLonglineStopReason {
  if (kind === "entry") return "entry_node"
  if (kind === "ending") return "ending_node"
  if (kind === "branch") return "branch_node"
  if (kind === "merge") return "merge_node"
  return "dead_end"
}

function getEffectiveParentIds(
  node: GalNode,
  index: RouteIndex,
  warnings?: GalLonglineRangeWarning[],
): string[] {
  const ids = new Set(index.incomingByNodeId.get(node.id) ?? [])
  for (const parentId of node.parents ?? []) {
    if (index.nodeById.has(parentId) && parentId !== node.id) {
      ids.add(parentId)
    } else if (parentId && warnings) {
      warnings.push({
        type: "broken_parent",
        nodeId: node.id,
        relatedNodeId: parentId,
        message: `Node ${node.id} references missing parent: ${parentId}`,
      })
    }
  }
  return Array.from(ids)
}

function getMissingParentIds(node: GalNode, index: RouteIndex): string[] {
  return (node.parents ?? []).filter((parentId) => Boolean(parentId) && !index.nodeById.has(parentId))
}

function getEffectiveOutgoingIds(
  node: GalNode,
  index: RouteIndex,
  warnings?: GalLonglineRangeWarning[],
): string[] {
  const ids = new Set<string>()
  for (const outgoing of getNodeOutgoingTargets(node, index.nodeById)) {
    ids.add(outgoing.targetId)
  }
  for (const childId of node.children ?? []) {
    if (index.nodeById.has(childId) && childId !== node.id) {
      ids.add(childId)
    } else if (childId && warnings) {
      warnings.push({
        type: "broken_child",
        nodeId: node.id,
        relatedNodeId: childId,
        message: `Node ${node.id} references missing child: ${childId}`,
      })
    }
  }
  for (const choice of node.choices ?? []) {
    const targetId = choice.nextNodeId?.trim()
    if (targetId && !index.nodeById.has(targetId) && warnings) {
      warnings.push({
        type: "broken_choice",
        nodeId: node.id,
        relatedNodeId: targetId,
        message: `Choice ${choice.id} on node ${node.id} references missing node: ${targetId}`,
      })
    }
  }
  return Array.from(ids)
}

function getMissingOutgoingIds(node: GalNode, index: RouteIndex): string[] {
  return [
    ...(node.children ?? []),
    ...(node.choices ?? [])
      .map((choice) => choice.nextNodeId?.trim())
      .filter((targetId): targetId is string => Boolean(targetId)),
  ].filter((targetId) => !index.nodeById.has(targetId))
}

function getValidChoiceTargetCount(node: GalNode, index: RouteIndex): number {
  return (node.choices ?? [])
    .map((choice) => choice.nextNodeId?.trim())
    .filter((targetId): targetId is string => Boolean(targetId))
    .filter((targetId) => index.nodeById.has(targetId))
    .length
}
