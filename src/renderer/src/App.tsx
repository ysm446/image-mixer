import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  addEdge,
  Background,
  BackgroundVariant,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeProps
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { ComfyStatus, GeneratedImage, GenerateSettings, ImageAsset, LibraryBootstrap, LibraryInfo, SessionRecord, SessionSnapshot } from '../../main/types'
import { SystemResourceMonitor } from './SystemResourceMonitor'

type RenderState = 'idle' | 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled'

const MIN_IMAGE_DIMENSION = 64
const MAX_IMAGE_DIMENSION = 4096
const IMAGE_DIMENSION_STEP = 8

function normalizeImageDimension(value: number): number {
  if (!Number.isFinite(value)) return MIN_IMAGE_DIMENSION
  const rounded = Math.round(value / IMAGE_DIMENSION_STEP) * IMAGE_DIMENSION_STEP
  return Math.min(MAX_IMAGE_DIMENSION, Math.max(MIN_IMAGE_DIMENSION, rounded))
}

function imageMediaSize(width: number | undefined, height: number | undefined, fallback: { width: number; height: number }): { width: number; height: number } {
  if (!width || !height || !Number.isFinite(width) || !Number.isFinite(height)) return fallback
  const aspectRatio = width / height
  return aspectRatio >= 1
    ? { width: 360, height: Math.max(120, 360 / aspectRatio) }
    : { width: Math.max(240, 360 * aspectRatio), height: 360 }
}

type PromptData = {
  kind: 'prompt'
  title: string
  text: string
}

type ImageData = {
  kind: 'image'
  title: string
  image: ImageAsset | null
}

type GenerateData = {
  kind: 'generate'
  title: string
  settings: GenerateSettings
  matchImage1Size?: boolean
  state: RenderState
  result: GeneratedImage | null
  error: string | null
  durationMs?: number | null
  startedAtMs?: number | null
}

type EditorData = (PromptData | ImageData | GenerateData) & Record<string, unknown>
type EditorNode = Node<EditorData, 'editor'>
type EditorEdge = Edge

type NodeClipboard = {
  sessionId: string
  nodes: EditorNode[]
  edges: EditorEdge[]
  boundsCenter: { x: number; y: number }
  pasteCount: number
}

type EditorActions = {
  comfyReady: boolean
  hasImageInput: (nodeId: string) => boolean
  updateNode: (nodeId: string, patch: Partial<EditorData>) => void
  chooseImage: (nodeId: string) => Promise<void>
  dropImage: (nodeId: string, file: File) => Promise<void>
  generate: (nodeId: string) => Promise<void>
  cancelGeneration: (nodeId: string) => Promise<void>
  copyResult: (nodeId: string) => Promise<boolean>
  saveResult: (nodeId: string) => Promise<boolean>
  previewResult: (image: ImageAsset) => void
}

const EditorContext = createContext<EditorActions | null>(null)

function useEditor(): EditorActions {
  const value = useContext(EditorContext)
  if (!value) throw new Error('Editor context is missing')
  return value
}

type EditableNodeTitleProps = {
  title: string
  ariaLabel: string
  onCommit: (title: string) => void
}

function EditableNodeTitle({ title, ariaLabel, onCommit }: EditableNodeTitleProps): React.JSX.Element {
  const [isEditing, setIsEditing] = useState(false)
  const [draft, setDraft] = useState(title)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const isComposing = useRef(false)

  useEffect(() => {
    if (!isEditing) setDraft(title)
  }, [isEditing, title])

  useLayoutEffect(() => {
    if (!isEditing) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [isEditing])

  const commit = (): void => {
    onCommit(draft)
    setIsEditing(false)
  }

  if (isEditing) {
    return (
      <div className='node-title-row'>
        <input
          ref={inputRef}
          className='node-title nodrag nopan'
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onCompositionStart={() => { isComposing.current = true }}
          onCompositionEnd={() => { isComposing.current = false }}
          onKeyDown={(event) => {
            event.stopPropagation()
            if (event.key === 'Enter' && !isComposing.current) {
              event.preventDefault()
              commit()
            } else if (event.key === 'Escape') {
              event.preventDefault()
              setDraft(title)
              setIsEditing(false)
            }
          }}
          onKeyUp={(event) => event.stopPropagation()}
          aria-label={ariaLabel}
        />
      </div>
    )
  }

  return (
    <div className='node-title-row'>
      <div className='node-title-display' title={title}>{title || 'Untitled'}</div>
      <button
        type='button'
        className='node-title-edit nodrag nopan'
        title='タイトルを編集'
        aria-label={`${ariaLabel}を編集`}
        onClick={() => setIsEditing(true)}
      >
        <svg viewBox='0 0 24 24' aria-hidden='true'><path d='m4 16-.8 4.8L8 20l10.7-10.7-4-4L4 16Z' /><path d='m13.5 6.5 4 4' /></svg>
      </button>
    </div>
  )
}

function PromptNode({ id, data, selected }: NodeProps<EditorNode>): React.JSX.Element {
  const { updateNode } = useEditor()
  const prompt = data as PromptData
  const [draftText, setDraftText] = useState(prompt.text)
  const isTextComposing = useRef(false)
  const textAreaRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    if (!isTextComposing.current) setDraftText(prompt.text)
  }, [prompt.text])

  useLayoutEffect(() => {
    const editor = textAreaRef.current
    if (!editor) return
    editor.style.height = 'auto'
    const borderHeight = editor.offsetHeight - editor.clientHeight
    editor.style.height = `${Math.max(150, editor.scrollHeight + borderHeight)}px`
  }, [draftText])

  return (
    <article className={`node-card prompt-node ${selected ? 'selected' : ''}`}>
      <div className='node-kicker'>PROMPT</div>
      <EditableNodeTitle title={prompt.title} ariaLabel='Prompt node title' onCommit={(title) => updateNode(id, { title })} />
      <textarea
        ref={textAreaRef}
        className='prompt-editor nodrag nopan nowheel'
        value={draftText}
        onChange={(event) => {
          setDraftText(event.target.value)
          if (!isTextComposing.current) updateNode(id, { text: event.target.value })
        }}
        onCompositionStart={() => { isTextComposing.current = true }}
        onCompositionEnd={(event) => {
          isTextComposing.current = false
          setDraftText(event.currentTarget.value)
          updateNode(id, { text: event.currentTarget.value })
        }}
        onKeyDown={(event) => event.stopPropagation()}
        onKeyUp={(event) => event.stopPropagation()}
        placeholder='Describe how the connected images should be combined or edited…'
      />
      <p className='node-hint'>ローカルLLMによる補助は次のフェーズで追加予定</p>
      <Handle type='source' position={Position.Right} id='prompt' className='handle prompt-handle' />
    </article>
  )
}

function ImageNode({ id, data, selected }: NodeProps<EditorNode>): React.JSX.Element {
  const { updateNode, chooseImage, dropImage, previewResult } = useEditor()
  const imageData = data as ImageData
  const [isDragging, setIsDragging] = useState(false)
  const hasSize = Boolean(imageData.image?.width && imageData.image?.height)
  const mediaSize = imageMediaSize(imageData.image?.width, imageData.image?.height, { width: 250, height: 180 })
  const mediaWidth = mediaSize.width
  const mediaHeight = mediaSize.height
  return (
    <article className={`node-card image-node ${selected ? 'selected' : ''}`} style={{ width: mediaWidth + 30 }}>
      <div className='node-kicker'>IMAGE</div>
      <EditableNodeTitle title={imageData.title} ariaLabel='Image node title' onCommit={(title) => updateNode(id, { title })} />
      <div
        className={`image-picker nodrag ${imageData.image ? 'has-image' : 'is-empty'} ${isDragging ? 'is-dragging' : ''}`}
        style={{ height: mediaHeight }}
        onDragEnter={(event) => { event.preventDefault(); setIsDragging(true) }}
        onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' }}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as globalThis.Node | null)) setIsDragging(false) }}
        onDrop={(event) => {
          event.preventDefault()
          event.stopPropagation()
          setIsDragging(false)
          const file = event.dataTransfer.files[0]
          if (file) void dropImage(id, file)
        }}
      >
        {imageData.image ? (
          <>
            <button
              type='button'
              className='image-node-preview nodrag'
              title='クリックして拡大表示'
              aria-label={`${imageData.title}を拡大表示`}
              onClick={() => previewResult(imageData.image!)}
            >
              <img src={imageData.image.dataUrl} alt={imageData.title} draggable={false} />
            </button>
            <button
              type='button'
              className='image-replace-button nodrag'
              title='画像を変更'
              aria-label={`${imageData.title}の画像を変更`}
              onClick={() => void chooseImage(id)}
            >
              <svg viewBox='0 0 24 24' aria-hidden='true'>
                <path d='M4 5h16v14H4z' />
                <path d='m6 16 4-4 3 3 2-2 3 3' />
                <path d='M16 8h4M18 6v4' />
              </svg>
            </button>
          </>
        ) : (
          <button type='button' className='image-empty-picker nodrag' onClick={() => void chooseImage(id)}>
            <span>画像を選択<br /><small>またはここへドロップ</small></span>
          </button>
        )}
      </div>
      <div className='image-meta'>
        <span className='image-name'>{imageData.image?.name ?? 'PNG / JPG / WEBP'}</span>
        {hasSize && <strong>{imageData.image!.width} × {imageData.image!.height}</strong>}
      </div>
      <Handle type='source' position={Position.Right} id='image' className='handle image-handle' />
    </article>
  )
}

function NumberField({
  label,
  value,
  min,
  max,
  step,
  onChange,
  onRandomize,
  normalize
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (value: number) => void
  onRandomize?: () => void
  normalize?: (value: number) => number
}): React.JSX.Element {
  return (
    <div className='setting-field'>
      <span>{label}</span>
      <div className='setting-input-row'>
        <input
          className='nodrag'
          type='number'
          value={value}
          min={min}
          max={max}
          step={step}
          aria-label={label}
          onChange={(event) => onChange(Number(event.target.value))}
          onBlur={() => {
            if (!normalize) return
            const normalized = normalize(value)
            if (normalized !== value) onChange(normalized)
          }}
        />
        {onRandomize && (
          <button type='button' className='setting-random-button nodrag' title='Seedをランダム化' aria-label='Seedをランダム化' onClick={onRandomize}>
            <svg viewBox='0 0 24 24' aria-hidden='true'>
              <rect x='4' y='4' width='16' height='16' rx='3' />
              <circle cx='9' cy='9' r='1' />
              <circle cx='15' cy='9' r='1' />
              <circle cx='12' cy='12' r='1' />
              <circle cx='9' cy='15' r='1' />
              <circle cx='15' cy='15' r='1' />
            </svg>
          </button>
        )}
      </div>
    </div>
  )
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return `${durationMs} ms`
  const totalSeconds = Math.round(durationMs / 1000)
  if (totalSeconds < 60) return `${(durationMs / 1000).toFixed(durationMs < 10_000 ? 1 : 0)} 秒`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes} 分 ${seconds} 秒`
}

function GenerateNode({ id, data, selected }: NodeProps<EditorNode>): React.JSX.Element {
  const { comfyReady, hasImageInput, updateNode, generate, cancelGeneration, copyResult, saveResult, previewResult } = useEditor()
  const generateData = data as GenerateData
  const imageEditingMode = hasImageInput(id)
  const [resultNotice, setResultNotice] = useState<string | null>(null)
  const [runningDurationMs, setRunningDurationMs] = useState(0)
  const previewWidth = generateData.result?.width ?? generateData.settings.width
  const previewHeight = generateData.result?.height ?? generateData.settings.height
  const resultMediaSize = imageMediaSize(previewWidth, previewHeight, { width: 349, height: 245 })
  const resultMediaWidth = resultMediaSize.width
  const resultMediaHeight = resultMediaSize.height
  const setSetting = (key: keyof GenerateSettings, value: number): void => {
    updateNode(id, { settings: { ...generateData.settings, [key]: value } })
  }
  useEffect(() => {
    if (!resultNotice) return
    const timer = setTimeout(() => setResultNotice(null), 1800)
    return () => clearTimeout(timer)
  }, [resultNotice])
  useEffect(() => {
    if (generateData.state !== 'running' || generateData.startedAtMs == null) return
    const updateDuration = (): void => setRunningDurationMs(Math.max(0, Date.now() - generateData.startedAtMs!))
    updateDuration()
    const timer = window.setInterval(updateDuration, 100)
    return () => window.clearInterval(timer)
  }, [generateData.startedAtMs, generateData.state])
  const displayedDurationMs = generateData.state === 'running' ? runningDurationMs : generateData.durationMs
  return (
    <article className={`node-card generate-node ${selected ? 'selected' : ''}`} style={{ width: resultMediaWidth + 30 }}>
      <div className='node-kicker'>{imageEditingMode ? 'IMAGE EDIT' : 'IMAGE GENERATE'}</div>
      <EditableNodeTitle title={generateData.title} ariaLabel='Image Generate node title' onCommit={(title) => updateNode(id, { title })} />

      <div className='pin-label prompt-pin-label'>Prompt</div>
      <Handle type='target' position={Position.Left} id='prompt' className='handle prompt-handle pin-prompt' />
      {[1, 2, 3].map((index) => (
        <div className={`pin-label image-pin-label pin-label-${index}`} key={index}>Image {index}</div>
      ))}
      <Handle type='target' position={Position.Left} id='image1' className='handle image-handle pin-image-1' />
      <Handle type='target' position={Position.Left} id='image2' className='handle image-handle pin-image-2' />
      <Handle type='target' position={Position.Left} id='image3' className='handle image-handle pin-image-3' />

      <div className='settings-grid'>
        <div className='size-settings-row'>
          <NumberField label='Width' value={generateData.settings.width} min={MIN_IMAGE_DIMENSION} max={MAX_IMAGE_DIMENSION} step={IMAGE_DIMENSION_STEP} normalize={normalizeImageDimension} onChange={(value) => setSetting('width', value)} />
          <NumberField label='Height' value={generateData.settings.height} min={MIN_IMAGE_DIMENSION} max={MAX_IMAGE_DIMENSION} step={IMAGE_DIMENSION_STEP} normalize={normalizeImageDimension} onChange={(value) => setSetting('height', value)} />
        </div>
        <label className='match-size-toggle nodrag nopan'>
          <input
            type='checkbox'
            checked={Boolean(generateData.matchImage1Size)}
            onChange={(event) => updateNode(id, { matchImage1Size: event.target.checked })}
          />
          <span>Generate時にImage 1のサイズへ合わせる</span>
        </label>
        <NumberField
          label='Seed'
          value={generateData.settings.seed}
          min={0}
          max={2147483647}
          step={1}
          onChange={(value) => setSetting('seed', value)}
          onRandomize={() => setSetting('seed', crypto.getRandomValues(new Uint32Array(1))[0] % 2147483648)}
        />
        <NumberField label='Steps' value={generateData.settings.steps} min={1} max={100} step={1} onChange={(value) => setSetting('steps', value)} />
        <NumberField label='CFG' value={generateData.settings.cfg} min={0} max={100} step={0.1} onChange={(value) => setSetting('cfg', value)} />
      </div>

      <div className='result-frame' style={{ height: resultMediaHeight }}>
        {generateData.result ? (
          <>
            <button
              type='button'
              className='result-preview-button nodrag'
              title='クリックして拡大表示'
              aria-label='生成画像を拡大表示'
              onClick={() => previewResult(generateData.result!)}
            >
              <img src={generateData.result.dataUrl} alt='Generated result' draggable={false} />
            </button>
            <div className='result-actions nodrag'>
              <button type='button' title='画像をコピー' aria-label='画像をコピー' onClick={() => void copyResult(id).then((copied) => { if (copied) setResultNotice('コピーしました') })}>
                <svg viewBox='0 0 24 24' aria-hidden='true'><rect x='8' y='8' width='11' height='11' rx='2' /><path d='M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2' /></svg>
              </button>
              <button type='button' title='画像を保存' aria-label='画像を保存' onClick={() => void saveResult(id).then((saved) => { if (saved) setResultNotice('保存しました') })}>
                <svg viewBox='0 0 24 24' aria-hidden='true'><path d='M12 3v12m0 0 5-5m-5 5-5-5' /><path d='M5 20h14' /></svg>
              </button>
            </div>
            {resultNotice && <div className='result-action-notice'>{resultNotice}</div>}
          </>
        ) : (
          <div className='result-placeholder'>{generateData.state === 'running' ? <span className='spinner' /> : generateData.state === 'queued' ? 'Queued' : 'Generated image'}</div>
        )}
      </div>
      {displayedDurationMs != null && (
        <div className='generation-duration'><span>{generateData.state === 'running' ? '経過時間' : generateData.state === 'canceled' ? 'キャンセルまで' : '生成時間'}</span><strong>{formatDuration(displayedDurationMs)}</strong></div>
      )}
      {generateData.error && <div className='node-error'>{generateData.error}</div>}
      {generateData.state === 'queued' && <div className='node-queued'>キュー待機中</div>}
      {generateData.state === 'canceled' && <div className='node-canceled'>生成をキャンセルしました</div>}
      {generateData.state === 'queued' || generateData.state === 'running' ? (
        <button type='button' className='cancel-generation-button nodrag' onClick={() => void cancelGeneration(id)}>{generateData.state === 'queued' ? 'キューから削除' : 'Cancel'}</button>
      ) : (
        <button type='button' className='generate-button nodrag' disabled={!comfyReady} onClick={() => void generate(id)}>Generate</button>
      )}
      <Handle type='source' position={Position.Right} id='image' className='handle image-handle output-handle' />
      <div className='output-label'>IMAGE</div>
    </article>
  )
}

function EditorNodeComponent(props: NodeProps<EditorNode>): React.JSX.Element {
  if (props.data.kind === 'prompt') return <PromptNode {...props} />
  if (props.data.kind === 'image') return <ImageNode {...props} />
  return <GenerateNode {...props} />
}

const initialNodes: EditorNode[] = [
  {
    id: 'prompt-1',
    type: 'editor',
    position: { x: 70, y: 80 },
    data: { kind: 'prompt', title: 'Edit prompt', text: '' }
  },
  {
    id: 'image-1',
    type: 'editor',
    position: { x: 80, y: 420 },
    data: { kind: 'image', title: 'Source image', image: null }
  },
  {
    id: 'generate-1',
    type: 'editor',
    position: { x: 560, y: 170 },
    data: {
      kind: 'generate',
      title: 'Image Generate',
      settings: { width: 768, height: 768, seed: 65454653, steps: 4, cfg: 1 },
      matchImage1Size: false,
      state: 'idle',
      result: null,
      error: null,
      durationMs: null,
      startedAtMs: null
    }
  }
]

const initialEdges: EditorEdge[] = [
  {
    id: 'prompt-1-generate-1-prompt',
    source: 'prompt-1',
    sourceHandle: 'prompt',
    target: 'generate-1',
    targetHandle: 'prompt',
    animated: true,
    markerEnd: { type: MarkerType.ArrowClosed }
  },
  {
    id: 'image-1-generate-1-image1',
    source: 'image-1',
    sourceHandle: 'image',
    target: 'generate-1',
    targetHandle: 'image1',
    markerEnd: { type: MarkerType.ArrowClosed }
  }
]

function normalizeLoadedNodes(nodes: EditorNode[]): EditorNode[] {
  return nodes.map((node) => {
    if (node.data.kind !== 'generate' || (node.data.title !== 'Qwen Edit' && node.data.title !== 'Qwen composition')) return node
    return { ...node, data: { ...node.data, title: 'Image Generate' } }
  })
}

function defaultNodes(): EditorNode[] {
  return structuredClone(initialNodes)
}

function defaultEdges(): EditorEdge[] {
  return structuredClone(initialEdges)
}

function hasPath(edges: EditorEdge[], from: string, to: string): boolean {
  const visited = new Set<string>()
  const queue = [from]
  while (queue.length) {
    const current = queue.shift()!
    if (current === to) return true
    if (visited.has(current)) continue
    visited.add(current)
    for (const edge of edges) if (edge.source === current) queue.push(edge.target)
  }
  return false
}

function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target.isContentEditable
}

function generationJobKey(sessionId: string, nodeId: string): string {
  return `${sessionId}:${nodeId}`
}

function Editor(): React.JSX.Element {
  const { fitView, getNodes, screenToFlowPosition } = useReactFlow()
  const [nodes, setNodes, onNodesChange] = useNodesState<EditorNode>(defaultNodes())
  const [edges, setEdges, onEdgesChange] = useEdgesState<EditorEdge>(defaultEdges())
  const [comfy, setComfy] = useState<ComfyStatus>({ phase: 'starting', message: 'Checking ComfyUI…', managed: false })
  const [library, setLibrary] = useState<LibraryInfo | null>(null)
  const [sessions, setSessions] = useState<SessionRecord[]>([])
  const [activeSession, setActiveSession] = useState<SessionRecord | null>(null)
  const [hydratedSessionId, setHydratedSessionId] = useState<string | null>(null)
  const [sidebarError, setSidebarError] = useState<string | null>(null)
  const [sessionMenuId, setSessionMenuId] = useState<string | null>(null)
  const [sessionMenuPosition, setSessionMenuPosition] = useState<{ left: number; top: number } | null>(null)
  const [renameTarget, setRenameTarget] = useState<SessionRecord | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [renameSaving, setRenameSaving] = useState(false)
  const [previewImage, setPreviewImage] = useState<ImageAsset | null>(null)
  const [screenshotNotice, setScreenshotNotice] = useState<string | null>(null)
  const [nodeContextMenu, setNodeContextMenu] = useState<{
    left: number
    top: number
    position: { x: number; y: number }
  } | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const renameInputRef = useRef<HTMLInputElement | null>(null)
  const renameCommitPending = useRef(false)
  const nodeClipboard = useRef<NodeClipboard | null>(null)
  const activeSessionIdRef = useRef<string | null>(null)
  const canvasRef = useRef<HTMLElement | null>(null)
  const canceledGenerationIds = useRef(new Set<string>())
  const generationStartTimes = useRef(new Map<string, number>())
  activeSessionIdRef.current = activeSession?.id ?? null

  useEffect(() => {
    void window.imageMixer.getComfyStatus().then(setComfy)
    return window.imageMixer.onComfyStatus(setComfy)
  }, [])

  useEffect(() => window.imageMixer.onGenerationStarted(({ sessionId, nodeId, startedAtMs }) => {
    generationStartTimes.current.set(generationJobKey(sessionId, nodeId), startedAtMs)
    if (activeSessionIdRef.current !== sessionId) return
    setNodes((current) => current.map((node) => (
      node.id === nodeId && node.data.kind === 'generate'
        ? { ...node, data: { ...node.data, state: 'running', durationMs: 0, startedAtMs } }
        : node
    )))
  }), [setNodes])

  useEffect(() => {
    const closeMenus = (): void => {
      setSessionMenuId(null)
      setNodeContextMenu(null)
    }
    window.addEventListener('pointerdown', closeMenus)
    return () => window.removeEventListener('pointerdown', closeMenus)
  }, [])

  useEffect(() => {
    const captureScreenshot = (event: KeyboardEvent): void => {
      if (event.key !== 'F12' || event.repeat) return
      event.preventDefault()
      event.stopPropagation()
      void window.imageMixer.captureScreenshot()
        .then((sourcePath) => {
          setSidebarError(null)
          setScreenshotNotice(sourcePath)
        })
        .catch((error: unknown) => setSidebarError(error instanceof Error ? error.message : String(error)))
    }
    window.addEventListener('keydown', captureScreenshot, true)
    return () => window.removeEventListener('keydown', captureScreenshot, true)
  }, [])

  useEffect(() => {
    if (!screenshotNotice) return
    const timer = window.setTimeout(() => setScreenshotNotice(null), 6000)
    return () => window.clearTimeout(timer)
  }, [screenshotNotice])

  const openScreenshotFolder = useCallback(async () => {
    if (!screenshotNotice) return
    try {
      await window.imageMixer.revealScreenshot(screenshotNotice)
      setScreenshotNotice(null)
    } catch (error) {
      setSidebarError(error instanceof Error ? error.message : String(error))
    }
  }, [screenshotNotice])

  useEffect(() => {
    const handleCanvasShortcut = (event: KeyboardEvent): void => {
      if (isEditableElement(event.target) || renameTarget || previewImage || event.ctrlKey || event.metaKey || event.altKey) return
      const key = event.key.toLowerCase()
      if (key === 'f') {
        const selectedNodes = getNodes().filter((node) => node.selected)
        if (!selectedNodes.length) return
        event.preventDefault()
        void fitView({ nodes: selectedNodes, duration: 300, padding: 0.2, maxZoom: 1.4 })
      } else if (key === 'a') {
        if (!getNodes().length) return
        event.preventDefault()
        void fitView({ duration: 300, padding: 0.1 })
      }
    }
    window.addEventListener('keydown', handleCanvasShortcut)
    return () => window.removeEventListener('keydown', handleCanvasShortcut)
  }, [fitView, getNodes, previewImage, renameTarget])

  useEffect(() => {
    if (!previewImage) return
    const closePreview = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setPreviewImage(null)
    }
    window.addEventListener('keydown', closePreview)
    return () => window.removeEventListener('keydown', closePreview)
  }, [previewImage])

  const applyBootstrap = useCallback((bootstrap: LibraryBootstrap) => {
    const hasSavedNodes = bootstrap.snapshot.nodes.length > 0
    setHydratedSessionId(null)
    setLibrary(bootstrap.library)
    setSessions(bootstrap.sessions)
    setActiveSession(bootstrap.activeSession)
    setNodes(hasSavedNodes ? normalizeLoadedNodes(bootstrap.snapshot.nodes as EditorNode[]) : defaultNodes())
    setEdges(hasSavedNodes ? bootstrap.snapshot.edges as EditorEdge[] : defaultEdges())
    setHydratedSessionId(bootstrap.activeSession.id)
    setSidebarError(null)
  }, [setEdges, setNodes])

  useEffect(() => {
    void window.imageMixer.bootstrapLibrary().then(applyBootstrap).catch((error: unknown) => {
      setSidebarError(error instanceof Error ? error.message : String(error))
    })
  }, [applyBootstrap])

  useEffect(() => {
    if (!activeSession || hydratedSessionId !== activeSession.id) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      const snapshot: SessionSnapshot = { nodes, edges }
      void window.imageMixer.saveSession(activeSession.id, snapshot).catch((error: unknown) => {
        setSidebarError(error instanceof Error ? error.message : String(error))
      })
    }, 500)
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
    }
  }, [activeSession, edges, hydratedSessionId, nodes])

  const updateNode = useCallback((nodeId: string, patch: Partial<EditorData>) => {
    setNodes((current) => current.map((node) => node.id === nodeId ? { ...node, data: { ...node.data, ...patch } as EditorData } : node))
  }, [setNodes])

  const chooseImage = useCallback(async (nodeId: string) => {
    if (!activeSession) return
    const image = await window.imageMixer.chooseImage(activeSession.id)
    if (image) updateNode(nodeId, { image })
  }, [activeSession, updateNode])

  const dropImage = useCallback(async (nodeId: string, file: File) => {
    if (!activeSession) return
    const extension = file.name.split('.').pop()?.toLowerCase()
    if (!file.type.startsWith('image/') && !extension?.match(/^(png|jpe?g|webp|bmp)$/)) {
      setSidebarError('画像ファイルをドロップしてください。')
      return
    }
    try {
      const image = await window.imageMixer.importDroppedImage(file, activeSession.id)
      updateNode(nodeId, { image })
      setSidebarError(null)
    } catch (error) {
      setSidebarError(error instanceof Error ? error.message : String(error))
    }
  }, [activeSession, updateNode])

  const generate = useCallback(async (nodeId: string) => {
    if (!activeSession) return
    const sessionId = activeSession.id
    const target = nodes.find((node) => node.id === nodeId)
    if (!target || target.data.kind !== 'generate' || target.data.state === 'queued' || target.data.state === 'running') return
    const promptEdge = edges.find((edge) => edge.target === nodeId && edge.targetHandle === 'prompt')
    const promptNode = nodes.find((node) => node.id === promptEdge?.source)
    const prompt = promptNode?.data.kind === 'prompt' ? promptNode.data.text.trim() : ''
    const imagePaths: Array<string | null> = []
    const imageSourceNodeIds: Array<string | null> = []
    let hasEmptyImageConnection = false
    for (const handle of ['image1', 'image2', 'image3']) {
      const edge = edges.find((candidate) => candidate.target === nodeId && candidate.targetHandle === handle)
      const source = nodes.find((node) => node.id === edge?.source)
      if (source?.data.kind === 'image' && source.data.image) {
        imagePaths.push(source.data.image.path)
        imageSourceNodeIds.push(null)
      } else if (source?.data.kind === 'generate') {
        imagePaths.push(source.data.result?.path ?? null)
        imageSourceNodeIds.push(source.id)
        if (!source.data.result && source.data.state !== 'queued' && source.data.state !== 'running') hasEmptyImageConnection = true
      } else {
        imagePaths.push(null)
        imageSourceNodeIds.push(null)
        if (edge) hasEmptyImageConnection = true
      }
    }

    if (!prompt) {
      updateNode(nodeId, { state: 'failed', error: 'Promptノードを接続し、テキストを入力してください。', durationMs: null })
      return
    }
    if (hasEmptyImageConnection) {
      updateNode(nodeId, { state: 'failed', error: '接続したImageピンの画像を読み込むか、接続を外して画像生成モードにしてください。', durationMs: null })
      return
    }

    let width = normalizeImageDimension(target.data.settings.width)
    let height = normalizeImageDimension(target.data.settings.height)
    if (target.data.matchImage1Size) {
      const image1Edge = edges.find((edge) => edge.target === nodeId && edge.targetHandle === 'image1')
      const image1Source = nodes.find((node) => node.id === image1Edge?.source)
      const image1Size = image1Source?.data.kind === 'image'
        ? image1Source.data.image
        : image1Source?.data.kind === 'generate'
          ? image1Source.data.state === 'queued' || image1Source.data.state === 'running'
            ? image1Source.data.settings
            : image1Source.data.result ?? image1Source.data.settings
          : null
      if (!image1Size?.width || !image1Size.height) {
        updateNode(nodeId, { state: 'failed', error: 'Image 1へ解像度を取得できる画像を接続してください。', durationMs: null })
        return
      }
      const scale = Math.min(1, MAX_IMAGE_DIMENSION / image1Size.width, MAX_IMAGE_DIMENSION / image1Size.height)
      width = normalizeImageDimension(image1Size.width * scale)
      height = normalizeImageDimension(image1Size.height * scale)
    }
    const settings = { ...target.data.settings, width, height }
    if (width !== target.data.settings.width || height !== target.data.settings.height) {
      updateNode(nodeId, { settings })
    }

    const key = generationJobKey(sessionId, nodeId)
    canceledGenerationIds.current.delete(key)
    generationStartTimes.current.delete(key)
    updateNode(nodeId, { state: 'queued', error: null, durationMs: null, startedAtMs: null })
    try {
      const result = await window.imageMixer.generateImage({ nodeId, sessionId, prompt, imagePaths, imageSourceNodeIds, settings })
      const startedAtMs = generationStartTimes.current.get(key)
      generationStartTimes.current.delete(key)
      canceledGenerationIds.current.delete(key)
      if (activeSessionIdRef.current === sessionId) {
        updateNode(nodeId, { state: 'succeeded', result, error: null, durationMs: startedAtMs == null ? null : Date.now() - startedAtMs, startedAtMs: null })
      }
    } catch (error) {
      const startedAtMs = generationStartTimes.current.get(key)
      generationStartTimes.current.delete(key)
      const wasCanceled = canceledGenerationIds.current.delete(key) || (error instanceof Error && error.message === 'Generation canceled')
      if (activeSessionIdRef.current === sessionId) {
        updateNode(nodeId, wasCanceled
          ? { state: 'canceled', error: null, durationMs: startedAtMs == null ? null : Date.now() - startedAtMs, startedAtMs: null }
          : { state: 'failed', error: error instanceof Error ? error.message : String(error), durationMs: startedAtMs == null ? null : Date.now() - startedAtMs, startedAtMs: null })
      }
    }
  }, [activeSession, edges, nodes, updateNode])

  const cancelGeneration = useCallback(async (nodeId: string) => {
    if (!activeSession) return
    const sessionId = activeSession.id
    const target = nodes.find((node) => node.id === nodeId)
    if (!target || target.data.kind !== 'generate' || (target.data.state !== 'queued' && target.data.state !== 'running')) return
    const key = generationJobKey(sessionId, nodeId)
    canceledGenerationIds.current.add(key)
    try {
      const canceled = await window.imageMixer.cancelGeneration(sessionId, nodeId)
      if (!canceled) {
        canceledGenerationIds.current.delete(key)
        return
      }
      const startedAtMs = generationStartTimes.current.get(key) ?? target.data.startedAtMs
      const durationMs = startedAtMs == null ? null : Date.now() - startedAtMs
      updateNode(nodeId, { state: 'canceled', error: null, durationMs, startedAtMs: null })
    } catch (error) {
      canceledGenerationIds.current.delete(key)
      updateNode(nodeId, { error: error instanceof Error ? error.message : String(error) })
    }
  }, [activeSession, nodes, updateNode])
  const copyResult = useCallback(async (nodeId: string): Promise<boolean> => {
    const target = nodes.find((node) => node.id === nodeId)
    const result = target?.data.kind === 'generate' ? target.data.result : null
    if (!result) return false
    try {
      await window.imageMixer.copyImage(result.path)
      return true
    } catch (error) {
      updateNode(nodeId, { error: error instanceof Error ? error.message : String(error) })
      return false
    }
  }, [nodes, updateNode])

  const saveResult = useCallback(async (nodeId: string): Promise<boolean> => {
    const target = nodes.find((node) => node.id === nodeId)
    const result = target?.data.kind === 'generate' ? target.data.result : null
    if (!result) return false
    try {
      return await window.imageMixer.saveImageCopy(result.path)
    } catch (error) {
      updateNode(nodeId, { error: error instanceof Error ? error.message : String(error) })
      return false
    }
  }, [nodes, updateNode])

  const copySelectedNodes = useCallback((): boolean => {
    if (!activeSession) return false
    const selectedNodes = nodes.filter((node) => node.selected)
    if (!selectedNodes.length) return false
    const selectedIds = new Set(selectedNodes.map((node) => node.id))
    const minX = Math.min(...selectedNodes.map((node) => node.position.x))
    const minY = Math.min(...selectedNodes.map((node) => node.position.y))
    const maxX = Math.max(...selectedNodes.map((node) => node.position.x + (node.measured?.width ?? 280)))
    const maxY = Math.max(...selectedNodes.map((node) => node.position.y + (node.measured?.height ?? 180)))
    nodeClipboard.current = {
      sessionId: activeSession.id,
      nodes: selectedNodes.map((node) => ({
        id: node.id,
        type: node.type,
        position: { ...node.position },
        data: structuredClone(node.data)
      })),
      edges: edges
        .filter((edge) => selectedIds.has(edge.source) && selectedIds.has(edge.target))
        .map((edge) => structuredClone({ ...edge, selected: false })),
      boundsCenter: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 },
      pasteCount: 0
    }
    setSidebarError(null)
    return true
  }, [activeSession, edges, nodes])

  const pasteSelectedNodes = useCallback(async (): Promise<boolean> => {
    const clipboard = nodeClipboard.current
    if (!clipboard || !activeSession) return false
    const canvas = canvasRef.current
    if (!canvas) return false

    const targetSessionId = activeSession.id
    try {
      const assetPathMap = new Map<string, string>()
      const isCrossSessionPaste = clipboard.sessionId !== targetSessionId
      if (isCrossSessionPaste) {
        const sourcePaths = clipboard.nodes.flatMap((node) => {
          if (node.data.kind === 'image' && node.data.image) return [node.data.image.path]
          if (node.data.kind === 'generate' && node.data.result) return [node.data.result.path]
          return []
        })
        const copiedAssets = await window.imageMixer.copySessionAssets(clipboard.sessionId, targetSessionId, sourcePaths)
        for (const asset of copiedAssets) assetPathMap.set(asset.sourcePath, asset.destinationPath)
        if (activeSessionIdRef.current !== targetSessionId) throw new Error('貼り付け先のセッションが切り替わりました。もう一度貼り付けてください。')
      }

      const canvasRect = canvas.getBoundingClientRect()
      const viewportCenter = screenToFlowPosition({
        x: canvasRect.left + canvasRect.width / 2,
        y: canvasRect.top + canvasRect.height / 2
      })
      clipboard.pasteCount += 1
      const cascadeOffset = 24 * (clipboard.pasteCount - 1)
      const offset = {
        x: viewportCenter.x - clipboard.boundsCenter.x + cascadeOffset,
        y: viewportCenter.y - clipboard.boundsCenter.y + cascadeOffset
      }
      const idMap = new Map(clipboard.nodes.map((node) => [node.id, `${node.data.kind}-${crypto.randomUUID()}`]))
      const pastedNodes: EditorNode[] = clipboard.nodes.map((node) => {
        const pasted = {
          ...structuredClone(node),
          id: idMap.get(node.id)!,
          position: { x: node.position.x + offset.x, y: node.position.y + offset.y },
          selected: true
        } as EditorNode
        if (isCrossSessionPaste) {
          const rebaseAsset = (asset: ImageAsset | GeneratedImage | null): void => {
            if (!asset) return
            const destinationPath = assetPathMap.get(asset.path)
            if (!destinationPath) throw new Error('コピーした画像の保存先を解決できませんでした。')
            asset.path = destinationPath
          }
          if (pasted.data.kind === 'image') rebaseAsset(pasted.data.image)
          if (pasted.data.kind === 'generate') rebaseAsset(pasted.data.result)
        }
        if (pasted.data.kind === 'generate' && pasted.data.state === 'running') {
          pasted.data.state = 'canceled'
          pasted.data.error = null
          pasted.data.startedAtMs = null
        }
        return pasted
      })
      const pastedEdges: EditorEdge[] = clipboard.edges.map((edge) => ({
        ...structuredClone(edge),
        id: crypto.randomUUID(),
        source: idMap.get(edge.source)!,
        target: idMap.get(edge.target)!,
        selected: false
      }))
      setNodes((current) => [...current.map((node) => ({ ...node, selected: false })), ...pastedNodes])
      setEdges((current) => [...current.map((edge) => ({ ...edge, selected: false })), ...pastedEdges])
      setSidebarError(null)
      return true
    } catch (error) {
      setSidebarError(`ノードを貼り付けられませんでした: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }, [activeSession, screenToFlowPosition, setEdges, setNodes])

  useEffect(() => {
    const handleClipboardShortcut = (event: KeyboardEvent): void => {
      if (isEditableElement(event.target) || renameTarget || event.altKey || (!event.ctrlKey && !event.metaKey)) return
      const key = event.key.toLowerCase()
      if (key === 'c') {
        if (!nodes.some((node) => node.selected)) return
        event.preventDefault()
        copySelectedNodes()
      } else if (key === 'v' && !event.repeat) {
        if (!nodeClipboard.current) return
        event.preventDefault()
        void pasteSelectedNodes()
      }
    }
    window.addEventListener('keydown', handleClipboardShortcut)
    return () => window.removeEventListener('keydown', handleClipboardShortcut)
  }, [copySelectedNodes, nodes, pasteSelectedNodes, renameTarget])

  useEffect(() => {
    const handleEdgeDeleteShortcut = (event: KeyboardEvent): void => {
      if ((event.key !== 'Delete' && event.key !== 'Backspace') || isEditableElement(event.target) || renameTarget || previewImage) return
      if (!edges.some((edge) => edge.selected)) return
      event.preventDefault()
      setEdges((current) => current.filter((edge) => !edge.selected))
    }
    window.addEventListener('keydown', handleEdgeDeleteShortcut)
    return () => window.removeEventListener('keydown', handleEdgeDeleteShortcut)
  }, [edges, previewImage, renameTarget, setEdges])

  const isValidConnection = useCallback((connection: Connection | EditorEdge): boolean => {
    if (!connection.source || !connection.target || !connection.targetHandle || connection.source === connection.target) return false
    const source = nodes.find((node) => node.id === connection.source)
    const target = nodes.find((node) => node.id === connection.target)
    if (!source || !target || target.data.kind !== 'generate') return false
    if (connection.targetHandle === 'prompt' && source.data.kind !== 'prompt') return false
    if (connection.targetHandle.startsWith('image') && source.data.kind !== 'image' && source.data.kind !== 'generate') return false
    if (hasPath(edges, connection.target, connection.source)) return false
    return true
  }, [edges, nodes])

  const onConnect = useCallback((connection: Connection) => {
    if (!isValidConnection(connection)) return
    setEdges((current) => {
      const withoutExisting = current.filter((edge) => !(edge.target === connection.target && edge.targetHandle === connection.targetHandle))
      return addEdge({
        ...connection,
        id: crypto.randomUUID(),
        animated: connection.targetHandle === 'prompt',
        markerEnd: { type: MarkerType.ArrowClosed }
      }, withoutExisting)
    })
  }, [isValidConnection, setEdges])

  const selectEdge = useCallback((event: React.MouseEvent, selectedEdge: EditorEdge) => {
    event.stopPropagation()
    const additive = event.ctrlKey || event.metaKey
    if (!additive) setNodes((current) => current.map((node) => ({ ...node, selected: false })))
    setEdges((current) => current.map((edge) => ({
      ...edge,
      selected: edge.id === selectedEdge.id ? true : additive && edge.selected
    })))
  }, [setEdges, setNodes])

  const deleteEdge = useCallback((event: React.MouseEvent, edgeToDelete: EditorEdge) => {
    event.stopPropagation()
    setEdges((current) => current.filter((edge) => edge.id !== edgeToDelete.id))
  }, [setEdges])

  const hasImageInput = useCallback((nodeId: string): boolean => (
    edges.some((edge) => edge.target === nodeId && edge.targetHandle?.startsWith('image'))
  ), [edges])

  const addNode = useCallback((kind: EditorData['kind'], requestedPosition?: { x: number; y: number }) => {
    const id = `${kind}-${crypto.randomUUID()}`
    const position = requestedPosition ?? { x: 220 + Math.random() * 380, y: 120 + Math.random() * 360 }
    let data: EditorData
    if (kind === 'prompt') data = { kind, title: 'Prompt', text: '' }
    else if (kind === 'image') data = { kind, title: 'Image', image: null }
    else data = {
      kind,
      title: 'Image Generate',
      settings: { width: 768, height: 768, seed: Math.floor(Math.random() * 2147483647), steps: 4, cfg: 1 },
      matchImage1Size: false,
      state: 'idle',
      result: null,
      error: null,
      durationMs: null,
      startedAtMs: null
    }
    setNodes((current) => [...current, { id, type: 'editor', position, data }])
  }, [setNodes])

  const openNodeContextMenu = useCallback((event: MouseEvent | React.MouseEvent<Element>) => {
    event.preventDefault()
    const menuWidth = 176
    const menuHeight = 142
    setNodeContextMenu({
      left: Math.min(event.clientX, window.innerWidth - menuWidth - 8),
      top: Math.min(event.clientY, window.innerHeight - menuHeight - 8),
      position: screenToFlowPosition({ x: event.clientX, y: event.clientY })
    })
  }, [screenToFlowPosition])

  const addNodeFromContextMenu = useCallback((kind: EditorData['kind']) => {
    if (!nodeContextMenu) return
    addNode(kind, nodeContextMenu.position)
    setNodeContextMenu(null)
  }, [addNode, nodeContextMenu])

  const saveCurrentSession = useCallback(async () => {
    if (!activeSession || hydratedSessionId !== activeSession.id) return
    await window.imageMixer.saveSession(activeSession.id, { nodes, edges })
  }, [activeSession, edges, hydratedSessionId, nodes])

  const chooseLibrary = useCallback(async () => {
    try {
      await saveCurrentSession()
      const bootstrap = await window.imageMixer.chooseLibrary()
      if (bootstrap) applyBootstrap(bootstrap)
    } catch (error) {
      setSidebarError(error instanceof Error ? error.message : String(error))
    }
  }, [applyBootstrap, saveCurrentSession])

  const createSession = useCallback(async () => {
    try {
      let sessionNumber = 1
      while (sessions.some((session) => session.name === `Session ${sessionNumber}`)) sessionNumber += 1
      await saveCurrentSession()
      const created = await window.imageMixer.createSession(`Session ${sessionNumber}`)
      setHydratedSessionId(null)
      setSessions(created.sessions)
      setActiveSession(created.session)
      setNodes(defaultNodes())
      setEdges(defaultEdges())
      setHydratedSessionId(created.session.id)
      setSidebarError(null)
    } catch (error) {
      setSidebarError(error instanceof Error ? error.message : String(error))
    }
  }, [saveCurrentSession, sessions, setEdges, setNodes])

  const openSession = useCallback(async (session: SessionRecord) => {
    if (session.id === activeSession?.id) return
    try {
      await saveCurrentSession()
      const loaded = await window.imageMixer.loadSession(session.id)
      const hasSavedNodes = loaded.snapshot.nodes.length > 0
      setHydratedSessionId(null)
      setActiveSession(loaded.session)
      setNodes(hasSavedNodes ? normalizeLoadedNodes(loaded.snapshot.nodes as EditorNode[]) : defaultNodes())
      setEdges(hasSavedNodes ? loaded.snapshot.edges as EditorEdge[] : defaultEdges())
      setHydratedSessionId(loaded.session.id)
      setSidebarError(null)
    } catch (error) {
      setSidebarError(error instanceof Error ? error.message : String(error))
    }
  }, [activeSession?.id, saveCurrentSession, setEdges, setNodes])

  const duplicateSession = useCallback(async (session: SessionRecord) => {
    setSessionMenuId(null)
    try {
      await saveCurrentSession()
      if (saveTimer.current) clearTimeout(saveTimer.current)
      const duplicated = await window.imageMixer.duplicateSession(session.id)
      const hasSavedNodes = duplicated.snapshot.nodes.length > 0
      setHydratedSessionId(null)
      setSessions(duplicated.sessions)
      setActiveSession(duplicated.session)
      setNodes(hasSavedNodes ? normalizeLoadedNodes(duplicated.snapshot.nodes as EditorNode[]) : defaultNodes())
      setEdges(hasSavedNodes ? duplicated.snapshot.edges as EditorEdge[] : defaultEdges())
      setHydratedSessionId(duplicated.session.id)
      setSidebarError(null)
    } catch (error) {
      setSidebarError(error instanceof Error ? error.message : String(error))
    }
  }, [saveCurrentSession, setEdges, setNodes])

  const deleteSession = useCallback(async (session: SessionRecord) => {
    if (!window.confirm(`「${session.name}」を削除しますか？\nセッション内の画像も削除されます。`)) return
    try {
      if (session.id === activeSession?.id) {
        if (saveTimer.current) clearTimeout(saveTimer.current)
        setHydratedSessionId(null)
      }
      const bootstrap = await window.imageMixer.deleteSession(session.id)
      applyBootstrap(bootstrap)
    } catch (error) {
      setSidebarError(error instanceof Error ? error.message : String(error))
    }
  }, [activeSession?.id, applyBootstrap])

  const beginRenameSession = useCallback((session: SessionRecord) => {
    setSessionMenuId(null)
    setRenameTarget(session)
    setRenameDraft(session.name)
    setSidebarError(null)
  }, [])

  const cancelRenameSession = useCallback(() => {
    if (renameCommitPending.current) return
    setRenameTarget(null)
    setRenameDraft('')
    setSidebarError(null)
  }, [])

  const commitRenameSession = useCallback(async () => {
    if (!renameTarget || renameCommitPending.current) return
    const name = renameDraft.trim()
    if (!name) {
      setSidebarError('セッション名を入力してください。')
      requestAnimationFrame(() => renameInputRef.current?.focus())
      return
    }
    if (name === renameTarget.name) {
      cancelRenameSession()
      return
    }
    renameCommitPending.current = true
    setRenameSaving(true)
    try {
      await saveCurrentSession()
      const renamed = await window.imageMixer.renameSession(renameTarget.id, name)
      setSessions(renamed.sessions)
      setActiveSession((current) => current?.id === renameTarget.id ? renamed.session : current)
      setRenameTarget(null)
      setRenameDraft('')
      setSidebarError(null)
    } catch (error) {
      setSidebarError(error instanceof Error ? error.message : String(error))
      requestAnimationFrame(() => renameInputRef.current?.focus())
    } finally {
      renameCommitPending.current = false
      setRenameSaving(false)
    }
  }, [cancelRenameSession, renameDraft, renameTarget, saveCurrentSession])

  const actions = useMemo<EditorActions>(() => ({
    comfyReady: comfy.phase === 'ready',
    hasImageInput,
    updateNode,
    chooseImage,
    dropImage,
    generate,
    cancelGeneration,
    copyResult,
    saveResult,
    previewResult: setPreviewImage
  }), [cancelGeneration, chooseImage, comfy.phase, copyResult, dropImage, generate, hasImageInput, saveResult, updateNode])

  const nodeTypes = useMemo(() => ({ editor: EditorNodeComponent }), [])

  return (
    <EditorContext.Provider value={actions}>
      <main className='app-shell'>
        <header className='topbar'>
          <div className={`comfy-status status-${comfy.phase}`} title={comfy.message}>
            <span />
            <div><strong>ComfyUI</strong><small>{comfy.message}</small></div>
          </div>
        </header>
        <div className='workspace'>
          <aside className='left-sidebar'>
            <section className='library-section'>
              <div className='sidebar-label'>ROOT FOLDER</div>
              <button type='button' className='library-button' onClick={() => void chooseLibrary()} title={library?.rootPath}>
                <span className='folder-icon'>▰</span>
                <span><strong>{library?.name ?? 'Loading…'}</strong><small>{library?.rootPath ?? 'ルートフォルダを読み込み中'}</small></span>
                <span className='chevron'>›</span>
              </button>
            </section>

            <section className='sessions-section'>
              <div className='sessions-heading'>
                <div><div className='sidebar-label'>SESSIONS</div><small>{sessions.length} sessions</small></div>
                <button type='button' className='add-session-button' onClick={() => void createSession()} title='新規セッション'>+</button>
              </div>
              <div className='session-list' onScroll={() => setSessionMenuId(null)}>
                {sessions.map((session) => (
                  <div className={`session-row ${session.id === activeSession?.id ? 'active' : ''} ${sessionMenuId === session.id ? 'menu-open' : ''}`} key={session.id}>
                    {renameTarget?.id === session.id ? (
                      <form className='session-main session-rename-form' onSubmit={(event) => { event.preventDefault(); void commitRenameSession() }}>
                        <span className='session-dot' />
                        <span>
                          <input
                            ref={renameInputRef}
                            autoFocus
                            value={renameDraft}
                            maxLength={80}
                            disabled={renameSaving}
                            onChange={(event) => setRenameDraft(event.target.value)}
                            onBlur={() => void commitRenameSession()}
                            onFocus={(event) => event.currentTarget.select()}
                            onKeyDown={(event) => {
                              if (event.key === 'Escape') {
                                event.preventDefault()
                                event.stopPropagation()
                                cancelRenameSession()
                              }
                            }}
                            aria-label='新しいセッション名'
                          />
                          <small>Enterで確定・Escで取消</small>
                        </span>
                      </form>
                    ) : (
                      <button type='button' className='session-main' onClick={() => void openSession(session)}>
                        <span className='session-dot' />
                        <span><strong>{session.name}</strong><small>{new Date(session.updatedAt).toLocaleString('ja-JP')}</small></span>
                      </button>
                    )}
                    <div className='session-actions' onPointerDown={(event) => event.stopPropagation()}>
                      <button
                        type='button'
                        className='session-menu-button'
                        onClick={(event) => {
                          if (sessionMenuId === session.id) {
                            setSessionMenuId(null)
                            return
                          }
                          const rect = event.currentTarget.getBoundingClientRect()
                          const menuWidth = 126
                          const menuHeight = 104
                          const opensAbove = rect.bottom + menuHeight + 8 > window.innerHeight
                          setSessionMenuPosition({
                            left: Math.max(8, Math.min(window.innerWidth - menuWidth - 8, rect.right - menuWidth)),
                            top: opensAbove ? Math.max(8, rect.top - menuHeight - 4) : rect.bottom + 4
                          })
                          setSessionMenuId(session.id)
                        }}
                        title={`${session.name}のメニュー`}
                        aria-label={`${session.name}のメニュー`}
                        aria-expanded={sessionMenuId === session.id}
                      >⋯</button>
                      {sessionMenuId === session.id && sessionMenuPosition && (
                        <div className='session-menu' style={sessionMenuPosition}>
                          <button type='button' onClick={() => beginRenameSession(session)}>名前を変更</button>
                          <button type='button' onClick={() => void duplicateSession(session)}>複製</button>
                          <button type='button' className='danger' onClick={() => { setSessionMenuId(null); void deleteSession(session) }}>削除</button>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </section>
            {sidebarError && <div className='sidebar-error'>{sidebarError}</div>}
            <div className='sidebar-footer'>変更内容は現在のセッションへ自動保存されます</div>
          </aside>

          <section ref={canvasRef} className='canvas-wrap'>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onEdgeClick={selectEdge}
              onEdgeDoubleClick={deleteEdge}
              isValidConnection={isValidConnection}
              onPaneContextMenu={openNodeContextMenu}
              onPaneClick={() => setNodeContextMenu(null)}
              panOnDrag={[1]}
              selectionOnDrag
              selectionMode={SelectionMode.Partial}
              fitView
              minZoom={0.25}
              maxZoom={1.8}
              deleteKeyCode={['Backspace', 'Delete']}
              proOptions={{ hideAttribution: true }}
              defaultEdgeOptions={{ style: { strokeWidth: 2, stroke: '#77869b' } }}
            >
              <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} color='#2b3441' />
              <MiniMap
                position='bottom-left'
                pannable
                zoomable
                ariaLabel='ノードマップ'
                bgColor='#0c121a'
                maskColor='#05080cb8'
                maskStrokeColor='#72c7f4'
                maskStrokeWidth={1.5}
                nodeBorderRadius={8}
                nodeStrokeWidth={1.5}
                nodeColor={(node) => {
                  if (node.data.kind === 'prompt') return '#654398'
                  if (node.data.kind === 'image') return '#216f96'
                  return '#96552f'
                }}
                nodeStrokeColor={(node) => {
                  if (node.data.kind === 'prompt') return '#c39cff'
                  if (node.data.kind === 'image') return '#79d3ff'
                  return '#ffb17d'
                }}
              />
            </ReactFlow>
          </section>
        </div>
        <footer className='status-bar'>
          <div className='status-summary'>
            <span className={`status-indicator status-${comfy.phase}`} />
            <span>ComfyUI: {comfy.phase === 'ready' ? 'Ready' : comfy.phase}</span>
            <span className='status-separator' />
            <span className='status-session' title={activeSession?.name}>{activeSession?.name ?? 'セッションなし'}</span>
          </div>
          <SystemResourceMonitor />
        </footer>
        {nodeContextMenu && (
          <div
            className='node-context-menu'
            style={{ left: nodeContextMenu.left, top: nodeContextMenu.top }}
            onPointerDown={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.preventDefault()}
          >
            <div className='node-context-title'>ADD NODE</div>
            <button type='button' onClick={() => addNodeFromContextMenu('prompt')}><span className='node-type-dot prompt' />Prompt</button>
            <button type='button' onClick={() => addNodeFromContextMenu('image')}><span className='node-type-dot image' />Image</button>
            <button type='button' onClick={() => addNodeFromContextMenu('generate')}><span className='node-type-dot generate' />Image Generate</button>
          </div>
        )}
        {screenshotNotice && (
          <div className='screenshot-toast' role='status' aria-live='polite'>
            <button type='button' className='screenshot-toast-main' onClick={() => void openScreenshotFolder()}>
              <span className='screenshot-toast-icon' aria-hidden='true'>✓</span>
              <span className='screenshot-toast-copy'>
                <strong>スクリーンショットを保存しました</strong>
                <small>{screenshotNotice.split(/[\\/]/).pop()}</small>
                <span>クリックしてフォルダを開く</span>
              </span>
            </button>
            <button type='button' className='screenshot-toast-close' aria-label='通知を閉じる' onClick={() => setScreenshotNotice(null)}>×</button>
          </div>
        )}
        {previewImage && (
          <div className='image-preview-backdrop' onPointerDown={() => setPreviewImage(null)}>
            <div
              className='image-preview-dialog'
              role='dialog'
              aria-modal='true'
              aria-label='画像の拡大表示'
              onPointerDown={(event) => event.stopPropagation()}
            >
              <img src={previewImage.dataUrl} alt={`${previewImage.name} preview`} draggable={false} />
              {previewImage.width && previewImage.height && <div className='image-preview-resolution'>{previewImage.width} × {previewImage.height}</div>}
            </div>
          </div>
        )}
      </main>
    </EditorContext.Provider>
  )
}

export default function App(): React.JSX.Element {
  return <ReactFlowProvider><Editor /></ReactFlowProvider>
}
