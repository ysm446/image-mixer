import type { ComfyStatus, GenerateRequest, GeneratedImage, ImageAsset, LibraryBootstrap, SessionRecord, SessionSnapshot, SystemResources } from '../main/types'

export interface ImageMixerApi {
  getComfyStatus(): Promise<ComfyStatus>
  bootstrapLibrary(): Promise<LibraryBootstrap>
  chooseLibrary(): Promise<LibraryBootstrap | null>
  createSession(name: string): Promise<{ session: SessionRecord; sessions: SessionRecord[]; snapshot: SessionSnapshot }>
  renameSession(sessionId: string, name: string): Promise<{ session: SessionRecord; sessions: SessionRecord[] }>
  duplicateSession(sessionId: string): Promise<{ session: SessionRecord; sessions: SessionRecord[]; snapshot: SessionSnapshot }>
  loadSession(sessionId: string): Promise<{ session: SessionRecord; snapshot: SessionSnapshot }>
  saveSession(sessionId: string, snapshot: SessionSnapshot): Promise<SessionRecord>
  deleteSession(sessionId: string): Promise<LibraryBootstrap>
  chooseImage(sessionId: string): Promise<ImageAsset | null>
  importDroppedImage(file: File, sessionId: string): Promise<ImageAsset>
  generateImage(request: GenerateRequest): Promise<GeneratedImage>
  cancelGeneration(sessionId: string, nodeId: string): Promise<boolean>
  copyImage(sourcePath: string): Promise<void>
  saveImageCopy(sourcePath: string): Promise<boolean>
  onComfyStatus(callback: (status: ComfyStatus) => void): () => void
  onSystemResources(callback: (resources: SystemResources) => void): () => void
}

declare global {
  interface Window {
    imageMixer: ImageMixerApi
  }
}
