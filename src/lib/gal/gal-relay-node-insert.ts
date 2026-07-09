import type { GalChoice, GalNode, GalProject, GalRoute } from "./gal-types"

export interface GalRelayNodeDraft {
  title: string
  goal: string
  summary: string
  scene: string
  characters: string[]
  entryChoiceText: string
  entryChoiceIntent: string
  script: string
  status?: GalNode["status"]
  boardPosition?: GalNode["boardPosition"]
}

export interface InsertRelayNodeParams {
  project: GalProject
  routeId: string
  afterNodeId: string
  beforeNodeId: string
  draft: GalRelayNodeDraft
  now?: string
  nodeId?: string
  choiceId?: string
  requireNodeIdsAdjacency?: boolean
  requireSingleDirectConnection?: boolean
}

export interface InsertRelayNodeResult {
  route: GalRoute
  node: GalNode
  afterNode: GalNode
  beforeNode: GalNode
}

export function insertRelayNodeIntoProject(params: InsertRelayNodeParams): InsertRelayNodeResult {
  const route = params.project.routes.find((item) => item.id === params.routeId)
  const afterNode = route?.nodes.find((item) => item.id === params.afterNodeId)
  const beforeNode = route?.nodes.find((item) => item.id === params.beforeNodeId)
  if (!route || !afterNode || !beforeNode) {
    throw new Error("插入失败：前后节点不存在")
  }

  if (params.requireNodeIdsAdjacency !== false && !areAdjacentRouteNodeIds(route, afterNode.id, beforeNode.id)) {
    throw new Error("插入失败：前后节点不是当前长线中的相邻节点")
  }

  const outgoingTargets = getNodeLinkedTargetIds(afterNode)
  const hasDirectConnection = outgoingTargets.includes(beforeNode.id) && beforeNode.parents.includes(afterNode.id)
  if (!hasDirectConnection) {
    throw new Error("插入失败：前后节点当前不是直连关系")
  }
  if (params.requireSingleDirectConnection !== false) {
    if (outgoingTargets.length !== 1 || outgoingTargets[0] !== beforeNode.id || beforeNode.parents.length !== 1) {
      throw new Error("插入失败：前后节点当前不是单线直连关系")
    }
  }

  const now = params.now ?? new Date().toISOString()
  const relayId = params.nodeId ?? createUniqueRelayNodeId(route)
  const relayChoiceId = params.choiceId ?? `choice_relay_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
  const relayPosition = params.draft.boardPosition ?? midpointPosition(afterNode, beforeNode)
  const relaySequence = (afterNode.sequence ?? 0) + 1

  for (const node of route.nodes) {
    if ((node.sequence ?? 0) >= relaySequence) node.sequence = (node.sequence ?? 0) + 1
  }

  for (const choice of afterNode.choices ?? []) {
    if (choice.nextNodeId === beforeNode.id) {
      choice.nextNodeId = relayId
      choice.nextNodeTitle = params.draft.title
      choice.nextNodeGoal = params.draft.goal
    }
  }

  afterNode.children = replaceTarget(afterNode.children ?? [], beforeNode.id, relayId)
  beforeNode.parents = replaceTarget(beforeNode.parents ?? [], afterNode.id, relayId)
  afterNode.updatedAt = now
  beforeNode.updatedAt = now

  const relayNode: GalNode = {
    id: relayId,
    routeId: route.id,
    title: params.draft.title,
    type: "daily",
    status: params.draft.status ?? "draft",
    parents: [afterNode.id],
    children: [beforeNode.id],
    goal: params.draft.goal,
    summary: params.draft.summary,
    boardPosition: relayPosition,
    scriptPath: `nodes/${route.id}/${relayId}.md`,
    incomingState: cloneStateSnapshot(beforeNode.incomingState),
    choices: [createRelayChoice(relayChoiceId, params.draft, beforeNode)],
    memoryScope: "node",
    characters: params.draft.characters.length > 0
      ? params.draft.characters
      : Array.from(new Set([...(afterNode.characters ?? []), ...(beforeNode.characters ?? [])])),
    scene: params.draft.scene || beforeNode.scene || afterNode.scene,
    clueIds: [],
    sequence: relaySequence,
    createdAt: now,
    updatedAt: now,
  }

  route.nodes.push(relayNode)
  for (const pathRoute of params.project.routes) {
    if (!Array.isArray(pathRoute.nodeIds)) continue
    pathRoute.nodeIds = insertBetweenAdjacentIds(pathRoute.nodeIds, afterNode.id, beforeNode.id, relayId)
  }
  params.project.updatedAt = now

  return { route, node: relayNode, afterNode, beforeNode }
}

export function areAdjacentRouteNodeIds(route: GalRoute, afterNodeId: string, beforeNodeId: string): boolean {
  if (!Array.isArray(route.nodeIds) || route.nodeIds.length === 0) return true
  return route.nodeIds.some((nodeId, index) => nodeId === afterNodeId && route.nodeIds?.[index + 1] === beforeNodeId)
}

function insertBetweenAdjacentIds(nodeIds: string[], afterNodeId: string, beforeNodeId: string, relayId: string): string[] {
  const nextNodeIds: string[] = []
  for (let index = 0; index < nodeIds.length; index += 1) {
    const nodeId = nodeIds[index]
    nextNodeIds.push(nodeId)
    if (nodeId === afterNodeId && nodeIds[index + 1] === beforeNodeId) {
      nextNodeIds.push(relayId)
    }
  }
  return nextNodeIds
}

function replaceTarget(values: string[], oldValue: string, newValue: string): string[] {
  return Array.from(new Set(values.map((value) => value === oldValue ? newValue : value)))
}

function createRelayChoice(id: string, draft: GalRelayNodeDraft, beforeNode: GalNode): GalChoice {
  return {
    id,
    text: draft.entryChoiceText || "继续",
    emotionalIntent: draft.entryChoiceIntent || "自然承接后续剧情",
    effects: [],
    nextNodeId: beforeNode.id,
    nextNodeTitle: beforeNode.title,
    nextNodeGoal: beforeNode.goal,
  }
}

function getNodeLinkedTargetIds(node: GalNode): string[] {
  return Array.from(new Set([
    ...(node.children ?? []),
    ...(node.choices ?? [])
      .map((choice) => choice.nextNodeId)
      .filter((targetId): targetId is string => Boolean(targetId)),
  ]))
}

function createUniqueRelayNodeId(route: GalRoute): string {
  const existingIds = new Set((route.nodes ?? []).map((node) => node.id))
  let nodeId = ""
  do {
    nodeId = `node_relay_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  } while (existingIds.has(nodeId))
  return nodeId
}

function midpointPosition(afterNode: GalNode, beforeNode: GalNode): GalNode["boardPosition"] {
  if (!afterNode.boardPosition && !beforeNode.boardPosition) return undefined
  return {
    x: Math.round(((afterNode.boardPosition?.x ?? 0) + (beforeNode.boardPosition?.x ?? afterNode.boardPosition?.x ?? 0)) / 2),
    y: Math.round(((afterNode.boardPosition?.y ?? 0) + (beforeNode.boardPosition?.y ?? afterNode.boardPosition?.y ?? 0)) / 2),
  }
}

function cloneStateSnapshot(state: GalNode["incomingState"]): GalNode["incomingState"] {
  return {
    variables: { ...(state?.variables ?? {}) },
    characterCognition: Object.fromEntries(
      Object.entries(state?.characterCognition ?? {}).map(([character, cognition]) => [
        character,
        {
          knows: [...(cognition.knows ?? [])],
          doesNotKnow: [...(cognition.doesNotKnow ?? [])],
          readerKnowsButCharacterDoesNot: [...(cognition.readerKnowsButCharacterDoesNot ?? [])],
        },
      ]),
    ),
    acquiredClueIds: [...(state?.acquiredClueIds ?? [])],
    seenCgIds: [...(state?.seenCgIds ?? [])],
    visitedNodeIds: [...(state?.visitedNodeIds ?? [])],
    currentScene: state?.currentScene ?? "",
    characterMoods: { ...(state?.characterMoods ?? {}) },
  }
}
