import type { GalProject, GalRoute, GalVariable } from "./gal-types"

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
      blocks.push({
        id: blockId,
        type: "thought",
        speakerId: resolveSpeakerId(nodeId, thoughtMatch[1].trim(), charactersByName, warnings, lineNumber),
        text: thoughtMatch[2].trim(),
      })
      continue
    }

    const dialogueMatch = text.match(/^([^：:]+)[：:]\s*(.+)$/)
    if (dialogueMatch) {
      blocks.push({
        id: blockId,
        type: "dialogue",
        speakerId: resolveSpeakerId(nodeId, dialogueMatch[1].trim(), charactersByName, warnings, lineNumber),
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
      code: "SCRIPT_LINE_FALLBACK_NARRATION",
      message: "正文行未匹配到结构化格式，已按旁白保留。",
      nodeId,
      line: lineNumber,
    })
  }

  return { blocks, warnings }
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

function buildCharacterMap(knownCharacters: KnownCharacter[]): Map<string, string> {
  const charactersByName = new Map<string, string>()
  for (const character of knownCharacters) {
    if (typeof character === "string") {
      const name = character.trim()
      if (name) charactersByName.set(name, makeStableCharacterId(name))
      continue
    }

    const name = character.name.trim()
    const id = character.id.trim()
    if (name && id) charactersByName.set(name, id)
  }
  return charactersByName
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

function resolveSpeakerId(
  nodeId: string,
  speakerName: string,
  charactersByName: Map<string, string>,
  warnings: ExportReport["warnings"],
  line: number,
): string {
  const knownId = charactersByName.get(speakerName)
  if (knownId) return knownId

  warnings.push({
    code: "SCRIPT_UNKNOWN_CHARACTER",
    message: `正文中出现未注册角色「${speakerName}」，已生成稳定角色 ID。`,
    nodeId,
    line,
  })
  return makeStableCharacterId(speakerName)
}

function makeStableCharacterId(name: string): string {
  let hash = 0
  for (let index = 0; index < name.length; index++) {
    hash = (hash * 31 + name.charCodeAt(index)) >>> 0
  }
  return `character_${hash.toString(36)}`
}
