import type {
  GalChoice,
  GalEffect,
  GalProject,
  GalStateSnapshot,
  GalVariable,
} from "./gal-types"

const BUILTIN_VARIABLE_ALIASES: Record<string, string> = {
  "亲密度": "intimacy",
  "親密度": "intimacy",
  "恋爱度": "love",
  "戀愛度": "love",
  "爱情度": "love",
  "愛情度": "love",
}

type GalValue = number | string | boolean

export function resolveGalVariableId(
  value: unknown,
  variables: readonly GalVariable[],
): string | null {
  if (typeof value !== "string") return null
  const candidate = value.trim()
  if (!candidate) return null

  const exactVariable = variables.find((variable) => variable.id === candidate)
  if (exactVariable) return exactVariable.id

  const namedVariable = variables.find((variable) => variable.name.trim() === candidate)
  if (namedVariable) return namedVariable.id

  const aliasId = BUILTIN_VARIABLE_ALIASES[candidate]
  return aliasId && variables.some((variable) => variable.id === aliasId)
    ? aliasId
    : null
}

export function sanitizeGalEffects(
  effects: unknown,
  variables: readonly GalVariable[],
): GalEffect[] {
  if (!Array.isArray(effects)) return []

  return effects.flatMap((effect) => {
    if (!isRecord(effect)) return []
    const variable = resolveGalVariableId(effect.variable, variables)
    if (!variable || (effect.op !== "set" && effect.op !== "add") || !isGalValue(effect.value)) {
      return []
    }
    return [{ variable, op: effect.op, value: effect.value }]
  })
}

export function sanitizeGalChoices(
  choices: readonly GalChoice[],
  variables: readonly GalVariable[],
): GalChoice[] {
  return choices.map((choice) => ({
    ...choice,
    condition: choice.condition ? [...choice.condition] : undefined,
    effects: sanitizeGalEffects(choice.effects, variables),
  }))
}

export function sanitizeGalProjectVariables(project: GalProject): GalProject {
  const variables = dedupeVariables(project.variables)

  return {
    ...project,
    variables,
    routes: project.routes.map((route) => ({
      ...route,
      variableDefaults: sanitizeVariableRecord(route.variableDefaults, variables),
      nodes: route.nodes.map((node) => ({
        ...node,
        incomingState: sanitizeStateSnapshot(node.incomingState, variables),
        outgoingState: node.outgoingState
          ? sanitizeStateSnapshot(node.outgoingState, variables)
          : undefined,
        choices: sanitizeGalChoices(node.choices, variables),
      })),
    })),
  }
}

function dedupeVariables(variables: readonly GalVariable[]): GalVariable[] {
  const seen = new Set<string>()
  return variables.filter((variable) => {
    const id = variable.id.trim()
    if (!id || seen.has(id)) return false
    seen.add(id)
    return true
  })
}

function sanitizeStateSnapshot(
  state: GalStateSnapshot,
  variables: readonly GalVariable[],
): GalStateSnapshot {
  return {
    ...state,
    variables: sanitizeVariableRecord(state.variables, variables) ?? {},
  }
}

function sanitizeVariableRecord(
  record: Record<string, GalValue> | undefined,
  variables: readonly GalVariable[],
): Record<string, GalValue> | undefined {
  if (!record) return undefined

  const result: Record<string, GalValue> = {}
  for (const variable of variables) {
    if (Object.prototype.hasOwnProperty.call(record, variable.id)) {
      result[variable.id] = record[variable.id]
    }
  }
  for (const [key, value] of Object.entries(record)) {
    const variableId = resolveGalVariableId(key, variables)
    if (variableId && !Object.prototype.hasOwnProperty.call(result, variableId)) {
      result[variableId] = value
    }
  }
  return result
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isGalValue(value: unknown): value is GalValue {
  return typeof value === "number"
    || typeof value === "string"
    || typeof value === "boolean"
}
