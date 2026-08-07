import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { access, copyFile, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import * as os from 'node:os'
import sharp from 'sharp'
import { DEFAULT_LLM_CONFIG, LlamaServerManager } from './llamaServer'
import { DEFAULT_IMAGE_DESCRIBE_SYSTEM_PROMPT, DEFAULT_TEXT_TRANSFORM_SYSTEM_PROMPT } from './types'
import type { BatchFolderSelection, BatchManifest, BatchPreparation, ComfyStatus, CopiedSessionAsset, GenerateRequest, GeneratedImage, GenerationStartedEvent, ImageAsset, ImageDescribeErrorEvent, ImageDescribeRequest, ImageDescribeStreamEvent, LibraryBootstrap, LibraryInfo, LlmConfig, LlmStatus, SessionRecord, SessionSnapshot, SystemResources, TextTransformErrorEvent, TextTransformRequest, TextTransformStreamEvent } from './types'

const COMFY_URL = 'http://127.0.0.1:8189'
const COMFY_PORT = '8189'

type CpuSample = Array<{ idle: number; total: number }>
type GpuInfo = Pick<SystemResources, 'gpuUsage' | 'vramUsed' | 'vramTotal'>

function sampleCpus(): CpuSample {
  return os.cpus().map((cpu) => {
    const total = Object.values(cpu.times).reduce((sum, value) => sum + value, 0)
    return { idle: cpu.times.idle, total }
  })
}

function computeCpuUsage(previous: CpuSample, current: CpuSample): number {
  let idleDelta = 0
  let totalDelta = 0
  const count = Math.min(previous.length, current.length)
  for (let index = 0; index < count; index += 1) {
    idleDelta += current[index].idle - previous[index].idle
    totalDelta += current[index].total - previous[index].total
  }
  return totalDelta > 0 ? (1 - idleDelta / totalDelta) * 100 : 0
}

function queryNvidiaSmi(): Promise<GpuInfo> {
  return new Promise((resolveGpu) => {
    execFile(
      'nvidia-smi',
      ['--query-gpu=utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'],
      { timeout: 3000, windowsHide: true },
      (error, stdout) => {
        const firstLine = stdout?.trim().split(/\r?\n/)[0]
        const values = firstLine?.split(',').map((value) => Number.parseFloat(value.trim())) ?? []
        if (error || values.length < 3 || values.some((value) => !Number.isFinite(value))) {
          resolveGpu({ gpuUsage: null, vramUsed: null, vramTotal: null })
          return
        }
        resolveGpu({ gpuUsage: values[0], vramUsed: values[1], vramTotal: values[2] })
      }
    )
  })
}

type WorkflowNode = {
  class_type: string
  inputs: Record<string, unknown>
  _meta?: { title?: string }
}

type Workflow = Record<string, WorkflowNode>
type UploadResponse = { name: string; subfolder?: string; type?: string }
type HistoryImage = { filename: string; subfolder: string; type: string }
type GenerationJob = {
  controller: AbortController
  promptId: string | null
  request: GenerateRequest
  state: 'queued' | 'running'
  resolve: (image: GeneratedImage) => void
  reject: (reason?: unknown) => void
}

let mainWindow: BrowserWindow | null = null
let comfyProcess: ChildProcess | null = null
let comfyStopRequested = false
let comfyStatus: ComfyStatus = { phase: 'stopped', message: 'ComfyUI is stopped', managed: false }
let llamaServer: LlamaServerManager | null = null
let llmConfig: LlmConfig = { ...DEFAULT_LLM_CONFIG }
let isQuitting = false
let libraryRoot = ''
let libraryHistory: string[] = []
let cpuSample = sampleCpus()
let cachedGpuInfo: GpuInfo = { gpuUsage: null, vramUsed: null, vramTotal: null }
let systemResourcesInterval: ReturnType<typeof setInterval> | null = null
const generationJobs = new Map<string, GenerationJob>()
const latestGenerationResultPaths = new Map<string, string>()
const generationQueue: string[] = []
let processingGenerationQueue = false
const pendingSessionAssets = new Map<string, number>()
const imageDescriptionControllers = new Map<string, AbortController>()
const textTransformationControllers = new Map<string, AbortController>()
const sessionAssetExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp'])
const hasSingleInstanceLock = app.requestSingleInstanceLock()

function generationKey(sessionId: string, nodeId: string): string {
  return `${sessionId}:${nodeId}`
}

function throwIfGenerationCanceled(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('Generation canceled')
}

function waitWithSignal(durationMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveWait, rejectWait) => {
    if (signal.aborted) {
      rejectWait(new Error('Generation canceled'))
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      rejectWait(new Error('Generation canceled'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolveWait()
    }, durationMs)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function startSystemResourcePolling(): void {
  if (systemResourcesInterval) return
  let gpuQueryInFlight = false
  let tick = 0
  const refreshGpu = (): void => {
    if (gpuQueryInFlight) return
    gpuQueryInFlight = true
    void queryNvidiaSmi().then((info) => {
      cachedGpuInfo = info
    }).finally(() => {
      gpuQueryInFlight = false
    })
  }

  refreshGpu()
  systemResourcesInterval = setInterval(() => {
    const currentCpuSample = sampleCpus()
    const cpuUsage = Math.round(computeCpuUsage(cpuSample, currentCpuSample))
    cpuSample = currentCpuSample
    const ramTotal = os.totalmem()
    const payload: SystemResources = {
      cpuUsage,
      ramUsed: ramTotal - os.freemem(),
      ramTotal,
      gpuUsage: cachedGpuInfo.gpuUsage == null ? null : Math.round(cachedGpuInfo.gpuUsage),
      vramUsed: cachedGpuInfo.vramUsed,
      vramTotal: cachedGpuInfo.vramTotal
    }
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send('system:resources', payload)
    tick += 1
    if (tick % 2 === 0) refreshGpu()
  }, 1000)
}

function stopSystemResourcePolling(): void {
  if (!systemResourcesInterval) return
  clearInterval(systemResourcesInterval)
  systemResourcesInterval = null
}

function projectRoot(): string {
  return app.getAppPath()
}

function dataRoot(): string {
  return join(projectRoot(), 'data')
}

function appSettingsPath(): string {
  return join(dataRoot(), 'app-settings.json')
}

function libraryInfo(): LibraryInfo {
  return { rootPath: libraryRoot, name: basename(libraryRoot) || libraryRoot }
}

function sessionsRoot(): string {
  return join(libraryRoot, 'sessions')
}

function sessionDirectory(sessionId: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) throw new Error('Invalid session ID')
  const root = resolve(sessionsRoot())
  const target = resolve(root, sessionId)
  if (!target.startsWith(`${root}${sep}`)) throw new Error('Session path is outside the library')
  return target
}

function sessionFile(sessionId: string): string {
  return join(sessionDirectory(sessionId), 'session.json')
}

function resolveSessionAsset(sourcePath: string): string {
  const root = resolve(sessionsRoot())
  const target = resolve(sourcePath)
  if (!target.startsWith(`${root}${sep}`)) throw new Error('Image path is outside the session library')
  return target
}

function rememberLibraryRoot(): void {
  const current = resolve(libraryRoot)
  libraryHistory = [current, ...libraryHistory.filter((path) => assetPathKey(path) !== assetPathKey(current))].slice(0, 10)
}

async function loadLibraryRoot(): Promise<void> {
  try {
    const parsed = JSON.parse(await readFile(appSettingsPath(), 'utf8')) as { libraryRoot?: unknown; libraryHistory?: unknown; llm?: Partial<LlmConfig> }
    libraryRoot = typeof parsed.libraryRoot === 'string' && parsed.libraryRoot ? resolve(parsed.libraryRoot) : join(dataRoot(), 'library')
    libraryHistory = Array.isArray(parsed.libraryHistory)
      ? parsed.libraryHistory.filter((path): path is string => typeof path === 'string' && path.trim() !== '')
      : []
    llmConfig = { ...DEFAULT_LLM_CONFIG, ...parsed.llm }
  } catch {
    libraryRoot = join(dataRoot(), 'library')
    libraryHistory = []
    llmConfig = { ...DEFAULT_LLM_CONFIG }
  }
  rememberLibraryRoot()
  await mkdir(sessionsRoot(), { recursive: true })
  await cleanupAllSessionAssets()
}

async function saveAppSettings(): Promise<void> {
  await mkdir(dataRoot(), { recursive: true })
  await writeFile(appSettingsPath(), JSON.stringify({ libraryRoot, libraryHistory, llm: llmConfig }, null, 2), 'utf8')
}

function emptySnapshot(): SessionSnapshot {
  return { nodes: [], edges: [] }
}

function recoverInterruptedGenerations(sessionId: string, snapshot: SessionSnapshot): { snapshot: SessionSnapshot; recovered: boolean } {
  const clone = structuredClone(snapshot) as {
    nodes: Array<{
      id?: unknown
      data?: {
        kind?: unknown
        state?: unknown
        error?: unknown
        durationMs?: unknown
        startedAtMs?: unknown
      }
    }>
    edges: unknown[]
  }
  let recovered = false
  for (const node of clone.nodes) {
    if (node.data?.kind !== 'generate' || (node.data.state !== 'queued' && node.data.state !== 'running') || typeof node.id !== 'string') continue
    if (generationJobs.has(generationKey(sessionId, node.id))) continue
    node.data.state = 'canceled'
    node.data.error = null
    node.data.durationMs = typeof node.data.durationMs === 'number' && node.data.durationMs > 0 ? node.data.durationMs : null
    node.data.startedAtMs = null
    recovered = true
  }
  return { snapshot: clone, recovered }
}

async function createSession(name: string): Promise<SessionRecord> {
  const now = new Date().toISOString()
  const session: SessionRecord = { id: randomUUID(), name: name.trim() || 'New session', createdAt: now, updatedAt: now }
  await mkdir(join(sessionDirectory(session.id), 'assets'), { recursive: true })
  await writeFile(sessionFile(session.id), JSON.stringify({ session, snapshot: emptySnapshot() }, null, 2), 'utf8')
  return session
}

async function renameSession(sessionId: string, name: string): Promise<SessionRecord> {
  const parsed = JSON.parse(await readFile(sessionFile(sessionId), 'utf8')) as { session: SessionRecord; snapshot?: SessionSnapshot }
  const session: SessionRecord = {
    ...parsed.session,
    name: name.trim() || parsed.session.name,
    updatedAt: new Date().toISOString()
  }
  await writeFile(sessionFile(sessionId), JSON.stringify({ session, snapshot: parsed.snapshot ?? emptySnapshot() }, null, 2), 'utf8')
  return session
}

function rebaseSnapshotAssets(snapshot: SessionSnapshot, sourceDirectory: string, targetDirectory: string): SessionSnapshot {
  const clone = structuredClone(snapshot) as { nodes: Array<{ data?: { kind?: string; image?: ImageAsset | null; result?: GeneratedImage | null } }>; edges: unknown[] }
  const sourceRoot = resolve(sourceDirectory)
  const rebaseAsset = (asset: ImageAsset | GeneratedImage): void => {
    const sourcePath = resolve(asset.path)
    if (!sourcePath.startsWith(`${sourceRoot}${sep}`)) throw new Error('Session contains an image outside its asset directory')
    asset.path = join(targetDirectory, sourcePath.slice(sourceRoot.length + 1))
    asset.dataUrl = ''
  }
  for (const node of clone.nodes) {
    if (node.data?.image) rebaseAsset(node.data.image)
    if (node.data?.result && node.data.kind !== 'batch-generate') rebaseAsset(node.data.result)
    else if (node.data?.result) node.data.result.dataUrl = ''
  }
  return clone
}

async function duplicateSession(sessionId: string): Promise<{ session: SessionRecord; snapshot: SessionSnapshot }> {
  const sourceDirectory = sessionDirectory(sessionId)
  const parsed = JSON.parse(await readFile(sessionFile(sessionId), 'utf8')) as { session: SessionRecord; snapshot?: SessionSnapshot }
  const existingNames = new Set((await listSessions()).map((session) => session.name))
  const baseName = `${parsed.session.name} Copy`
  let name = baseName
  let copyNumber = 2
  while (existingNames.has(name)) {
    name = `${baseName} ${copyNumber}`
    copyNumber += 1
  }

  const id = randomUUID()
  const targetDirectory = sessionDirectory(id)
  const now = new Date().toISOString()
  const session: SessionRecord = { id, name, createdAt: now, updatedAt: now }
  const sourceSnapshot = healSnapshotAssetPaths(sessionId, parsed.snapshot ?? emptySnapshot()).snapshot
  const rebasedSnapshot = rebaseSnapshotAssets(sourceSnapshot, sourceDirectory, targetDirectory)
  const snapshot = recoverInterruptedGenerations(id, rebasedSnapshot).snapshot
  try {
    await mkdir(targetDirectory, { recursive: true })
    await cp(join(sourceDirectory, 'assets'), join(targetDirectory, 'assets'), { recursive: true })
    await writeFile(sessionFile(id), JSON.stringify({ session, snapshot }, null, 2), 'utf8')
    await cleanupUnusedSessionAssets(id, snapshot)
    return { session, snapshot: await hydrateSnapshot(snapshot) }
  } catch (error) {
    await rm(targetDirectory, { recursive: true, force: true })
    throw error
  }
}

async function readSession(sessionId: string): Promise<{ session: SessionRecord; snapshot: SessionSnapshot }> {
  const parsed = JSON.parse(await readFile(sessionFile(sessionId), 'utf8')) as { session: SessionRecord; snapshot?: SessionSnapshot }
  const healed = healSnapshotAssetPaths(sessionId, parsed.snapshot ?? emptySnapshot())
  const recovered = recoverInterruptedGenerations(sessionId, healed.snapshot)
  if (recovered.recovered || healed.healed) {
    await writeFile(sessionFile(sessionId), JSON.stringify({ session: parsed.session, snapshot: stripDataUrls(recovered.snapshot) }, null, 2), 'utf8')
  }
  return { session: parsed.session, snapshot: await hydrateSnapshot(recovered.snapshot) }
}

async function listSessions(): Promise<SessionRecord[]> {
  await mkdir(sessionsRoot(), { recursive: true })
  const entries = await readdir(sessionsRoot(), { withFileTypes: true })
  const sessions: SessionRecord[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    try {
      const parsed = JSON.parse(await readFile(sessionFile(entry.name), 'utf8')) as { session: SessionRecord }
      sessions.push(parsed.session)
    } catch {
      // Ignore incomplete folders instead of preventing the library from opening.
    }
  }
  return sessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}

async function ensureSession(): Promise<SessionRecord> {
  const existing = await listSessions()
  return existing[0] ?? createSession('Session 1')
}

function stripDataUrls(snapshot: SessionSnapshot): SessionSnapshot {
  const clone = structuredClone(snapshot) as { nodes: Array<{ data?: { image?: ImageAsset | null; result?: GeneratedImage | null } }>; edges: unknown[] }
  for (const node of clone.nodes) {
    if (node.data?.image) node.data.image.dataUrl = ''
    if (node.data?.result) node.data.result.dataUrl = ''
  }
  return clone
}

function sessionAssetsDirectory(sessionId: string): string {
  return join(sessionDirectory(sessionId), 'assets')
}

function assetPathKey(assetPath: string): string {
  const normalized = resolve(assetPath)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function resolveSessionAssetPath(sessionId: string, assetPath: string): string {
  const assetsRoot = `${assetPathKey(sessionAssetsDirectory(sessionId))}${sep}`
  const target = resolve(assetPath)
  if (!assetPathKey(target).startsWith(assetsRoot)) throw new Error('Image path is outside the source session')
  return target
}

function healSnapshotAssetPaths(sessionId: string, snapshot: SessionSnapshot): { snapshot: SessionSnapshot; healed: boolean } {
  const assetsDirectory = sessionAssetsDirectory(sessionId)
  const assetsRoot = `${assetPathKey(assetsDirectory)}${sep}`
  const clone = structuredClone(snapshot) as { nodes: Array<{ data?: { kind?: string; image?: ImageAsset | null; result?: GeneratedImage | null } }>; edges: unknown[] }
  let healed = false
  const heal = (asset: ImageAsset | GeneratedImage | null | undefined): void => {
    if (!asset?.path || assetPathKey(asset.path).startsWith(assetsRoot)) return
    asset.path = join(assetsDirectory, basename(asset.path))
    healed = true
  }
  for (const node of clone.nodes) {
    heal(node.data?.image)
    if (node.data?.kind !== 'batch-generate') heal(node.data?.result)
  }
  return { snapshot: clone, healed }
}

function referencedSessionAssets(sessionId: string, snapshot: SessionSnapshot): Set<string> {
  const assetsRoot = `${assetPathKey(sessionAssetsDirectory(sessionId))}${sep}`
  const referenced = new Set<string>()
  const nodes = snapshot.nodes as Array<{ data?: { image?: ImageAsset | null; result?: GeneratedImage | null } }>
  const addAsset = (asset?: ImageAsset | GeneratedImage | null): void => {
    if (!asset?.path) return
    const key = assetPathKey(asset.path)
    if (key.startsWith(assetsRoot)) referenced.add(key)
  }
  for (const node of nodes) {
    addAsset(node.data?.image)
    addAsset(node.data?.result)
  }
  return referenced
}

async function cleanupUnusedSessionAssets(sessionId: string, snapshot: SessionSnapshot, saveStartedAt?: number): Promise<void> {
  const assetsDirectory = sessionAssetsDirectory(sessionId)
  // Heal stale absolute paths first so a moved library root never marks its own assets as unused.
  const referenced = referencedSessionAssets(sessionId, healSnapshotAssetPaths(sessionId, snapshot).snapshot)
  for (const key of referenced) pendingSessionAssets.delete(key)

  let entries
  try {
    entries = await readdir(assetsDirectory, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }

  for (const entry of entries) {
    if (!entry.isFile() || !sessionAssetExtensions.has(extname(entry.name).toLowerCase())) continue
    const assetPath = join(assetsDirectory, entry.name)
    const key = assetPathKey(assetPath)
    if (referenced.has(key)) continue
    const createdAt = pendingSessionAssets.get(key)
    if (createdAt != null && (saveStartedAt == null || createdAt >= saveStartedAt)) continue
    pendingSessionAssets.delete(key)
    await rm(assetPath, { force: true })
  }
}

async function cleanupAllSessionAssets(): Promise<void> {
  const entries = await readdir(sessionsRoot(), { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    try {
      const parsed = JSON.parse(await readFile(sessionFile(entry.name), 'utf8')) as { snapshot?: SessionSnapshot }
      await cleanupUnusedSessionAssets(entry.name, parsed.snapshot ?? emptySnapshot())
    } catch (error) {
      console.warn(`Could not clean unused assets for session ${entry.name}:`, error)
    }
  }
}

async function imagePreview(source: string | Buffer, previewWidth = 512): Promise<{ dataUrl: string; width: number; height: number }> {
  const image = sharp(source, { failOn: 'error' })
  const metadata = await image.metadata()
  if (!metadata.width || !metadata.height) throw new Error('Image dimensions could not be determined')
  const preview = await image
    .clone()
    .resize({ width: previewWidth, withoutEnlargement: true })
    .png()
    .toBuffer()
  return {
    dataUrl: `data:image/png;base64,${preview.toString('base64')}`,
    width: metadata.width,
    height: metadata.height
  }
}

async function hydrateSnapshot(snapshot: SessionSnapshot): Promise<SessionSnapshot> {
  const clone = structuredClone(snapshot) as { nodes: Array<{ data?: { image?: ImageAsset | null; result?: GeneratedImage | null } }>; edges: unknown[] }
  for (const node of clone.nodes) {
    if (node.data?.image?.path) {
      try { Object.assign(node.data.image, await imagePreview(node.data.image.path)) } catch { Object.assign(node.data.image, { dataUrl: '', width: 0, height: 0 }) }
    }
    if (node.data?.result?.path) {
      try { Object.assign(node.data.result, await imagePreview(node.data.result.path, 768)) } catch { Object.assign(node.data.result, { dataUrl: '', width: 0, height: 0 }) }
    }
  }
  return clone
}

async function saveSession(sessionId: string, snapshot: SessionSnapshot): Promise<SessionRecord> {
  const saveStartedAt = Date.now()
  const current = JSON.parse(await readFile(sessionFile(sessionId), 'utf8')) as { session: SessionRecord }
  const session = { ...current.session, updatedAt: new Date().toISOString() }
  const persistedSnapshot = stripDataUrls(snapshot)
  await writeFile(sessionFile(sessionId), JSON.stringify({ session, snapshot: persistedSnapshot }, null, 2), 'utf8')
  await cleanupUnusedSessionAssets(sessionId, persistedSnapshot, saveStartedAt)
  return session
}

async function buildLibraryBootstrap(): Promise<LibraryBootstrap> {
  const activeSession = await ensureSession()
  const loaded = await readSession(activeSession.id)
  return { library: libraryInfo(), sessions: await listSessions(), activeSession, snapshot: loaded.snapshot }
}

async function changeLibrary(nextRoot: string): Promise<LibraryBootstrap> {
  libraryRoot = resolve(nextRoot)
  rememberLibraryRoot()
  await mkdir(sessionsRoot(), { recursive: true })
  await saveAppSettings()
  await cleanupAllSessionAssets()
  return buildLibraryBootstrap()
}

async function importImage(sourcePath: string, sessionId: string): Promise<ImageAsset> {
  let decoded: Awaited<ReturnType<typeof imagePreview>>
  try {
    decoded = await imagePreview(sourcePath)
  } catch {
    throw new Error('The selected file is not a readable PNG, JPEG, WebP, or BMP image')
  }
  const extension = extname(sourcePath).toLowerCase() || '.png'
  const destination = join(sessionAssetsDirectory(sessionId), `${randomUUID()}${extension}`)
  const destinationKey = assetPathKey(destination)
  pendingSessionAssets.set(destinationKey, Date.now())
  try {
    await mkdir(dirname(destination), { recursive: true })
    await copyFile(sourcePath, destination)
    return {
      path: destination,
      name: basename(sourcePath),
      ...decoded
    }
  } catch (error) {
    pendingSessionAssets.delete(destinationKey)
    await rm(destination, { force: true })
    throw error
  }
}

async function scanBatchDirectory(inputDirectory: string): Promise<BatchFolderSelection> {
  const directory = resolve(inputDirectory)
  const entries = await readdir(directory, { withFileTypes: true })
  const imageCount = entries.filter((entry) => entry.isFile() && sessionAssetExtensions.has(extname(entry.name).toLowerCase())).length
  return { path: directory, name: basename(directory), imageCount }
}

async function chooseBatchDirectory(): Promise<BatchFolderSelection | null> {
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] })
    : await dialog.showOpenDialog({ properties: ['openDirectory'] })
  if (result.canceled || !result.filePaths[0]) return null
  return scanBatchDirectory(result.filePaths[0])
}

async function prepareBatchDirectory(inputDirectory: string): Promise<BatchPreparation> {
  const selection = await scanBatchDirectory(inputDirectory)
  if (selection.imageCount === 0) throw new Error('The selected folder does not contain supported images')
  const entries = await readdir(selection.path, { withFileTypes: true })
  const names = entries
    .filter((entry) => entry.isFile() && sessionAssetExtensions.has(extname(entry.name).toLowerCase()))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' }))
  const files: BatchPreparation['files'] = []
  for (const name of names) {
    const path = join(selection.path, name)
    try {
      const metadata = await sharp(path, { failOn: 'error' }).metadata()
      files.push({ path, name, width: metadata.width ?? 0, height: metadata.height ?? 0 })
    } catch {
      files.push({ path, name, width: 0, height: 0 })
    }
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '')
  const outputDirectory = join(selection.path, 'image-mixer-output-' + timestamp)
  await mkdir(outputDirectory, { recursive: false })
  return { inputDirectory: selection.path, outputDirectory, files }
}

function validateBatchOutputDirectory(outputDirectory: string): string {
  const target = resolve(outputDirectory)
  if (!basename(target).startsWith('image-mixer-output-')) throw new Error('Invalid batch output folder')
  return target
}

async function saveBatchGeneratedImage(sessionId: string, generated: GeneratedImage, inputPath: string, outputDirectory: string, index: number): Promise<GeneratedImage> {
  const source = resolveSessionAssetPath(sessionId, generated.path)
  const output = validateBatchOutputDirectory(outputDirectory)
  const input = resolve(inputPath)
  if (dirname(input) !== dirname(output)) throw new Error('Batch input image is outside the selected input folder')
  if (!Number.isInteger(index) || index < 0) throw new Error('Invalid batch item index')
  const extension = extname(source).toLowerCase() || '.png'
  const inputStem = basename(input, extname(input))
  const destination = join(output, String(index + 1).padStart(4, '0') + '-' + inputStem + extension)
  try {
    await copyFile(source, destination)
    return { ...generated, path: destination, name: basename(destination) }
  } finally {
    pendingSessionAssets.delete(assetPathKey(source))
    await rm(source, { force: true })
  }
}

async function writeBatchManifest(outputDirectory: string, manifest: BatchManifest): Promise<void> {
  const output = validateBatchOutputDirectory(outputDirectory)
  if (resolve(manifest.outputDirectory) !== output) throw new Error('Batch manifest output folder does not match')
  if (resolve(manifest.inputDirectory) !== dirname(output)) throw new Error('Batch manifest input folder does not match')
  await writeFile(join(output, 'batch-result.json'), JSON.stringify(manifest, null, 2), 'utf8')
}

async function revealBatchOutput(outputDirectory: string): Promise<void> {
  const error = await shell.openPath(validateBatchOutputDirectory(outputDirectory))
  if (error) throw new Error(error)
}

async function copySessionAssets(sourceSessionId: string, targetSessionId: string, sourcePaths: string[]): Promise<CopiedSessionAsset[]> {
  if (!Array.isArray(sourcePaths) || sourcePaths.length > 1000 || sourcePaths.some((sourcePath) => typeof sourcePath !== 'string')) {
    throw new Error('Invalid session asset copy request')
  }
  const sources = [...new Set(sourcePaths)].map((sourcePath) => ({
    sourcePath,
    resolvedPath: resolveSessionAssetPath(sourceSessionId, sourcePath)
  }))
  sessionDirectory(targetSessionId)
  if (sourceSessionId === targetSessionId) {
    return sources.map(({ sourcePath }) => ({ sourcePath, destinationPath: sourcePath }))
  }

  const copied: CopiedSessionAsset[] = []
  try {
    await mkdir(sessionAssetsDirectory(targetSessionId), { recursive: true })
    for (const source of sources) {
      const extension = extname(source.resolvedPath).toLowerCase()
      if (!sessionAssetExtensions.has(extension)) throw new Error('Unsupported session image type')
      const destinationPath = join(sessionAssetsDirectory(targetSessionId), `${randomUUID()}${extension}`)
      copied.push({ sourcePath: source.sourcePath, destinationPath })
      pendingSessionAssets.set(assetPathKey(destinationPath), Date.now())
      await copyFile(source.resolvedPath, destinationPath)
    }
    return copied
  } catch (error) {
    for (const asset of copied) {
      pendingSessionAssets.delete(assetPathKey(asset.destinationPath))
      await rm(asset.destinationPath, { force: true })
    }
    throw error
  }
}

async function copyImageToClipboard(sourcePath: string): Promise<void> {
  const imagePath = resolveSessionAsset(sourcePath)
  const png = await sharp(imagePath, { failOn: 'error' }).png().toBuffer()
  const image = nativeImage.createFromBuffer(png)
  if (image.isEmpty()) throw new Error('The generated image could not be copied')
  clipboard.writeImage(image)
}

async function saveImageCopy(sourcePath: string): Promise<boolean> {
  const imagePath = resolveSessionAsset(sourcePath)
  const options = {
    defaultPath: basename(imagePath),
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }]
  }
  const result = mainWindow
    ? await dialog.showSaveDialog(mainWindow, options)
    : await dialog.showSaveDialog(options)
  if (result.canceled || !result.filePath) return false
  if (resolve(result.filePath) !== imagePath) await copyFile(imagePath, result.filePath)
  return true
}

async function captureScreenshot(): Promise<string> {
  if (!mainWindow) throw new Error('The application window is not ready')
  const screenshot = await mainWindow.webContents.capturePage()
  if (screenshot.isEmpty()) throw new Error('The screenshot could not be captured')
  const directory = join(libraryRoot, 'screenshot')
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const destination = join(directory, `screenshot-${timestamp}.png`)
  await mkdir(directory, { recursive: true })
  await writeFile(destination, screenshot.toPNG())
  return destination
}

function revealScreenshot(sourcePath: string): void {
  const screenshotRoot = `${assetPathKey(join(libraryRoot, 'screenshot'))}${sep}`
  const target = resolve(sourcePath)
  if (!assetPathKey(target).startsWith(screenshotRoot)) throw new Error('Screenshot path is outside the screenshot folder')
  shell.showItemInFolder(target)
}

function setComfyStatus(status: ComfyStatus): void {
  comfyStatus = status
  mainWindow?.webContents.send('comfy:status-changed', status)
}

function getLlamaServer(): LlamaServerManager {
  if (!llamaServer) throw new Error('Local LLM manager is not initialized')
  return llamaServer
}

async function revealLlmLocation(location: 'models' | 'server' | 'logs'): Promise<void> {
  const target = location === 'models'
    ? join(projectRoot(), 'models')
    : location === 'server'
      ? join(projectRoot(), 'runtime', 'llama-server')
      : join(dataRoot(), 'logs')
  await mkdir(target, { recursive: true })
  const error = await shell.openPath(target)
  if (error) throw new Error(error)
}

async function isComfyReady(): Promise<boolean> {
  try {
    const response = await fetch(`${COMFY_URL}/system_stats`, { signal: AbortSignal.timeout(1_500) })
    return response.ok
  } catch {
    return false
  }
}

async function waitForComfy(timeoutMs = 90_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isComfyReady()) return true
    // The exit handler already reported the failure when the managed process died.
    if (!comfyProcess) return false
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return false
}

async function startComfyUI(): Promise<void> {
  if (comfyStatus.phase === 'starting' || comfyStatus.phase === 'stopping') return
  setComfyStatus({ phase: 'starting', message: 'Checking ComfyUI…', managed: comfyProcess !== null })
  if (await isComfyReady()) {
    const managed = comfyProcess !== null
    setComfyStatus({ phase: 'ready', message: managed ? 'ComfyUI is ready' : 'Connected to an existing ComfyUI server', managed })
    return
  }
  if (comfyProcess) {
    setComfyStatus({ phase: 'starting', message: 'Waiting for ComfyUI…', managed: true })
    if (await waitForComfy()) setComfyStatus({ phase: 'ready', message: 'ComfyUI is ready', managed: true })
    else if (comfyProcess) setComfyStatus({ phase: 'error', message: 'Timed out while starting ComfyUI. Check data/logs/comfyui.log.', managed: true })
    return
  }

  const root = projectRoot()
  const pythonPath = join(root, '.venv', 'Scripts', 'python.exe')
  const comfyMain = join(root, 'runtime', 'ComfyUI', 'main.py')
  const comfyCwd = dirname(comfyMain)

  try {
    await access(pythonPath)
    await access(comfyMain)
  } catch {
    setComfyStatus({
      phase: 'error',
      message: '.venv or runtime/ComfyUI/main.py was not found. Create the Python venv first.',
      managed: false
    })
    return
  }

  setComfyStatus({ phase: 'starting', message: 'Starting ComfyUI…', managed: true })
  await mkdir(join(dataRoot(), 'logs'), { recursive: true })
  const log = createWriteStream(join(dataRoot(), 'logs', 'comfyui.log'), { flags: 'a' })

  const child = spawn(pythonPath, [comfyMain, '--listen', '127.0.0.1', '--port', COMFY_PORT], {
    cwd: comfyCwd,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  comfyProcess = child
  child.stdout.pipe(log, { end: false })
  child.stderr.pipe(log, { end: false })
  child.once('error', (error) => {
    setComfyStatus({ phase: 'error', message: `Failed to start ComfyUI: ${error.message}`, managed: true })
  })
  child.once('exit', (code) => {
    const wasStopRequested = comfyStopRequested
    comfyStopRequested = false
    comfyProcess = null
    if (!isQuitting) {
      setComfyStatus(wasStopRequested
        ? { phase: 'stopped', message: 'ComfyUI is unloaded', managed: false }
        : { phase: code === 0 ? 'stopped' : 'error', message: 'ComfyUI exited (' + (code ?? 'unknown') + ')', managed: true })
    }
    log.end()
  })

  if (await waitForComfy()) {
    setComfyStatus({ phase: 'ready', message: 'ComfyUI is ready', managed: true })
  } else if (comfyProcess) {
    setComfyStatus({ phase: 'error', message: 'Timed out while starting ComfyUI. Check data/logs/comfyui.log.', managed: true })
  }
}

async function stopComfyUI(): Promise<void> {
  if (!comfyProcess) {
    if (comfyStatus.phase === 'ready' && !comfyStatus.managed) throw new Error('Externally managed ComfyUI cannot be unloaded from this app')
    setComfyStatus({ phase: 'stopped', message: 'ComfyUI is unloaded', managed: false })
    return
  }
  const process = comfyProcess
  comfyStopRequested = true
  setComfyStatus({ phase: 'stopping', message: 'Unloading ComfyUI…', managed: true })
  const exited = await new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => resolve(false), 5_000)
    process.once('exit', () => {
      clearTimeout(timeout)
      resolve(true)
    })
    process.kill()
  })
  if (!exited && comfyProcess === process && !isQuitting) {
    setComfyStatus({ phase: 'error', message: 'Timed out while unloading ComfyUI', managed: true })
  }
}

function createWindow(): void {
  Menu.setApplicationMenu(null)
  mainWindow = new BrowserWindow({
    width: 1920,
    height: 1080,
    useContentSize: true,
    minWidth: 1080,
    minHeight: 700,
    backgroundColor: '#0a0d12',
    title: 'Image Mixer',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  mainWindow.setMenu(null)
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function findNode(workflow: Workflow, classType: string, predicate?: (node: WorkflowNode) => boolean): [string, WorkflowNode] {
  const entry = Object.entries(workflow).find(([, node]) => node.class_type === classType && (!predicate || predicate(node)))
  if (!entry) throw new Error(`Workflow node not found: ${classType}`)
  return entry
}

async function uploadImage(filePath: string, signal: AbortSignal): Promise<string> {
  const bytes = new Uint8Array(await readFile(filePath))
  const form = new FormData()
  form.append('image', new Blob([bytes]), basename(filePath))
  form.append('type', 'input')
  form.append('subfolder', 'image-mixer')
  form.append('overwrite', 'true')
  const response = await fetch(`${COMFY_URL}/upload/image`, { method: 'POST', body: form, signal })
  if (!response.ok) throw new Error(`Image upload failed (${response.status})`)
  const uploaded = (await response.json()) as UploadResponse
  return uploaded.subfolder ? `${uploaded.subfolder}/${uploaded.name}` : uploaded.name
}

function applyRequest(workflow: Workflow, request: GenerateRequest, uploadedImages: Array<string | null>): Workflow {
  const sampler = findNode(workflow, 'KSampler')[1]
  const positive = findNode(workflow, 'TextEncodeQwenImageEditPlus', (node) => node._meta?.title?.includes('Input Prompt') === true)[1]
  const size = findNode(workflow, 'EmptyLatentImage')[1]

  sampler.inputs.seed = request.settings.seed
  sampler.inputs.steps = request.settings.steps
  sampler.inputs.cfg = request.settings.cfg
  positive.inputs.prompt = request.prompt
  size.inputs.width = request.settings.width
  size.inputs.height = request.settings.height
  size.inputs.batch_size = 1

  if (uploadedImages.some(Boolean)) {
    const loadNodes = Object.entries(workflow)
      .filter(([, node]) => node.class_type === 'LoadImage')
      .sort(([left], [right]) => Number(left) - Number(right))
    if (loadNodes.length < 3) throw new Error('The image-editing workflow must contain three LoadImage nodes')

    for (let index = 0; index < 3; index += 1) {
      const inputName = `image${index + 1}`
      const [loadId, loadNode] = loadNodes[index]
      const uploaded = uploadedImages[index]
      if (uploaded) {
        loadNode.inputs.image = uploaded
        positive.inputs[inputName] = [loadId, 0]
      } else {
        delete positive.inputs[inputName]
        delete workflow[loadId]
      }
    }
  }

  return workflow
}

async function waitForResult(promptId: string, signal: AbortSignal, timeoutMs = 10 * 60_000): Promise<HistoryImage> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    throwIfGenerationCanceled(signal)
    const response = await fetch(`${COMFY_URL}/history/${encodeURIComponent(promptId)}`, { signal })
    if (!response.ok) throw new Error(`History request failed (${response.status})`)
    const history = (await response.json()) as Record<string, {
      outputs?: Record<string, { images?: HistoryImage[] }>
      status?: { status_str?: string; completed?: boolean; messages?: unknown[] }
    }>
    const record = history[promptId]
    if (record) {
      for (const output of Object.values(record.outputs ?? {})) {
        if (output.images?.[0]) return output.images[0]
      }
      if (record.status?.completed || record.status?.status_str === 'error') {
        throw new Error('ComfyUI completed without an output image')
      }
    }
    await waitWithSignal(750, signal)
  }
  throw new Error('Image generation timed out')
}

function validateGenerateRequest(request: GenerateRequest): void {
  sessionDirectory(request.sessionId)
  if (!request.prompt.trim()) throw new Error('Connect a non-empty Prompt node')
  if (request.imagePaths.length !== 3 || request.imageSourceNodeIds.length !== 3) throw new Error('Image inputs must contain three slots')
  const { width, height, seed, steps, cfg } = request.settings
  if (!Number.isInteger(width) || width < 64 || width > 4096 || width % 8 !== 0) throw new Error('Width must be a multiple of 8 between 64 and 4096')
  if (!Number.isInteger(height) || height < 64 || height > 4096 || height % 8 !== 0) throw new Error('Height must be a multiple of 8 between 64 and 4096')
  if (!Number.isSafeInteger(seed) || seed < 0) throw new Error('Seed must be a non-negative safe integer')
  if (!Number.isInteger(steps) || steps < 1 || steps > 100) throw new Error('Steps must be an integer between 1 and 100')
  if (!Number.isFinite(cfg) || cfg < 0 || cfg > 100) throw new Error('CFG must be between 0 and 100')
}

async function runImageGeneration(job: GenerationJob): Promise<GeneratedImage> {
  const queuedRequest = job.request
  if (!(await isComfyReady())) throw new Error('ComfyUI is not ready')
  throwIfGenerationCanceled(job.controller.signal)
  const imagePaths = queuedRequest.imagePaths.map((path, index) => {
    const sourceNodeId = queuedRequest.imageSourceNodeIds[index]
    return sourceNodeId ? latestGenerationResultPaths.get(generationKey(queuedRequest.sessionId, sourceNodeId)) ?? path : path
  })
  for (let index = 0; index < imagePaths.length; index += 1) {
    if (queuedRequest.imageSourceNodeIds[index] && !imagePaths[index]) {
      throw new Error(`Connected generation node ${queuedRequest.imageSourceNodeIds[index]} did not produce an image`)
    }
  }
  const request: GenerateRequest = { ...queuedRequest, imagePaths }
  const connectedImageCount = imagePaths.filter((path): path is string => Boolean(path)).length
  let destination: string | null = null
  try {
    const workflowName = connectedImageCount > 0 ? 'Qwen-Rapid-AIO.json' : 'Qwen-Rapid-AIO-Generate.json'
    const workflowPath = join(projectRoot(), 'workflows', workflowName)
    const workflow = JSON.parse(await readFile(workflowPath, 'utf8')) as Workflow
    const uploads: Array<string | null> = []
    for (const imagePath of request.imagePaths) uploads.push(imagePath ? await uploadImage(imagePath, job.controller.signal) : null)
    throwIfGenerationCanceled(job.controller.signal)
    const prompt = applyRequest(workflow, request, uploads)
    const clientId = randomUUID()
    const response = await fetch(`${COMFY_URL}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, client_id: clientId })
    })
    if (!response.ok) {
      const detail = await response.text()
      throw new Error(`ComfyUI rejected the workflow (${response.status}): ${detail}`)
    }
    const queued = (await response.json()) as { prompt_id?: string; node_errors?: unknown }
    if (!queued.prompt_id) throw new Error(`ComfyUI did not return prompt_id: ${JSON.stringify(queued.node_errors ?? {})}`)
    job.promptId = queued.prompt_id
    if (job.controller.signal.aborted) {
      await cancelComfyPrompt(queued.prompt_id)
      throw new Error('Generation canceled')
    }

    const output = await waitForResult(queued.prompt_id, job.controller.signal)
    const query = new URLSearchParams({ filename: output.filename, subfolder: output.subfolder ?? '', type: output.type ?? 'output' })
    const imageResponse = await fetch(`${COMFY_URL}/view?${query.toString()}`, { signal: job.controller.signal })
    if (!imageResponse.ok) throw new Error(`Output download failed (${imageResponse.status})`)
    const bytes = Buffer.from(await imageResponse.arrayBuffer())
    throwIfGenerationCanceled(job.controller.signal)
    const extension = extname(output.filename) || '.png'
    destination = join(sessionAssetsDirectory(request.sessionId), `generated-${randomUUID()}${extension}`)
    pendingSessionAssets.set(assetPathKey(destination), Date.now())
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, bytes)
    const preview = await imagePreview(bytes, 768)
    throwIfGenerationCanceled(job.controller.signal)

    return {
      path: destination,
      name: basename(destination),
      dataUrl: preview.dataUrl,
      width: preview.width,
      height: preview.height,
      promptId: queued.prompt_id,
      seed: request.settings.seed
    }
  } catch (error) {
    if (destination) {
      pendingSessionAssets.delete(assetPathKey(destination))
      await rm(destination, { force: true })
    }
    if (job.controller.signal.aborted) throw new Error('Generation canceled')
    throw error
  }
}

async function processGenerationQueue(): Promise<void> {
  if (processingGenerationQueue) return
  processingGenerationQueue = true
  try {
    while (generationQueue.length > 0) {
      const key = generationQueue.shift()!
      const job = generationJobs.get(key)
      if (!job) continue
      if (job.controller.signal.aborted) {
        generationJobs.delete(key)
        job.reject(new Error('Generation canceled'))
        continue
      }

      job.state = 'running'
      const startedEvent: GenerationStartedEvent = {
        sessionId: job.request.sessionId,
        nodeId: job.request.nodeId,
        startedAtMs: Date.now()
      }
      mainWindow?.webContents.send('image:generation-started', startedEvent)
      try {
        const result = await runImageGeneration(job)
        if (!job.request.transient) latestGenerationResultPaths.set(key, result.path)
        job.resolve(result)
      } catch (error) {
        job.reject(error)
      } finally {
        if (generationJobs.get(key) === job) generationJobs.delete(key)
      }
    }
  } finally {
    processingGenerationQueue = false
  }
}

function enqueueImageGeneration(request: GenerateRequest): Promise<GeneratedImage> {
  validateGenerateRequest(request)
  const key = generationKey(request.sessionId, request.nodeId)
  if (generationJobs.has(key)) throw new Error('This node is already queued or generating an image')

  return new Promise<GeneratedImage>((resolve, reject) => {
    const job: GenerationJob = {
      controller: new AbortController(),
      promptId: null,
      request: structuredClone(request),
      state: 'queued',
      resolve,
      reject
    }
    generationJobs.set(key, job)
    generationQueue.push(key)
    void processGenerationQueue()
  })
}
async function cancelComfyPrompt(promptId: string): Promise<void> {
  try {
    const response = await fetch(`${COMFY_URL}/api/jobs/${encodeURIComponent(promptId)}/cancel`, { method: 'POST' })
    if (response.ok) return
  } catch {
    // Fall back to the legacy targeted queue/interrupt endpoints below.
  }
  await Promise.allSettled([
    fetch(`${COMFY_URL}/queue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delete: [promptId] })
    }),
    fetch(`${COMFY_URL}/interrupt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt_id: promptId })
    })
  ])
}

async function cancelSessionGenerations(sessionId: string): Promise<void> {
  for (const [key, job] of [...generationJobs]) {
    if (job.request.sessionId !== sessionId) continue
    job.controller.abort()
    if (job.state === 'queued') {
      const queueIndex = generationQueue.indexOf(key)
      if (queueIndex >= 0) generationQueue.splice(queueIndex, 1)
      generationJobs.delete(key)
      job.reject(new Error('Generation canceled'))
    } else if (job.promptId) {
      await cancelComfyPrompt(job.promptId)
    }
  }
  for (const key of [...latestGenerationResultPaths.keys()]) {
    if (key.startsWith(`${sessionId}:`)) latestGenerationResultPaths.delete(key)
  }
}

async function cancelGeneration(sessionId: string, nodeId: string): Promise<boolean> {
  sessionDirectory(sessionId)
  const key = generationKey(sessionId, nodeId)
  const job = generationJobs.get(key)
  if (!job) return false
  job.controller.abort()
  if (job.state === 'queued') {
    const queueIndex = generationQueue.indexOf(key)
    if (queueIndex >= 0) generationQueue.splice(queueIndex, 1)
    generationJobs.delete(key)
    job.reject(new Error('Generation canceled'))
    return true
  }
  if (job.promptId) await cancelComfyPrompt(job.promptId)
  return true
}

function resolveDescriptionImage(sessionId: string, sourcePath: string): string {
  const sessionRoot = resolve(sessionDirectory(sessionId))
  const target = resolveSessionAsset(sourcePath)
  if (!target.startsWith(`${sessionRoot}${sep}`)) throw new Error('画像が現在のセッション外にあります')
  return target
}

function stripThinkTags(value: string): string {
  return value
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/gi, '')
    .replace(/<\/think>/gi, '')
    .trimStart()
}

async function streamImageDescription(sender: Electron.WebContents, request: ImageDescribeRequest): Promise<void> {
  const controller = new AbortController()
  imageDescriptionControllers.set(request.descriptionId, controller)
  const eventBase = { descriptionId: request.descriptionId, sessionId: request.sessionId, nodeId: request.nodeId }
  try {
    const runtime = getLlamaServer().getChatRuntime()
    const imagePath = resolveDescriptionImage(request.sessionId, request.imagePath)
    const imageBytes = await sharp(imagePath)
      .rotate()
      .resize({ width: 1536, height: 1536, fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer()
    const dataUrl = `data:image/png;base64,${imageBytes.toString('base64')}`
    const response = await fetch(`${runtime.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'local-model',
        stream: true,
        temperature: runtime.temperature,
        max_tokens: runtime.maxTokens,
        messages: [
          { role: 'system', content: request.systemPrompt.trim() || DEFAULT_IMAGE_DESCRIBE_SYSTEM_PROMPT },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Create an image-generation prompt that accurately describes this image.' },
              { type: 'image_url', image_url: { url: dataUrl } }
            ]
          }
        ]
      }),
      signal: controller.signal
    })
    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => '')
      throw new Error(`Image Describeに失敗しました (${response.status})${detail ? `: ${detail}` : ''}`)
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let rawContent = ''
    const consumeLine = (line: string): void => {
      const normalized = line.trim()
      if (!normalized.startsWith('data:')) return
      const data = normalized.slice(5).trim()
      if (!data || data === '[DONE]') return
      const parsed = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> }
      const delta = parsed.choices?.[0]?.delta?.content ?? ''
      if (!delta) return
      rawContent += delta
      const payload: ImageDescribeStreamEvent = { ...eventBase, content: stripThinkTags(rawContent) }
      sender.send('llm:image-describe-delta', payload)
    }

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) consumeLine(line)
    }
    buffer += decoder.decode()
    if (buffer) consumeLine(buffer)
    const content = stripThinkTags(rawContent).trim()
    if (!content) throw new Error('Local LLMから説明テキストが返されませんでした')
    const payload: ImageDescribeStreamEvent = { ...eventBase, content }
    sender.send('llm:image-describe-done', payload)
  } catch (error) {
    const canceled = controller.signal.aborted
    const payload: ImageDescribeErrorEvent = {
      ...eventBase,
      message: canceled ? 'Image Describe canceled' : error instanceof Error ? error.message : String(error),
      canceled
    }
    sender.send('llm:image-describe-error', payload)
  } finally {
    imageDescriptionControllers.delete(request.descriptionId)
  }
}

async function streamTextTransformation(sender: Electron.WebContents, request: TextTransformRequest): Promise<void> {
  const controller = new AbortController()
  textTransformationControllers.set(request.transformationId, controller)
  const eventBase = { transformationId: request.transformationId, sessionId: request.sessionId, nodeId: request.nodeId }
  try {
    const instruction = request.instruction.trim()
    if (!instruction) throw new Error('加工指示を入力してください')
    const runtime = getLlamaServer().getChatRuntime()
    const sourceText = request.sourceText.trim()
    const userMessage = sourceText
      ? `Transformation instruction:\n<instruction>\n${instruction}\n</instruction>\n\nSource text:\n<source_text>\n${sourceText}\n</source_text>\n\nReturn the complete transformed text only.`
      : `Transformation instruction:\n<instruction>\n${instruction}\n</instruction>\n\nThere is no source text. Create the requested text and return only the finished result.`
    const response = await fetch(`${runtime.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'local-model',
        stream: true,
        temperature: runtime.temperature,
        max_tokens: runtime.maxTokens,
        messages: [
          { role: 'system', content: request.systemPrompt.trim() || DEFAULT_TEXT_TRANSFORM_SYSTEM_PROMPT },
          { role: 'user', content: userMessage }
        ]
      }),
      signal: controller.signal
    })
    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => '')
      throw new Error(`Text Transformに失敗しました (${response.status})${detail ? `: ${detail}` : ''}`)
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let rawContent = ''
    const consumeLine = (line: string): void => {
      const normalized = line.trim()
      if (!normalized.startsWith('data:')) return
      const data = normalized.slice(5).trim()
      if (!data || data === '[DONE]') return
      const parsed = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> }
      const delta = parsed.choices?.[0]?.delta?.content ?? ''
      if (!delta) return
      rawContent += delta
      const payload: TextTransformStreamEvent = { ...eventBase, content: stripThinkTags(rawContent) }
      sender.send('llm:text-transform-delta', payload)
    }

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) consumeLine(line)
    }
    buffer += decoder.decode()
    if (buffer) consumeLine(buffer)
    const content = stripThinkTags(rawContent).trim()
    if (!content) throw new Error('Local LLMから変換テキストが返されませんでした')
    const payload: TextTransformStreamEvent = { ...eventBase, content }
    sender.send('llm:text-transform-done', payload)
  } catch (error) {
    const canceled = controller.signal.aborted
    const payload: TextTransformErrorEvent = {
      ...eventBase,
      message: canceled ? 'Text Transform canceled' : error instanceof Error ? error.message : String(error),
      canceled
    }
    sender.send('llm:text-transform-error', payload)
  } finally {
    textTransformationControllers.delete(request.transformationId)
  }
}

function registerIpc(): void {
  ipcMain.handle('comfy:status', () => comfyStatus)
  ipcMain.handle('comfy:start', async (): Promise<ComfyStatus> => {
    await startComfyUI()
    return comfyStatus
  })
  ipcMain.handle('comfy:stop', async (): Promise<ComfyStatus> => {
    await stopComfyUI()
    return comfyStatus
  })
  ipcMain.handle('llm:status', (): LlmStatus => getLlamaServer().getStatus())
  ipcMain.handle('llm:load', () => getLlamaServer().load())
  ipcMain.handle('llm:stop', () => getLlamaServer().stop())
  ipcMain.handle('llm:rescan', (): LlmStatus => {
    const status = getLlamaServer().rescan()
    llmConfig = getLlamaServer().getConfig()
    void saveAppSettings()
    return status
  })
  ipcMain.handle('llm:update-config', async (_event, patch: Partial<LlmConfig>): Promise<LlmStatus> => {
    const status = getLlamaServer().updateConfig(patch)
    llmConfig = getLlamaServer().getConfig()
    await saveAppSettings()
    return status
  })
  ipcMain.handle('llm:reveal', (_event, location: 'models' | 'server' | 'logs') => revealLlmLocation(location))
  ipcMain.handle('llm:image-describe', (event, request: ImageDescribeRequest): void => {
    if (imageDescriptionControllers.has(request.descriptionId)) throw new Error('Image Describeはすでに実行中です')
    void streamImageDescription(event.sender, request)
  })
  ipcMain.handle('llm:image-describe-cancel', (_event, descriptionId: string): boolean => {
    const controller = imageDescriptionControllers.get(descriptionId)
    if (!controller) return false
    controller.abort()
    return true
  })
  ipcMain.handle('llm:text-transform', (event, request: TextTransformRequest): void => {
    if (textTransformationControllers.has(request.transformationId)) throw new Error('Text Transformはすでに実行中です')
    void streamTextTransformation(event.sender, request)
  })
  ipcMain.handle('llm:text-transform-cancel', (_event, transformationId: string): boolean => {
    const controller = textTransformationControllers.get(transformationId)
    if (!controller) return false
    controller.abort()
    return true
  })
  ipcMain.handle('library:bootstrap', () => buildLibraryBootstrap())
  ipcMain.handle('library:choose', async (): Promise<LibraryBootstrap | null> => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    if (result.canceled || !result.filePaths[0]) return null
    return changeLibrary(result.filePaths[0])
  })
  ipcMain.handle('library:recent', (): string[] => libraryHistory.filter((path) => assetPathKey(path) !== assetPathKey(libraryRoot)))
  ipcMain.handle('library:open', (_event, rootPath: string): Promise<LibraryBootstrap> => {
    if (typeof rootPath !== 'string' || !rootPath.trim()) throw new Error('Invalid library folder path')
    return changeLibrary(rootPath)
  })
  ipcMain.handle('session:create', async (_event, name: string) => {
    const session = await createSession(name)
    return { session, sessions: await listSessions(), snapshot: emptySnapshot() }
  })
  ipcMain.handle('session:rename', async (_event, sessionId: string, name: string) => {
    const session = await renameSession(sessionId, name)
    return { session, sessions: await listSessions() }
  })
  ipcMain.handle('session:duplicate', async (_event, sessionId: string) => {
    const duplicated = await duplicateSession(sessionId)
    return { ...duplicated, sessions: await listSessions() }
  })
  ipcMain.handle('session:load', async (_event, sessionId: string) => {
    const loaded = await readSession(sessionId)
    return { session: loaded.session, snapshot: loaded.snapshot }
  })
  ipcMain.handle('session:save', (_event, sessionId: string, snapshot: SessionSnapshot) => saveSession(sessionId, snapshot))
  ipcMain.handle('session:copy-assets', (_event, sourceSessionId: string, targetSessionId: string, sourcePaths: string[]) => copySessionAssets(sourceSessionId, targetSessionId, sourcePaths))
  ipcMain.handle('session:delete', async (_event, sessionId: string): Promise<LibraryBootstrap> => {
    await cancelSessionGenerations(sessionId)
    await rm(sessionDirectory(sessionId), { recursive: true, force: true })
    return buildLibraryBootstrap()
  })
  ipcMain.handle('batch:choose-folder', () => chooseBatchDirectory())
  ipcMain.handle('batch:prepare', (_event, inputDirectory: string) => prepareBatchDirectory(inputDirectory))
  ipcMain.handle('batch:save-image', (_event, sessionId: string, generated: GeneratedImage, inputPath: string, outputDirectory: string, index: number) => saveBatchGeneratedImage(sessionId, generated, inputPath, outputDirectory, index))
  ipcMain.handle('batch:write-manifest', (_event, outputDirectory: string, manifest: BatchManifest) => writeBatchManifest(outputDirectory, manifest))
  ipcMain.handle('batch:reveal-output', (_event, outputDirectory: string) => revealBatchOutput(outputDirectory))
  ipcMain.handle('image:choose', async (_event, sessionId: string): Promise<ImageAsset | null> => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }]
    })
    if (result.canceled || !result.filePaths[0]) return null
    return importImage(result.filePaths[0], sessionId)
  })
  ipcMain.handle('image:import', (_event, sourcePath: string, sessionId: string) => importImage(sourcePath, sessionId))
  ipcMain.handle('image:generate', (_event, request: GenerateRequest) => enqueueImageGeneration(request))
  ipcMain.handle('image:cancel-generation', (_event, sessionId: string, nodeId: string) => cancelGeneration(sessionId, nodeId))
  ipcMain.handle('image:copy', (_event, sourcePath: string) => copyImageToClipboard(sourcePath))
  ipcMain.handle('image:save-copy', (_event, sourcePath: string) => saveImageCopy(sourcePath))
  ipcMain.handle('screenshot:capture', () => captureScreenshot())
  ipcMain.handle('screenshot:reveal', (_event, sourcePath: string) => revealScreenshot(sourcePath))
}

if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  app.whenReady().then(async () => {
    await loadLibraryRoot()
    llamaServer = new LlamaServerManager(projectRoot(), llmConfig, (status) => {
      mainWindow?.webContents.send('llm:status-changed', status)
    }, join(dataRoot(), 'logs'))
    llmConfig = llamaServer.getConfig()
    await saveAppSettings()
    registerIpc()
    createWindow()
    startSystemResourcePolling()
    void startComfyUI()
  })

  app.on('before-quit', () => {
    isQuitting = true
    stopSystemResourcePolling()
    for (const controller of imageDescriptionControllers.values()) controller.abort()
    imageDescriptionControllers.clear()
    for (const controller of textTransformationControllers.values()) controller.abort()
    textTransformationControllers.clear()
    void stopComfyUI()
    void llamaServer?.stop()
  })

  app.on('window-all-closed', () => app.quit())
}
