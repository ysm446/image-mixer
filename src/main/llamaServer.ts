import { spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { createServer } from 'node:net'
import { basename, dirname, join, relative, resolve } from 'node:path'
import type { LlmConfig, LlmModelOption, LlmStatus } from './types'

const DEFAULT_PORT = 8190

export const DEFAULT_LLM_CONFIG: LlmConfig = {
  selectedModelPath: '',
  contextLength: 8192,
  temperature: 0.3,
  maxTokens: 1024,
  idleUnloadMinutes: 0,
  gpuLayers: 999,
  flashAttention: true,
  mmprojOffload: true
}

type StatusListener = (status: LlmStatus) => void

export class LlamaServerManager {
  private process: ChildProcess | null = null
  private stopRequested = false
  private phase: LlmStatus['phase'] = 'stopped'
  private message = 'Local LLM is unloaded'
  private loadedModelPath: string | null = null
  private activePort: number | null = null
  private restartRequired = false
  private config: LlmConfig

  constructor(
    private readonly rootDir: string,
    initialConfig: Partial<LlmConfig>,
    private readonly onStatus: StatusListener,
    private readonly logDir: string
  ) {
    this.config = normalizeConfig(initialConfig)
    this.ensureSelectedModel()
  }

  getStatus(): LlmStatus {
    const models = this.listModels()
    const serverPath = findServerPath(this.rootDir)
    return {
      phase: this.phase,
      message: this.message,
      managed: this.process !== null,
      models,
      config: { ...this.config },
      loadedModelPath: this.loadedModelPath,
      serverPath,
      activePort: this.activePort,
      restartRequired: this.restartRequired
    }
  }

  getConfig(): LlmConfig {
    return { ...this.config }
  }

  getChatRuntime(): { baseUrl: string; temperature: number; maxTokens: number } {
    if (this.phase !== 'ready' || !this.activePort || this.restartRequired) {
      throw new Error(this.restartRequired ? 'Local LLMを再ロードしてください' : 'Local LLMをロードしてください')
    }
    return {
      baseUrl: `http://127.0.0.1:${this.activePort}`,
      temperature: this.config.temperature,
      maxTokens: this.config.maxTokens
    }
  }

  updateConfig(patch: Partial<LlmConfig>): LlmStatus {
    const previous = this.config
    this.config = normalizeConfig({ ...this.config, ...patch })
    this.ensureSelectedModel()
    if (this.phase === 'ready') {
      this.restartRequired = runtimeConfigChanged(previous, this.config) || this.loadedModelPath !== this.config.selectedModelPath
      this.message = this.restartRequired ? '設定を反映するには再ロードしてください' : 'Local LLM is ready'
    }
    return this.emit()
  }

  rescan(): LlmStatus {
    this.ensureSelectedModel()
    return this.emit()
  }

  async load(): Promise<LlmStatus> {
    if (this.phase === 'loading' || this.phase === 'unloading') return this.getStatus()
    const serverPath = findServerPath(this.rootDir)
    if (!serverPath) return this.fail('runtime/llama-server に llama-server.exe が見つかりません')
    const model = this.listModels().find((entry) => resolve(entry.path) === resolve(this.config.selectedModelPath))
    if (!model) return this.fail('models/ にロード可能なGGUFモデルが見つかりません')

    if (this.process) await this.stop()
    this.phase = 'loading'
    this.message = `${model.name} をロード中…`
    this.restartRequired = false
    this.emit()

    try {
      this.activePort = await findAvailablePort(DEFAULT_PORT)
      mkdirSync(this.logDir, { recursive: true })
      const log = createWriteStream(join(this.logDir, 'llama-server.log'), { flags: 'a' })
      const args = [
        '--host', '127.0.0.1',
        '--port', String(this.activePort),
        '--model', model.path,
        '--alias', 'local-model',
        '--ctx-size', String(this.config.contextLength),
        '--n-gpu-layers', String(this.config.gpuLayers),
        '--flash-attn', this.config.flashAttention ? 'on' : 'off',
        '--reasoning', 'off',
        '--reasoning-format', 'none'
      ]
      if (model.mmprojPath) args.push('--mmproj', model.mmprojPath)
      if (model.mmprojPath && !this.config.mmprojOffload) args.push('--no-mmproj-offload')
      if (this.config.idleUnloadMinutes > 0) args.push('--sleep-idle-seconds', String(this.config.idleUnloadMinutes * 60))

      const child = spawn(serverPath, args, {
        cwd: dirname(serverPath),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      this.process = child
      child.stdout?.pipe(log, { end: false })
      child.stderr?.pipe(log, { end: false })
      child.once('error', (error) => {
        if (this.process === child) this.process = null
        log.end()
        this.fail(`llama-serverの起動に失敗しました: ${error.message}`)
      })
      child.once('exit', (code) => {
        if (this.process === child) this.process = null
        const requested = this.stopRequested
        this.stopRequested = false
        this.loadedModelPath = null
        this.activePort = null
        log.end()
        if (requested) return
        this.phase = code === 0 ? 'stopped' : 'error'
        this.message = code === 0 ? 'Local LLM is unloaded' : `llama-serverが終了しました (${code ?? 'unknown'})`
        this.emit()
      })

      const ready = await this.waitForHealthy(120_000)
      if (!ready) {
        if (this.process === child) await this.stop()
        return this.fail('Local LLMのロードがタイムアウトしました。ログを確認してください')
      }
      this.loadedModelPath = model.path
      this.phase = 'ready'
      this.message = 'Local LLM is ready'
      this.restartRequired = false
      return this.emit()
    } catch (error) {
      return this.fail(error instanceof Error ? error.message : String(error))
    }
  }

  async stop(): Promise<LlmStatus> {
    const child = this.process
    if (!child) {
      this.phase = 'stopped'
      this.message = 'Local LLM is unloaded'
      this.loadedModelPath = null
      this.activePort = null
      this.restartRequired = false
      return this.emit()
    }

    this.stopRequested = true
    this.phase = 'unloading'
    this.message = 'Local LLMをアンロード中…'
    this.emit()
    const exited = await waitForExit(child, 5_000, () => child.kill())
    if (!exited && child.pid) {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
      await waitForExit(killer, 5_000)
    }
    if (this.process === child) this.process = null
    this.stopRequested = false
    this.phase = 'stopped'
    this.message = 'Local LLM is unloaded'
    this.loadedModelPath = null
    this.activePort = null
    this.restartRequired = false
    return this.emit()
  }

  private listModels(): LlmModelOption[] {
    const modelsDir = join(this.rootDir, 'models')
    if (!existsSync(modelsDir)) return []
    return walkFiles(modelsDir)
      .filter((file) => file.toLowerCase().endsWith('.gguf') && !/mmproj/i.test(basename(file)))
      .map((file) => ({
        path: file,
        name: relative(modelsDir, file).replace(/\\/g, '/'),
        sizeBytes: statSync(file).size,
        mmprojPath: findMmproj(file)
      }))
      .sort((left, right) => left.name.localeCompare(right.name))
  }

  private ensureSelectedModel(): void {
    const models = this.listModels()
    if (!models.some((model) => resolve(model.path) === resolve(this.config.selectedModelPath))) {
      this.config.selectedModelPath = models[0]?.path ?? ''
    }
  }

  private async isHealthy(): Promise<boolean> {
    if (!this.activePort) return false
    try {
      const response = await fetch(`http://127.0.0.1:${this.activePort}/health`, { signal: AbortSignal.timeout(1_500) })
      return response.ok
    } catch {
      return false
    }
  }

  private async waitForHealthy(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline && this.process) {
      if (await this.isHealthy()) return true
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 500))
    }
    return false
  }

  private fail(message: string): LlmStatus {
    this.phase = 'error'
    this.message = message
    this.loadedModelPath = null
    this.restartRequired = false
    return this.emit()
  }

  private emit(): LlmStatus {
    const status = this.getStatus()
    this.onStatus(status)
    return status
  }
}

function normalizeConfig(input: Partial<LlmConfig>): LlmConfig {
  return {
    selectedModelPath: typeof input.selectedModelPath === 'string' ? input.selectedModelPath : '',
    contextLength: clampInteger(input.contextLength, 512, 262144, DEFAULT_LLM_CONFIG.contextLength),
    temperature: clampNumber(input.temperature, 0, 2, DEFAULT_LLM_CONFIG.temperature),
    maxTokens: clampInteger(input.maxTokens, 1, 32768, DEFAULT_LLM_CONFIG.maxTokens),
    idleUnloadMinutes: clampInteger(input.idleUnloadMinutes, 0, 1440, DEFAULT_LLM_CONFIG.idleUnloadMinutes),
    gpuLayers: clampInteger(input.gpuLayers, 0, 999, DEFAULT_LLM_CONFIG.gpuLayers),
    flashAttention: input.flashAttention ?? DEFAULT_LLM_CONFIG.flashAttention,
    mmprojOffload: input.mmprojOffload ?? DEFAULT_LLM_CONFIG.mmprojOffload
  }
}

function runtimeConfigChanged(left: LlmConfig, right: LlmConfig): boolean {
  return left.selectedModelPath !== right.selectedModelPath ||
    left.contextLength !== right.contextLength ||
    left.idleUnloadMinutes !== right.idleUnloadMinutes ||
    left.gpuLayers !== right.gpuLayers ||
    left.flashAttention !== right.flashAttention ||
    left.mmprojOffload !== right.mmprojOffload
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === 'number' ? Math.round(value) : Number.NaN
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number.NaN
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback
}

function findMmproj(modelPath: string): string | null {
  const files = walkFiles(dirname(modelPath))
    .filter((file) => file.toLowerCase().endsWith('.gguf') && /mmproj/i.test(basename(file)))
    .sort((left, right) => basename(left).localeCompare(basename(right)))
  return files[0] ?? null
}

function findServerPath(rootDir: string): string | null {
  const serverRoot = join(rootDir, 'runtime', 'llama-server')
  if (!existsSync(serverRoot)) return null
  const candidates = walkFiles(serverRoot, 2)
    .filter((file) => basename(file).toLowerCase() === 'llama-server.exe')
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)
  return candidates[0] ?? null
}

function walkFiles(directory: string, depth = Number.POSITIVE_INFINITY): string[] {
  if (!existsSync(directory)) return []
  const files: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory() && depth > 0) files.push(...walkFiles(path, depth - 1))
    else if (entry.isFile()) files.push(path)
  }
  return files
}

function findAvailablePort(startPort: number): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const tryPort = (port: number): void => {
      const server = createServer()
      server.once('error', () => {
        if (port >= startPort + 20) rejectPort(new Error('Local LLM用の空きポートが見つかりません'))
        else tryPort(port + 1)
      })
      server.listen(port, '127.0.0.1', () => server.close(() => resolvePort(port)))
    }
    tryPort(startPort)
  })
}

function waitForExit(child: ChildProcess, timeoutMs: number, initiate?: () => void): Promise<boolean> {
  return new Promise((resolveExit) => {
    if (child.exitCode !== null || child.killed) {
      resolveExit(true)
      return
    }
    const timeout = setTimeout(() => resolveExit(false), timeoutMs)
    child.once('exit', () => {
      clearTimeout(timeout)
      resolveExit(true)
    })
    initiate?.()
  })
}
