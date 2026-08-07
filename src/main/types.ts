export type ComfyPhase = 'starting' | 'ready' | 'stopping' | 'stopped' | 'error'

export interface ComfyStatus {
  phase: ComfyPhase
  message: string
  managed: boolean
}

export type LlmPhase = 'loading' | 'ready' | 'unloading' | 'stopped' | 'error'

export const DEFAULT_IMAGE_DESCRIBE_SYSTEM_PROMPT = `You are an expert image captioner for image-generation workflows. Describe only what is visibly present in the image as one detailed English image-generation prompt. Include the subject, appearance, pose, composition, environment, lighting, colors, camera perspective, and visual style when they are visible. Do not invent hidden facts. Return only the prompt without headings, commentary, or quotation marks.`

export interface LlmModelOption {
  path: string
  name: string
  sizeBytes: number
  mmprojPath: string | null
}

export interface LlmConfig {
  selectedModelPath: string
  contextLength: number
  temperature: number
  maxTokens: number
  idleUnloadMinutes: number
  gpuLayers: number
  flashAttention: boolean
  mmprojOffload: boolean
}

export interface LlmStatus {
  phase: LlmPhase
  message: string
  managed: boolean
  models: LlmModelOption[]
  config: LlmConfig
  loadedModelPath: string | null
  serverPath: string | null
  activePort: number | null
  restartRequired: boolean
}

export interface ImageDescribeRequest {
  descriptionId: string
  sessionId: string
  nodeId: string
  imagePath: string
  systemPrompt: string
}

export interface ImageDescribeStreamEvent {
  descriptionId: string
  sessionId: string
  nodeId: string
  content: string
}

export interface ImageDescribeErrorEvent {
  descriptionId: string
  sessionId: string
  nodeId: string
  message: string
  canceled: boolean
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
  transient?: boolean
}

export interface BatchFolderSelection {
  path: string
  name: string
  imageCount: number
}

export interface BatchInputFile {
  path: string
  name: string
  width: number
  height: number
}

export interface BatchPreparation {
  inputDirectory: string
  outputDirectory: string
  files: BatchInputFile[]
}

export interface BatchManifestItem {
  inputPath: string
  outputPath: string | null
  seed: number
  settings: GenerateSettings
  error: string | null
}

export interface BatchManifest {
  createdAt: string
  inputDirectory: string
  outputDirectory: string
  prompt: string
  settings: GenerateSettings
  matchInputSize: boolean
  items: BatchManifestItem[]
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

export interface SessionViewport {
  x: number
  y: number
  zoom: number
}

export interface SessionSnapshot {
  nodes: unknown[]
  edges: unknown[]
  viewport?: SessionViewport
}

export interface LibraryBootstrap {
  library: LibraryInfo
  sessions: SessionRecord[]
  activeSession: SessionRecord
  snapshot: SessionSnapshot
}
