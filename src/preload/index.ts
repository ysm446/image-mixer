import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type { ComfyStatus, GenerateRequest, SessionSnapshot, SystemResources } from '../main/types'
import type { ImageMixerApi } from './bridge'

const api: ImageMixerApi = {
  getComfyStatus: () => ipcRenderer.invoke('comfy:status'),
  bootstrapLibrary: () => ipcRenderer.invoke('library:bootstrap'),
  chooseLibrary: () => ipcRenderer.invoke('library:choose'),
  createSession: (name) => ipcRenderer.invoke('session:create', name),
  renameSession: (sessionId, name) => ipcRenderer.invoke('session:rename', sessionId, name),
  duplicateSession: (sessionId) => ipcRenderer.invoke('session:duplicate', sessionId),
  loadSession: (sessionId) => ipcRenderer.invoke('session:load', sessionId),
  saveSession: (sessionId, snapshot: SessionSnapshot) => ipcRenderer.invoke('session:save', sessionId, snapshot),
  copySessionAssets: (sourceSessionId, targetSessionId, sourcePaths) => ipcRenderer.invoke('session:copy-assets', sourceSessionId, targetSessionId, sourcePaths),
  deleteSession: (sessionId) => ipcRenderer.invoke('session:delete', sessionId),
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
  onSystemResources: (callback) => {
    const listener = (_event: IpcRendererEvent, resources: SystemResources): void => callback(resources)
    ipcRenderer.on('system:resources', listener)
    return () => ipcRenderer.off('system:resources', listener)
  }
}

contextBridge.exposeInMainWorld('imageMixer', api)
