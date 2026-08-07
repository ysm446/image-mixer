import type { BatchFolderSelection, BatchManifest, BatchPreparation, ComfyStatus, CopiedSessionAsset, GenerateRequest, GeneratedImage, GenerationProgressEvent, GenerationStartedEvent, ImageAsset, ImageDescribeErrorEvent, ImageDescribeRequest, ImageDescribeStreamEvent, LibraryBootstrap, LlmConfig, LlmStatus, SessionRecord, SessionSnapshot, SystemResources, TextTransformErrorEvent, TextTransformRequest, TextTransformStreamEvent } from '../main/types'

export interface ImageMixerApi {
  getComfyStatus(): Promise<ComfyStatus>
  startComfyUI(): Promise<ComfyStatus>
  stopComfyUI(): Promise<ComfyStatus>
  getLlmStatus(): Promise<LlmStatus>
  loadLlm(): Promise<LlmStatus>
  unloadLlm(): Promise<LlmStatus>
  rescanLlm(): Promise<LlmStatus>
  updateLlmConfig(patch: Partial<LlmConfig>): Promise<LlmStatus>
  revealLlmLocation(location: 'models' | 'server' | 'logs'): Promise<void>
  startImageDescription(request: ImageDescribeRequest): Promise<void>
  cancelImageDescription(descriptionId: string): Promise<boolean>
  startTextTransform(request: TextTransformRequest): Promise<void>
  cancelTextTransform(transformationId: string): Promise<boolean>
  bootstrapLibrary(): Promise<LibraryBootstrap>
  chooseLibrary(): Promise<LibraryBootstrap | null>
  getRecentLibraries(): Promise<string[]>
  openLibrary(rootPath: string): Promise<LibraryBootstrap>
  createSession(name: string): Promise<{ session: SessionRecord; sessions: SessionRecord[]; snapshot: SessionSnapshot }>
  renameSession(sessionId: string, name: string): Promise<{ session: SessionRecord; sessions: SessionRecord[] }>
  duplicateSession(sessionId: string): Promise<{ session: SessionRecord; sessions: SessionRecord[]; snapshot: SessionSnapshot }>
  loadSession(sessionId: string): Promise<{ session: SessionRecord; snapshot: SessionSnapshot }>
  saveSession(sessionId: string, snapshot: SessionSnapshot): Promise<SessionRecord>
  copySessionAssets(sourceSessionId: string, targetSessionId: string, sourcePaths: string[]): Promise<CopiedSessionAsset[]>
  deleteSession(sessionId: string): Promise<LibraryBootstrap>
  chooseBatchFolder(): Promise<BatchFolderSelection | null>
  prepareBatchFolder(inputDirectory: string): Promise<BatchPreparation>
  saveBatchGeneratedImage(sessionId: string, generated: GeneratedImage, inputPath: string, outputDirectory: string, index: number): Promise<GeneratedImage>
  writeBatchManifest(outputDirectory: string, manifest: BatchManifest): Promise<void>
  revealBatchOutput(outputDirectory: string): Promise<void>
  chooseImage(sessionId: string): Promise<ImageAsset | null>
  importDroppedImage(file: File, sessionId: string): Promise<ImageAsset>
  generateImage(request: GenerateRequest): Promise<GeneratedImage>
  cancelGeneration(sessionId: string, nodeId: string): Promise<boolean>
  copyImage(sourcePath: string): Promise<void>
  saveImageCopy(sourcePath: string): Promise<boolean>
  captureScreenshot(): Promise<string>
  revealScreenshot(sourcePath: string): Promise<void>
  onComfyStatus(callback: (status: ComfyStatus) => void): () => void
  onLlmStatus(callback: (status: LlmStatus) => void): () => void
  onImageDescriptionDelta(callback: (event: ImageDescribeStreamEvent) => void): () => void
  onImageDescriptionDone(callback: (event: ImageDescribeStreamEvent) => void): () => void
  onImageDescriptionError(callback: (event: ImageDescribeErrorEvent) => void): () => void
  onTextTransformDelta(callback: (event: TextTransformStreamEvent) => void): () => void
  onTextTransformDone(callback: (event: TextTransformStreamEvent) => void): () => void
  onTextTransformError(callback: (event: TextTransformErrorEvent) => void): () => void
  onGenerationStarted(callback: (event: GenerationStartedEvent) => void): () => void
  onGenerationProgress(callback: (event: GenerationProgressEvent) => void): () => void
  onSystemResources(callback: (resources: SystemResources) => void): () => void
}

declare global {
  interface Window {
    imageMixer: ImageMixerApi
  }
}
