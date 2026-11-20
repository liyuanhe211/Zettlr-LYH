export const RECENT_FILES_MENU_LIMIT = 10
export const RECENT_FILES_HISTORY_LIMIT = 1000
export const RECENT_FILES_CHANNEL = 'recent-files-window'
export const RECENT_FILES_UPDATED_CHANNEL = 'recent-files-updated'

export interface RecentFilesSnapshot {
  paths: string[]
}

export type RecentFilesRequest =
  | { command: 'get-history' }
  | { command: 'open-file', payload: { path: string } }
  | { command: 'clear-history' }

export interface RecentFilesClearResult {
  cleared: boolean
}

export interface RecentFilesOpenResult {
  success: boolean
  error?: string
}
