type DirectoryPickerWindow = Window & {
  showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle>
}

export function isTauri(): boolean {
  if (typeof globalThis === "undefined") return false
  const candidate = globalThis as typeof globalThis & {
    isTauri?: unknown
    __TAURI_INTERNALS__?: unknown
  }
  return Boolean(candidate.isTauri || candidate.__TAURI_INTERNALS__)
}

export function supportsDirectoryPicker(): boolean {
  return typeof window !== "undefined" && typeof (window as DirectoryPickerWindow).showDirectoryPicker === "function"
}

export async function pickDirectory(): Promise<string | null> {
  if (isTauri()) {
    const { open } = await import("@tauri-apps/plugin-dialog")
    const selected = await open({
      directory: true,
      multiple: false,
      title: "选择文件夹",
    })
    return selected ?? null
  }

  if (supportsDirectoryPicker()) {
    try {
      const pickerWindow = window as DirectoryPickerWindow
      const handle = await pickerWindow.showDirectoryPicker?.()
      return handle?.name ?? null
    } catch (err) {
      if ((err as DOMException).name === "AbortError") {
        return null
      }
      throw err
    }
  }

  return window.prompt("请输入文件夹路径：")
}
