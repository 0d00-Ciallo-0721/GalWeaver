import { useReviewStore } from "@/stores/review-store"
import { useChatStore } from "@/stores/chat-store"
import { useWikiStore } from "@/stores/wiki-store"
import { saveReviewItems, saveChatHistory } from "./persist"
import { isTauri } from "@/lib/platform"

let reviewTimer: ReturnType<typeof setTimeout> | null = null
let chatTimer: ReturnType<typeof setTimeout> | null = null

export function setupAutoSave(): void {
  useReviewStore.subscribe((state) => {
    if (reviewTimer) clearTimeout(reviewTimer)
    reviewTimer = setTimeout(() => {
      const project = useWikiStore.getState().project
      if (project && isTauri()) {
        saveReviewItems(project.path, state.items).catch(() => {})
      }
    }, 1000)
  })

  useChatStore.subscribe((state) => {
    if (Object.keys(state.streamingContents).length > 0) return
    if (chatTimer) clearTimeout(chatTimer)
    chatTimer = setTimeout(() => {
      const project = useWikiStore.getState().project
      if (project && isTauri()) {
        saveChatHistory(project.path, state.conversations, state.messages).catch(() => {})
      }
    }, 2000)
  })
}
