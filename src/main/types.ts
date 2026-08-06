export type ComfyPhase = 'starting' | 'ready' | 'stopped' | 'error'

export interface ComfyStatus {
  phase: ComfyPhase
  message: string
  managed: boolean
}

export interface SystemResources {
  cpuUsage: number
  ramUsed: number
  ramTotal: number
  gpuUsage: number | null
  vramUsed: number | null
  vramTotal: number | null
}

export interface ImageAsset {
  path: string
  name: string
  dataUrl: string
  width: number
  height: number
}

export interface GenerateSettings {
  width: number
  height: number
  seed: number
  steps: number
  cfg: number
}

export interface GenerateRequest {
  nodeId: string
  sessionId: string
  prompt: string
  imagePaths: Array<string | null>
  imageSourceNodeIds: Array<string | null>
  settings: GenerateSettings
}

export interface GenerationStartedEvent {
  sessionId: string
  nodeId: string
  startedAtMs: number
}

export interface GeneratedImage extends ImageAsset {
  promptId: string
  seed: number
}
export interface CopiedSessionAsset {
  sourcePath: string
  destinationPath: string
}

export interface LibraryInfo {
  rootPath: string
  name: string
}

export interface SessionRecord {
  id: string
  name: string
  createdAt: string
  updatedAt: string
}

export interface SessionSnapshot {
  nodes: unknown[]
  edges: unknown[]
}

export interface LibraryBootstrap {
  library: LibraryInfo
  sessions: SessionRecord[]
  activeSession: SessionRecord
  snapshot: SessionSnapshot
}
