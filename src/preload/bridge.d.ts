import type { ComfyStatus, CopiedSessionAsset, GenerateRequest, GeneratedImage, GenerationStartedEvent, ImageAsset, LibraryBootstrap, SessionRecord, SessionSnapshot, SystemResources } from '../main/types'

export interface ImageMixerApi {
  getComfyStatus(): Promise<ComfyStatus>
  startComfyUI(): Promise<ComfyStatus>
  stopComfyUI(): Promise<ComfyStatus>
  bootstrapLibrary(): Promise<LibraryBootstrap>
  chooseLibrary(): Promise<LibraryBootstrap | null>
  createSession(name: string): Promise<{ session: SessionRecord; sessions: SessionRecord[]; snapshot: SessionSnapshot }>
  renameSession(sessionId: string, name: string): Promise<{ session: SessionRecord; sessions: SessionRecord[] }>
  duplicateSession(sessionId: string): Promise<{ session: SessionRecord; sessions: SessionRecord[]; snapshot: SessionSnapshot }>
  loadSession(sessionId: string): Promise<{ session: SessionRecord; snapshot: SessionSnapshot }>
  saveSession(sessionId: string, snapshot: SessionSnapshot): Promise<SessionRecord>
  copySessionAssets(sourceSessionId: string, targetSessionId: string, sourcePaths: string[]): Promise<CopiedSessionAsset[]>
  deleteSession(sessionId: string): Promise<LibraryBootstrap>
  chooseImage(sessionId: string): Promise<ImageAsset | null>
  importDroppedImage(file: File, sessionId: string): Promise<ImageAsset>
  generateImage(request: GenerateRequest): Promise<GeneratedImage>
  cancelGeneration(sessionId: string, nodeId: string): Promise<boolean>
  copyImage(sourcePath: string): Promise<void>
  saveImageCopy(sourcePath: string): Promise<boolean>
  captureScreenshot(): Promise<string>
  revealScreenshot(sourcePath: string): Promise<void>
  onComfyStatus(callback: (status: ComfyStatus) => void): () => void
  onGenerationStarted(callback: (event: GenerationStartedEvent) => void): () => void
  onSystemResources(callback: (resources: SystemResources) => void): () => void
}

declare global {
  interface Window {
    imageMixer: ImageMixerApi
  }
}
