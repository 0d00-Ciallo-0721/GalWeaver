import type { ReasoningConfig } from "@/stores/wiki-store"

export function resolveUserVisibleReasoning(reasoning?: ReasoningConfig): ReasoningConfig {
  if (!reasoning || reasoning.mode === "auto") {
    return { mode: "high" }
  }
  return reasoning
}
