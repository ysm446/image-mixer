import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type { BatchManifest, ComfyStatus, GenerateRequest, GenerationStartedEvent, ImageDescribeErrorEvent, ImageDescribeRequest, ImageDescribeStreamEvent, LlmConfig, LlmStatus, SessionSnapshot, SystemResources } from '../main/types'
import type { ImageMixerApi } from './bridge'

const api: ImageMixerApi = {
  getComfyStatus: () => ipcRenderer.invoke('comfy:status'),
  startComfyUI: () => ipcRenderer.invoke('comfy:start'),
  stopComfyUI: () => ipcRenderer.invoke('comfy:stop'),
  getLlmStatus: () => ipcRenderer.invoke('llm:status'),
  loadLlm: () => ipcRenderer.invoke('llm:load'),
  unloadLlm: () => ipcRenderer.invoke('llm:stop'),
  rescanLlm: () => ipcRenderer.invoke('llm:rescan'),
  updateLlmConfig: (patch: Partial<LlmConfig>) => ipcRenderer.invoke('llm:update-config', patch),
  revealLlmLocation: (location) => ipcRenderer.invoke('llm:reveal', location),
  startImageDescription: (request: ImageDescribeRequest) => ipcRenderer.invoke('llm:image-describe', request),
  cancelImageDescription: (descriptionId) => ipcRenderer.invoke('llm:image-describe-cancel', descriptionId),
  bootstrapLibrary: () => ipcRenderer.invoke('library:bootstrap'),
  chooseLibrary: () => ipcRenderer.invoke('library:choose'),
  createSession: (name) => ipcRenderer.invoke('session:create', name),
  renameSession: (sessionId, name) => ipcRenderer.invoke('session:rename', sessionId, name),
  duplicateSession: (sessionId) => ipcRenderer.invoke('session:duplicate', sessionId),
  loadSession: (sessionId) => ipcRenderer.invoke('session:load', sessionId),
  saveSession: (sessionId, snapshot: SessionSnapshot) => ipcRenderer.invoke('session:save', sessionId, snapshot),
  copySessionAssets: (sourceSessionId, targetSessionId, sourcePaths) => ipcRenderer.invoke('session:copy-assets', sourceSessionId, targetSessionId, sourcePaths),
  deleteSession: (sessionId) => ipcRenderer.invoke('session:delete', sessionId),
  chooseBatchFolder: () => ipcRenderer.invoke('batch:choose-folder'),
  prepareBatchFolder: (inputDirectory) => ipcRenderer.invoke('batch:prepare', inputDirectory),
  saveBatchGeneratedImage: (sessionId, generated, inputPath, outputDirectory, index) => ipcRenderer.invoke('batch:save-image', sessionId, generated, inputPath, outputDirectory, index),
  writeBatchManifest: (outputDirectory, manifest: BatchManifest) => ipcRenderer.invoke('batch:write-manifest', outputDirectory, manifest),
  revealBatchOutput: (outputDirectory) => ipcRenderer.invoke('batch:reveal-output', outputDirectory),
  chooseImage: (sessionId) => ipcRenderer.invoke('image:choose', sessionId),
  importDroppedImage: (file, sessionId) => {
    const sourcePath = webUtils.getPathForFile(file)
    if (!sourcePath) return Promise.reject(new Error('Could not resolve the dropped file path'))
    return ipcRenderer.invoke('image:import', sourcePath, sessionId)
  },
  generateImage: (request: GenerateRequest) => ipcRenderer.invoke('image:generate', request),
  cancelGeneration: (sessionId, nodeId) => ipcRenderer.invoke('image:cancel-generation', sessionId, nodeId),
  copyImage: (sourcePath) => ipcRenderer.invoke('image:copy', sourcePath),
  saveImageCopy: (sourcePath) => ipcRenderer.invoke('image:save-copy', sourcePath),
  captureScreenshot: () => ipcRenderer.invoke('screenshot:capture'),
  revealScreenshot: (sourcePath) => ipcRenderer.invoke('screenshot:reveal', sourcePath),
  onComfyStatus: (callback) => {
    const listener = (_event: IpcRendererEvent, status: ComfyStatus): void => callback(status)
    ipcRenderer.on('comfy:status-changed', listener)
    return () => ipcRenderer.off('comfy:status-changed', listener)
  },
  onLlmStatus: (callback) => {
    const listener = (_event: IpcRendererEvent, status: LlmStatus): void => callback(status)
    ipcRenderer.on('llm:status-changed', listener)
    return () => ipcRenderer.off('llm:status-changed', listener)
  },
  onImageDescriptionDelta: (callback) => {
    const listener = (_event: IpcRendererEvent, payload: ImageDescribeStreamEvent): void => callback(payload)
    ipcRenderer.on('llm:image-describe-delta', listener)
    return () => ipcRenderer.off('llm:image-describe-delta', listener)
  },
  onImageDescriptionDone: (callback) => {
    const listener = (_event: IpcRendererEvent, payload: ImageDescribeStreamEvent): void => callback(payload)
    ipcRenderer.on('llm:image-describe-done', listener)
    return () => ipcRenderer.off('llm:image-describe-done', listener)
  },
  onImageDescriptionError: (callback) => {
    const listener = (_event: IpcRendererEvent, payload: ImageDescribeErrorEvent): void => callback(payload)
    ipcRenderer.on('llm:image-describe-error', listener)
    return () => ipcRenderer.off('llm:image-describe-error', listener)
  },
  onGenerationStarted: (callback) => {
    const listener = (_event: IpcRendererEvent, generation: GenerationStartedEvent): void => callback(generation)
    ipcRenderer.on('image:generation-started', listener)
    return () => ipcRenderer.off('image:generation-started', listener)
  },
  onSystemResources: (callback) => {
    const listener = (_event: IpcRendererEvent, resources: SystemResources): void => callback(resources)
    ipcRenderer.on('system:resources', listener)
    return () => ipcRenderer.off('system:resources', listener)
  }
}

contextBridge.exposeInMainWorld('imageMixer', api)
