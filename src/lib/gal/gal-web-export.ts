import { getNodeOutgoingTargets } from "./gal-graph-normalize"
import { loadNodeScript } from "./gal-storage"
import { resolveGalVariableId } from "./gal-variable-guard"
import type { GalNode, GalProject, GalRoute, GalVariable } from "./gal-types"

export interface StoryBundle {
  schemaVersion: 1
  contentVersion: string
  storyId: string
  title: string
  exportedAt: string
  entryNodeId: string
  variables: VariableDefinition[]
  characters: CharacterDefinition[]
  routes: StoryRoute[]
  nodes: StoryNode[]
  nodeAliases?: Record<string, string>
}

export interface VariableDefinition {
  id: string
  name: string
  type: "number" | "boolean" | "string"
  initialValue: number | boolean | string
  min?: number
  max?: number
  description?: string
}

export interface CharacterDefinition {
  id: string
  name: string
}

export interface StoryRoute {
  id: string
  title: string
  kind: "graph" | "saved-path"
  entryNodeId?: string
  endingNodeIds?: string[]
  nodeIds?: string[]
}

export interface StoryNode {
  id: string
  routeId: string
  title: string
  type: "entry" | "normal" | "ending"
  status: "ready" | "missing-script"
  scene?: {
    key?: string
    description?: string
  }
  characterIds: string[]
  script: ScriptBlock[]
  choices: StoryChoice[]
  nextNodeId?: string
  endingId?: string
  meta?: {
    summary?: string
    goal?: string
    tags?: string[]
  }
}

export type ScriptBlock =
  | {
      id: string
      type: "scene"
      text: string
    }
  | {
      id: string
      type: "dialogue"
      speakerId: string
      text: string
    }
  | {
      id: string
      type: "thought"
      speakerId: string
      text: string
    }
  | {
      id: string
      type: "action"
      text: string
    }
  | {
      id: string
      type: "narration"
      text: string
    }

export type KnownCharacter = CharacterDefinition | string

export interface ScriptParseResult {
  blocks: ScriptBlock[]
  warnings: ExportReport["warnings"]
  characters: CharacterDefinition[]
}

export interface StoryBundleBuildResult {
  bundle: StoryBundle
  report: ExportReport
}

export interface StoryChoice {
  id: string
  text: string
  targetNodeId: string
  effects?: Array<{
    variableId: string
    op: "add" | "set"
    value: number | boolean | string
  }>
  visibleWhen?: Condition
  enabledWhen?: Condition
}

export interface Condition {
  variableId: string
  op: "eq" | "ne" | "gt" | "gte" | "lt" | "lte"
  value: number | boolean | string
}

export interface AssetSlotsTemplate {
  schemaVersion: 1
  storyId: string
  nodes: Array<{
    nodeId: string
    title: string
    sceneDescription?: string
    characterIds: string[]
    backgroundId: null
    cgId: null
    characterSprites: Array<{
      characterId: string
      spriteId: null
      position: null
    }>
  }>
}

export interface ExportReport {
  schemaVersion: 1
  exportedAt: string
  stats: {
    routes: number
    nodes: number
    scriptsReady: number
    scriptsMissing: number
    choices: number
    endings: number
  }
  errors: Array<{
    code: string
    message: string
    nodeId?: string
    routeId?: string
  }>
  warnings: Array<{
    code: string
    message: string
    nodeId?: string
    line?: number
  }>
}

export function createEmptyExportReport(exportedAt: string): ExportReport {
  return {
    schemaVersion: 1,
    exportedAt,
    stats: {
      routes: 0,
      nodes: 0,
      scriptsReady: 0,
      scriptsMissing: 0,
      choices: 0,
      endings: 0,
    },
    errors: [],
    warnings: [],
  }
}

export function normalizeVariableDefinitions(project: Pick<GalProject, "variables">): VariableDefinition[] {
  return (project.variables ?? []).map((variable) => normalizeVariableDefinition(variable))
}

export function collectGraphRoutes(project: Pick<GalProject, "routes">): GalRoute[] {
  return (project.routes ?? []).filter((route) => !Array.isArray(route.nodeIds))
}

export function collectSavedPathRoutes(project: Pick<GalProject, "routes">): GalRoute[] {
  return (project.routes ?? []).filter((route) => Array.isArray(route.nodeIds))
}

export function normalizeStoryRoutes(project: Pick<GalProject, "routes">): StoryRoute[] {
  return [
    ...collectGraphRoutes(project).map((route) => normalizeGraphStoryRoute(route)),
    ...collectSavedPathRoutes(project).map((route) => normalizeSavedPathStoryRoute(route)),
  ]
}

export function collectKnownCharacters(project: Pick<GalProject, "routes"> & { characters?: KnownCharacter[] }): CharacterDefinition[] {
  const charactersByName = new Map<string, CharacterDefinition>()
  for (const character of project.characters ?? []) {
    addKnownCharacter(charactersByName, character)
  }

  for (const route of project.routes ?? []) {
    for (const node of route.nodes ?? []) {
      for (const character of node.characters ?? []) {
        addKnownCharacter(charactersByName, character)
      }
    }
  }

  return [...charactersByName.values()]
}

export function parseScriptBlocks(
  nodeId: string,
  rawScript: string,
  knownCharacters: KnownCharacter[] = [],
): ScriptParseResult {
  const blocks: ScriptBlock[] = []
  const warnings: ExportReport["warnings"] = []
  const charactersByName = buildCharacterMap(knownCharacters)
  const usedCharactersById = new Map<string, CharacterDefinition>()
  const lines = rawScript.split(/\r?\n/)

  for (const [lineIndex, rawLine] of lines.entries()) {
    const text = rawLine.trim()
    if (!text) continue
    if (text === "【选择】" || text.startsWith("【选择】")) break

    const blockId = `${nodeId}:block:${blocks.length}`
    const lineNumber = lineIndex + 1
    const sceneMatch = text.match(/^【场景[：:](.+)】$/)
    if (sceneMatch) {
      blocks.push({ id: blockId, type: "scene", text: sceneMatch[1].trim() })
      continue
    }

    const thoughtMatch = text.match(/^([^：:]+)[：:]\s*（内心）\s*(.*)$/)
    if (thoughtMatch) {
      const speaker = resolveSpeaker(nodeId, thoughtMatch[1].trim(), charactersByName, warnings, lineNumber)
      usedCharactersById.set(speaker.id, speaker)
      blocks.push({
        id: blockId,
        type: "thought",
        speakerId: speaker.id,
        text: thoughtMatch[2].trim(),
      })
      continue
    }

    const dialogueMatch = text.match(/^([^：:]+)[：:]\s*(.+)$/)
    if (dialogueMatch) {
      const speaker = resolveSpeaker(nodeId, dialogueMatch[1].trim(), charactersByName, warnings, lineNumber)
      usedCharactersById.set(speaker.id, speaker)
      blocks.push({
        id: blockId,
        type: "dialogue",
        speakerId: speaker.id,
        text: dialogueMatch[2].trim(),
      })
      continue
    }

    const actionMatch = text.match(/^（(.+)）$/)
    if (actionMatch) {
      blocks.push({ id: blockId, type: "action", text: actionMatch[1].trim() })
      continue
    }

    blocks.push({ id: blockId, type: "narration", text })
    warnings.push({
      code: "SCRIPT_LINE_FALLBACK",
      message: "正文行未匹配到结构化格式，已按旁白保留。",
      nodeId,
      line: lineNumber,
    })
  }

  return { blocks, warnings, characters: [...usedCharactersById.values()] }
}

export function buildStoryNode(
  node: GalNode,
  route: GalRoute,
  nodeById: Map<string, GalNode>,
  script: string,
  variables: readonly GalVariable[],
  report: ExportReport,
  knownCharacters: KnownCharacter[] = collectKnownCharacters({ routes: [route] }),
): StoryNode {
  const parsedScript = parseScriptBlocks(node.id, script, knownCharacters)
  const knownCharacterDefinitions = normalizeKnownCharacterDefinitions(knownCharacters)
  report.warnings.push(...parsedScript.warnings)

  const type = mapStoryNodeType(node, route)
  const choices = (node.choices ?? []).map((choice, index) =>
    buildStoryChoice(node.id, choice, index, nodeById, variables, report),
  )
  const outgoingTargets = getNodeOutgoingTargets(node, nodeById)
  const hasChoices = choices.length > 0
  const storyNode: StoryNode = {
    id: node.id,
    routeId: route.id,
    title: node.title,
    type,
    status: script.trim() ? "ready" : "missing-script",
    ...(node.scene?.trim()
      ? { scene: { description: node.scene.trim() } }
      : {}),
    characterIds: collectNodeCharacterIds(node, knownCharacterDefinitions),
    script: parsedScript.blocks,
    choices,
    ...(type === "ending" ? { endingId: node.id } : {}),
    meta: {
      ...(node.summary?.trim() ? { summary: node.summary.trim() } : {}),
      ...(node.goal?.trim() ? { goal: node.goal.trim() } : {}),
      ...(node.clueIds?.length ? { tags: [...node.clueIds] } : {}),
    },
  }

  if (type === "ending" && outgoingTargets.length > 0) {
    report.warnings.push({
      code: "ENDING_NODE_HAS_OUTGOING",
      message: `Ending node ${node.id} has outgoing targets.`,
      nodeId: node.id,
    })
  }

  if (hasChoices) return storyNode

  const children = [...(node.children ?? [])].filter(Boolean)
  if (children.length === 0) {
    if (type !== "ending") {
      report.warnings.push({
        code: "NON_ENDING_NODE_HAS_NO_OUTGOING",
        message: `Non-ending node ${node.id} has no choices or children.`,
        nodeId: node.id,
      })
    }
    return storyNode
  }

  if (children.length > 1) {
    report.errors.push({
      code: "AMBIGUOUS_LINEAR_CHILDREN",
      message: `Node ${node.id} has multiple children but no choices.`,
      nodeId: node.id,
      routeId: route.id,
    })
    return storyNode
  }

  const nextNodeId = children[0]
  storyNode.nextNodeId = nextNodeId
  if (!nodeById.has(nextNodeId)) {
    report.errors.push({
      code: "INVALID_NEXT_NODE",
      message: `Node ${node.id} points to missing child ${nextNodeId}.`,
      nodeId: node.id,
      routeId: route.id,
    })
  }
  return storyNode
}

export async function buildStoryBundle(
  projectPath: string,
  project: GalProject,
  exportedAt = new Date().toISOString(),
): Promise<StoryBundleBuildResult> {
  const report = createEmptyExportReport(exportedAt)
  const graphRoutes = collectGraphRoutes(project)
  const storyRoutes = normalizeStoryRoutes(project)
  const scriptsByNode = new Map<string, string>()
  const charactersByName = new Map<string, CharacterDefinition>()

  for (const character of collectKnownCharacters({ ...project, routes: graphRoutes })) {
    addKnownCharacter(charactersByName, character)
  }

  for (const route of graphRoutes) {
    for (const node of route.nodes ?? []) {
      const script = (await loadNodeScript(projectPath, route.id, node.id)) ?? ""
      scriptsByNode.set(makeRouteNodeKey(route.id, node.id), script)

      const parsed = parseScriptBlocks(node.id, script, [...charactersByName.values()])
      for (const character of parsed.characters) {
        addKnownCharacter(charactersByName, character)
      }
      report.warnings.push(...parsed.warnings.filter((warning) => warning.code === "SCRIPT_UNKNOWN_CHARACTER"))
    }
  }

  const characters = [...charactersByName.values()]
  const storyNodes: StoryNode[] = []
  for (const route of graphRoutes) {
    const nodeById = new Map((route.nodes ?? []).map((node) => [node.id, node]))
    for (const node of route.nodes ?? []) {
      storyNodes.push(buildStoryNode(
        node,
        route,
        nodeById,
        scriptsByNode.get(makeRouteNodeKey(route.id, node.id)) ?? "",
        project.variables ?? [],
        report,
        characters,
      ))
    }
  }

  report.stats = {
    routes: storyRoutes.length,
    nodes: storyNodes.length,
    scriptsReady: storyNodes.filter((node) => node.status === "ready").length,
    scriptsMissing: storyNodes.filter((node) => node.status === "missing-script").length,
    choices: storyNodes.reduce((count, node) => count + node.choices.length, 0),
    endings: storyNodes.filter((node) => node.type === "ending").length,
  }

  const mainGraphRoute = graphRoutes.find((route) => route.id === "main") ?? graphRoutes[0]
  const bundle: StoryBundle = {
    schemaVersion: 1,
    contentVersion: project.updatedAt || exportedAt,
    storyId: project.id,
    title: project.title,
    exportedAt,
    entryNodeId: mainGraphRoute?.entryNodeId ?? "",
    variables: normalizeVariableDefinitions(project),
    characters,
    routes: storyRoutes,
    nodes: storyNodes,
  }

  validateStoryBundle(project, graphRoutes, bundle, report)
  return { bundle, report }
}

export function buildAssetSlotsTemplate(bundle: Pick<StoryBundle, "storyId" | "nodes">): AssetSlotsTemplate {
  return {
    schemaVersion: 1,
    storyId: bundle.storyId,
    nodes: bundle.nodes.map((node) => ({
      nodeId: node.id,
      title: node.title,
      ...(node.scene?.description ? { sceneDescription: node.scene.description } : {}),
      characterIds: [...node.characterIds],
      backgroundId: null,
      cgId: null,
      characterSprites: node.characterIds.map((characterId) => ({
        characterId,
        spriteId: null,
        position: null,
      })),
    })),
  }
}

function validateStoryBundle(
  project: GalProject,
  graphRoutes: GalRoute[],
  bundle: StoryBundle,
  report: ExportReport,
): void {
  reportDuplicateIds((project.routes ?? []).map((route) => route.id), "DUPLICATE_ROUTE_ID", "route", report)
  reportDuplicateIds((project.variables ?? []).map((variable) => variable.id), "DUPLICATE_VARIABLE_ID", "variable", report)
  reportDuplicateIds(bundle.nodes.map((node) => node.id), "DUPLICATE_NODE_ID", "node", report)
  reportDuplicateIds(bundle.characters.map((character) => character.id), "DUPLICATE_CHARACTER_ID", "character", report)

  const nodeIds = new Set(bundle.nodes.map((node) => node.id))
  const variableIds = new Set(bundle.variables.map((variable) => variable.id))
  const sourceNodesByKey = new Map<string, GalNode>()
  for (const route of graphRoutes) {
    for (const node of route.nodes ?? []) {
      sourceNodesByKey.set(makeRouteNodeKey(route.id, node.id), node)
      if (!nodeIds.has(node.id)) {
        pushReportError(report, {
          code: "GRAPH_NODE_MISSING_FROM_BUNDLE",
          message: `Graph route ${route.id} node ${node.id} was not included in the story bundle.`,
          nodeId: node.id,
          routeId: route.id,
        })
      }
    }
  }

  if (!bundle.entryNodeId || !nodeIds.has(bundle.entryNodeId)) {
    pushReportError(report, {
      code: "MISSING_ENTRY_NODE",
      message: `Entry node ${bundle.entryNodeId || "(empty)"} does not exist in the story bundle.`,
      nodeId: bundle.entryNodeId || undefined,
    })
  }

  for (const node of bundle.nodes) {
    reportDuplicateChoiceIds(node, report)
    validateStoryNodeLinks(node, nodeIds, variableIds, report)

    if (node.status === "missing-script") {
      pushReportWarning(report, {
        code: "SCRIPT_MISSING",
        message: `Node ${node.id} has no script content.`,
        nodeId: node.id,
      })
    }

    const sourceNode = sourceNodesByKey.get(makeRouteNodeKey(node.routeId, node.id))
    if (sourceNode) validateChoiceChildrenConsistency(sourceNode, node.routeId, report)
  }
}

function reportDuplicateIds(
  ids: string[],
  code: string,
  label: string,
  report: ExportReport,
): void {
  const seen = new Set<string>()
  const reported = new Set<string>()
  for (const id of ids) {
    if (!id || !seen.has(id)) {
      if (id) seen.add(id)
      continue
    }
    if (reported.has(id)) continue
    reported.add(id)
    pushReportError(report, {
      code,
      message: `Duplicate ${label} id ${id}.`,
    })
  }
}

function reportDuplicateChoiceIds(node: StoryNode, report: ExportReport): void {
  const seen = new Set<string>()
  const reported = new Set<string>()
  for (const choice of node.choices) {
    if (!seen.has(choice.id)) {
      seen.add(choice.id)
      continue
    }
    if (reported.has(choice.id)) continue
    reported.add(choice.id)
    pushReportError(report, {
      code: "DUPLICATE_CHOICE_ID",
      message: `Node ${node.id} has duplicate choice id ${choice.id}.`,
      nodeId: node.id,
      routeId: node.routeId,
    })
  }
}

function validateStoryNodeLinks(
  node: StoryNode,
  nodeIds: Set<string>,
  variableIds: Set<string>,
  report: ExportReport,
): void {
  if (node.nextNodeId && !nodeIds.has(node.nextNodeId)) {
    pushReportError(report, {
      code: "INVALID_NEXT_NODE",
      message: `Node ${node.id} points to missing child ${node.nextNodeId}.`,
      nodeId: node.id,
      routeId: node.routeId,
    })
  }

  for (const choice of node.choices) {
    if (!choice.targetNodeId) {
      pushReportError(report, {
        code: "INVALID_CHOICE_TARGET",
        message: `Choice ${choice.id} on node ${node.id} has no targetNodeId.`,
        nodeId: node.id,
      })
    } else if (!nodeIds.has(choice.targetNodeId)) {
      pushReportError(report, {
        code: "INVALID_CHOICE_TARGET",
        message: `Choice ${choice.id} on node ${node.id} points to missing node ${choice.targetNodeId}.`,
        nodeId: node.id,
      })
    }

    for (const effect of choice.effects ?? []) {
      if (!variableIds.has(effect.variableId)) {
        pushReportError(report, {
          code: "INVALID_VARIABLE_REF",
          message: `Choice ${choice.id} on node ${node.id} references missing variable ${effect.variableId}.`,
          nodeId: node.id,
        })
      }
    }
  }
}

function validateChoiceChildrenConsistency(node: GalNode, routeId: string, report: ExportReport): void {
  const choiceTargets = new Set((node.choices ?? [])
    .map((choice) => choice.nextNodeId?.trim())
    .filter((target): target is string => Boolean(target)))
  const childTargets = new Set((node.children ?? [])
    .map((child) => child.trim())
    .filter((target): target is string => Boolean(target)))
  if (choiceTargets.size === 0 || childTargets.size === 0) return

  if (!setEquals(choiceTargets, childTargets)) {
    pushReportWarning(report, {
      code: "CHOICES_CHILDREN_CONFLICT",
      message: `Node ${node.id} has choices and children pointing to different targets.`,
      nodeId: node.id,
    })
    if (routeId) {
      pushReportError(report, {
        code: "CHOICES_CHILDREN_CONFLICT",
        message: `Route ${routeId} node ${node.id} has conflicting choices and children.`,
        nodeId: node.id,
        routeId,
      })
    }
  }
}

function setEquals(left: Set<string>, right: Set<string>): boolean {
  if (left.size !== right.size) return false
  for (const value of left) {
    if (!right.has(value)) return false
  }
  return true
}

function pushReportError(report: ExportReport, error: ExportReport["errors"][number]): void {
  if (report.errors.some((item) => (
    item.code === error.code
    && item.message === error.message
    && item.nodeId === error.nodeId
    && item.routeId === error.routeId
  ))) return
  report.errors.push(error)
}

function pushReportWarning(report: ExportReport, warning: ExportReport["warnings"][number]): void {
  if (report.warnings.some((item) => (
    item.code === warning.code
    && item.message === warning.message
    && item.nodeId === warning.nodeId
    && item.line === warning.line
  ))) return
  report.warnings.push(warning)
}

function normalizeVariableDefinition(variable: GalVariable): VariableDefinition {
  const type = inferVariableType(variable)
  return {
    id: variable.id,
    name: variable.name,
    type,
    initialValue: normalizeInitialValue(variable.defaultValue, type),
    ...(typeof variable.min === "number" ? { min: variable.min } : {}),
    ...(typeof variable.max === "number" ? { max: variable.max } : {}),
    ...(variable.description ? { description: variable.description } : {}),
  }
}

function inferVariableType(variable: GalVariable): VariableDefinition["type"] {
  if (typeof variable.defaultValue === "boolean") return "boolean"
  if (typeof variable.defaultValue === "number") return "number"
  if (variable.type === "flag") return "boolean"
  if (variable.type === "intimacy" || variable.type === "love") return "number"
  return "string"
}

function normalizeInitialValue(
  value: GalVariable["defaultValue"],
  type: VariableDefinition["type"],
): VariableDefinition["initialValue"] {
  if (type === "boolean") return typeof value === "boolean" ? value : Boolean(value)
  if (type === "number") return typeof value === "number" ? value : 0
  return typeof value === "string" ? value : String(value)
}

function normalizeGraphStoryRoute(route: GalRoute): StoryRoute {
  return {
    id: route.id,
    title: route.title,
    kind: "graph",
    entryNodeId: route.entryNodeId,
    endingNodeIds: [...(route.endingNodeIds ?? [])],
  }
}

function normalizeSavedPathStoryRoute(route: GalRoute): StoryRoute {
  return {
    id: route.id,
    title: route.title,
    kind: "saved-path",
    entryNodeId: route.entryNodeId,
    endingNodeIds: [...(route.endingNodeIds ?? [])],
    nodeIds: [...(route.nodeIds ?? [])],
  }
}

function makeRouteNodeKey(routeId: string, nodeId: string): string {
  return `${routeId}:${nodeId}`
}

function mapStoryNodeType(node: GalNode, route: GalRoute): StoryNode["type"] {
  if (node.type === "entry") return "entry"
  if (node.type === "ending" || (route.endingNodeIds ?? []).includes(node.id)) return "ending"
  return "normal"
}

function collectNodeCharacterIds(node: GalNode, knownCharacters: CharacterDefinition[]): string[] {
  const idsByName = new Map(knownCharacters.map((character) => [character.name, character.id]))
  return Array.from(new Set(
    (node.characters ?? [])
      .map((name) => name.trim())
      .filter(Boolean)
      .map((name) => idsByName.get(name) ?? makeStableCharacterId(name)),
  ))
}

function buildStoryChoice(
  nodeId: string,
  choice: GalNode["choices"][number],
  index: number,
  nodeById: Map<string, GalNode>,
  variables: readonly GalVariable[],
  report: ExportReport,
): StoryChoice {
  const id = choice.id?.trim() || `${nodeId}:choice:${index}`
  const targetNodeId = choice.nextNodeId?.trim() ?? ""
  if (!targetNodeId) {
    report.errors.push({
      code: "INVALID_CHOICE_TARGET",
      message: `Choice ${id} on node ${nodeId} has no targetNodeId.`,
      nodeId,
    })
  } else if (!nodeById.has(targetNodeId)) {
    report.errors.push({
      code: "INVALID_CHOICE_TARGET",
      message: `Choice ${id} on node ${nodeId} points to missing node ${targetNodeId}.`,
      nodeId,
    })
  }

  const effects = mapStoryChoiceEffects(nodeId, id, choice.effects ?? [], variables, report)
  return {
    id,
    text: choice.text,
    targetNodeId,
    ...(effects.length ? { effects } : {}),
  }
}

function mapStoryChoiceEffects(
  nodeId: string,
  choiceId: string,
  effects: GalNode["choices"][number]["effects"],
  variables: readonly GalVariable[],
  report: ExportReport,
): NonNullable<StoryChoice["effects"]> {
  const storyEffects: NonNullable<StoryChoice["effects"]> = []
  for (const effect of effects ?? []) {
    const variableId = resolveGalVariableId(effect.variable, variables)
    if (!variableId) {
      report.errors.push({
        code: "INVALID_VARIABLE_REF",
        message: `Choice ${choiceId} on node ${nodeId} references missing variable ${effect.variable}.`,
        nodeId,
      })
      continue
    }
    storyEffects.push({
      variableId,
      op: effect.op,
      value: effect.value,
    })
  }
  return storyEffects
}

function buildCharacterMap(knownCharacters: KnownCharacter[]): Map<string, CharacterDefinition> {
  const charactersByName = new Map<string, CharacterDefinition>()
  for (const character of knownCharacters) {
    if (typeof character === "string") {
      const name = character.trim()
      if (name) charactersByName.set(name, { id: makeStableCharacterId(name), name })
      continue
    }

    const name = character.name.trim()
    const id = character.id.trim()
    if (name && id) charactersByName.set(name, { id, name })
  }
  return charactersByName
}

function normalizeKnownCharacterDefinitions(knownCharacters: KnownCharacter[]): CharacterDefinition[] {
  return [...buildCharacterMap(knownCharacters).values()]
}

function addKnownCharacter(charactersByName: Map<string, CharacterDefinition>, character: KnownCharacter): void {
  if (typeof character === "string") {
    const name = character.trim()
    if (name && !charactersByName.has(name)) charactersByName.set(name, { id: makeStableCharacterId(name), name })
    return
  }

  const name = character.name.trim()
  const id = character.id.trim()
  if (name && id && !charactersByName.has(name)) charactersByName.set(name, { id, name })
}

function resolveSpeaker(
  nodeId: string,
  speakerName: string,
  charactersByName: Map<string, CharacterDefinition>,
  warnings: ExportReport["warnings"],
  line: number,
): CharacterDefinition {
  const known = charactersByName.get(speakerName)
  if (known) return known

  warnings.push({
    code: "SCRIPT_UNKNOWN_CHARACTER",
    message: `正文中出现未注册角色「${speakerName}」，已生成稳定角色 ID。`,
    nodeId,
    line,
  })
  return { id: makeStableCharacterId(speakerName), name: speakerName }
}

function makeStableCharacterId(name: string): string {
  let hash = 0
  for (let index = 0; index < name.length; index++) {
    hash = (hash * 31 + name.charCodeAt(index)) >>> 0
  }
  return `character_${hash.toString(36)}`
}
