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
import { DEFAULT_IMAGE_DESCRIBE_SYSTEM_PROMPT, DEFAULT_TEXT_TRANSFORM_SYSTEM_PROMPT } from '../../main/types'
import type { BatchFolderSelection, BatchManifest, BatchManifestItem, ComfyStatus, GeneratedImage, GenerateSettings, GenerationProgressEvent, ImageAsset, LibraryBootstrap, LibraryInfo, LlmConfig, LlmStatus, SessionRecord, SessionSnapshot, SessionViewport } from '../../main/types'
import { SystemResourceMonitor } from './SystemResourceMonitor'

type RenderState = 'idle' | 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled'

const MIN_IMAGE_DIMENSION = 64
const MAX_IMAGE_DIMENSION = 4096
const IMAGE_DIMENSION_STEP = 8
const DEFAULT_SIDEBAR_WIDTH = 270
const MIN_SIDEBAR_WIDTH = 220
const MAX_SIDEBAR_WIDTH = 520
const SIDEBAR_WIDTH_STORAGE_KEY = 'image-mixer.sidebar-width'
const SIDEBAR_VISIBLE_STORAGE_KEY = 'image-mixer.sidebar-visible'
const MINIMAP_STORAGE_KEY = 'image-mixer.show-minimap'
const SNAP_TO_GRID_STORAGE_KEY = 'image-mixer.snap-to-grid'
const DOTS_STORAGE_KEY = 'image-mixer.show-dots'

const EMPTY_LLM_STATUS: LlmStatus = {
  phase: 'stopped',
  message: 'Local LLMを確認中…',
  managed: false,
  models: [],
  config: {
    selectedModelPath: '',
    contextLength: 8192,
    temperature: 0.3,
    maxTokens: 1024,
    idleUnloadMinutes: 0,
    gpuLayers: 999,
    flashAttention: true,
    mmprojOffload: true
  },
  loadedModelPath: null,
  serverPath: null,
  activePort: null,
  restartRequired: false
}

function formatModelSize(sizeBytes: number): string {
  return `${(sizeBytes / 1024 ** 3).toFixed(1)} GB`
}

function displayModelName(name: string): string {
  return (name.split(/[\\/]/).pop() ?? name).replace(/\.gguf$/i, '')
}

function normalizeImageDimension(value: number): number {
  if (!Number.isFinite(value)) return MIN_IMAGE_DIMENSION
  const rounded = Math.round(value / IMAGE_DIMENSION_STEP) * IMAGE_DIMENSION_STEP
  return Math.min(MAX_IMAGE_DIMENSION, Math.max(MIN_IMAGE_DIMENSION, rounded))
}

function clampSidebarWidth(value: number): number {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, value))
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

type ImageDescribeData = {
  kind: 'image-describe'
  title: string
  text: string
  systemPrompt: string
  systemPromptOpen: boolean
  state: RenderState
  error: string | null
  durationMs?: number | null
  startedAtMs?: number | null
}

type TextTransformData = {
  kind: 'text-transform'
  title: string
  instruction: string
  text: string
  systemPrompt: string
  systemPromptOpen: boolean
  state: RenderState
  error: string | null
  durationMs?: number | null
  startedAtMs?: number | null
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

type BatchGenerateData = {
  kind: 'batch-generate'
  title: string
  folder: BatchFolderSelection | null
  settings: GenerateSettings
  matchInputSize: boolean
  state: RenderState
  result: GeneratedImage | null
  outputDirectory: string | null
  total: number
  completed: number
  succeeded: number
  failed: number
  currentFile: string | null
  error: string | null
  durationMs?: number | null
  startedAtMs?: number | null
}

type EditorData = (PromptData | ImageData | ImageDescribeData | TextTransformData | GenerateData | BatchGenerateData) & Record<string, unknown>
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
  llmReady: boolean
  llmVisionReady: boolean
  hasImageInput: (nodeId: string) => boolean
  hasDescribeImageInput: (nodeId: string) => boolean
  updateNode: (nodeId: string, patch: Partial<EditorData>) => void
  chooseBatchFolder: (nodeId: string) => Promise<void>
  runBatch: (nodeId: string) => Promise<void>
  cancelBatch: (nodeId: string) => Promise<void>
  revealBatchOutput: (nodeId: string) => Promise<void>
  chooseImage: (nodeId: string) => Promise<void>
  dropImage: (nodeId: string, file: File) => Promise<void>
  generate: (nodeId: string) => Promise<void>
  cancelGeneration: (nodeId: string) => Promise<void>
  describeImage: (nodeId: string) => Promise<void>
  cancelImageDescription: (nodeId: string) => Promise<void>
  transformText: (nodeId: string) => Promise<void>
  cancelTextTransform: (nodeId: string) => Promise<void>
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

function TextNode({ id, data, selected }: NodeProps<EditorNode>): React.JSX.Element {
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
    <article className={`node-card prompt-node text-node ${selected ? 'selected' : ''}`}>
      <div className='node-kicker'>TEXT</div>
      <EditableNodeTitle title={prompt.title} ariaLabel='Text node title' onCommit={(title) => updateNode(id, { title })} />
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
        placeholder='テキストを入力…'
      />
      <Handle type='source' position={Position.Right} id='prompt' className='handle prompt-handle output-handle' />
      <div className='output-label'>TEXT</div>
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

function ImageDescribeNode({ id, data, selected }: NodeProps<EditorNode>): React.JSX.Element {
  const { llmVisionReady, hasDescribeImageInput, updateNode, describeImage, cancelImageDescription } = useEditor()
  const describeData = data as ImageDescribeData
  const [draftText, setDraftText] = useState(describeData.text)
  const [systemPromptDraft, setSystemPromptDraft] = useState(describeData.systemPrompt)
  const [runningDurationMs, setRunningDurationMs] = useState(0)
  const textComposing = useRef(false)
  const systemPromptComposing = useRef(false)
  const textAreaRef = useRef<HTMLTextAreaElement | null>(null)
  const active = describeData.state === 'queued' || describeData.state === 'running'
  const hasImage = hasDescribeImageInput(id)

  useEffect(() => {
    if (!textComposing.current) setDraftText(describeData.text)
  }, [describeData.text])

  useEffect(() => {
    if (!systemPromptComposing.current) setSystemPromptDraft(describeData.systemPrompt)
  }, [describeData.systemPrompt])

  useLayoutEffect(() => {
    const editor = textAreaRef.current
    if (!editor) return
    editor.style.height = 'auto'
    const borderHeight = editor.offsetHeight - editor.clientHeight
    editor.style.height = `${Math.max(180, editor.scrollHeight + borderHeight)}px`
  }, [draftText])

  useEffect(() => {
    if (describeData.state !== 'running' || describeData.startedAtMs == null) return
    const updateDuration = (): void => setRunningDurationMs(Math.max(0, Date.now() - describeData.startedAtMs!))
    updateDuration()
    const timer = window.setInterval(updateDuration, 100)
    return () => window.clearInterval(timer)
  }, [describeData.startedAtMs, describeData.state])

  const displayedDurationMs = describeData.state === 'running' ? runningDurationMs : describeData.durationMs

  return (
    <article className={`node-card image-describe-node ${selected ? 'selected' : ''}`}>
      <div className='node-kicker'>IMAGE DESCRIBE</div>
      <EditableNodeTitle title={describeData.title} ariaLabel='Image Describe node title' onCommit={(title) => updateNode(id, { title })} />
      <div className='describe-input-label'>Image</div>
      <Handle type='target' position={Position.Left} id='image' className='handle image-handle describe-image-handle' />

      <textarea
        ref={textAreaRef}
        className='prompt-editor describe-output-editor nodrag nopan nowheel'
        value={draftText}
        readOnly={active}
        onChange={(event) => {
          setDraftText(event.target.value)
          if (!textComposing.current) updateNode(id, { text: event.target.value })
        }}
        onCompositionStart={() => { textComposing.current = true }}
        onCompositionEnd={(event) => {
          textComposing.current = false
          setDraftText(event.currentTarget.value)
          updateNode(id, { text: event.currentTarget.value })
        }}
        onKeyDown={(event) => event.stopPropagation()}
        onKeyUp={(event) => event.stopPropagation()}
        placeholder='画像の説明プロンプトがここへストリーミング表示されます…'
      />

      <button type='button' className='describe-system-toggle nodrag' aria-expanded={describeData.systemPromptOpen} onClick={() => updateNode(id, { systemPromptOpen: !describeData.systemPromptOpen })}>
        <svg viewBox='0 0 16 16' aria-hidden='true'><path d={describeData.systemPromptOpen ? 'm3 6 5 5 5-5' : 'm6 3 5 5-5 5'} /></svg>
        <span>System Prompt</span><small>{describeData.systemPrompt.trim() ? 'Custom' : 'Default'}</small>
      </button>
      {describeData.systemPromptOpen && (
        <textarea
          className='describe-system-editor nodrag nopan nowheel'
          value={systemPromptDraft}
          disabled={active}
          onChange={(event) => {
            setSystemPromptDraft(event.target.value)
            if (!systemPromptComposing.current) updateNode(id, { systemPrompt: event.target.value })
          }}
          onCompositionStart={() => { systemPromptComposing.current = true }}
          onCompositionEnd={(event) => {
            systemPromptComposing.current = false
            setSystemPromptDraft(event.currentTarget.value)
            updateNode(id, { systemPrompt: event.currentTarget.value })
          }}
          onKeyDown={(event) => event.stopPropagation()}
          onKeyUp={(event) => event.stopPropagation()}
          placeholder={DEFAULT_IMAGE_DESCRIBE_SYSTEM_PROMPT}
        />
      )}

      {displayedDurationMs != null && <div className='generation-duration'><span>{active ? '経過時間' : describeData.state === 'canceled' ? 'キャンセルまで' : '処理時間'}</span><strong>{formatDuration(displayedDurationMs)}</strong></div>}
      {describeData.error && <div className='node-error'>{describeData.error}</div>}
      {describeData.state === 'canceled' && <div className='node-canceled'>Image Describeをキャンセルしました</div>}
      {active ? (
        <button type='button' className='cancel-generation-button nodrag' onClick={() => void cancelImageDescription(id)}>Cancel</button>
      ) : (
        <button type='button' className='describe-button nodrag' disabled={!llmVisionReady || !hasImage} title={!llmVisionReady ? 'Vision対応のLocal LLMをロードしてください' : !hasImage ? '画像を接続してください' : '画像を説明する'} onClick={() => void describeImage(id)}>Describe</button>
      )}
      <Handle type='source' position={Position.Right} id='prompt' className='handle prompt-handle output-handle' />
      <div className='output-label'>TEXT</div>
    </article>
  )
}

function TextTransformNode({ id, data, selected }: NodeProps<EditorNode>): React.JSX.Element {
  const { llmReady, updateNode, transformText, cancelTextTransform } = useEditor()
  const transformData = data as TextTransformData
  const [instructionDraft, setInstructionDraft] = useState(transformData.instruction)
  const [textDraft, setTextDraft] = useState(transformData.text)
  const [systemPromptDraft, setSystemPromptDraft] = useState(transformData.systemPrompt)
  const [runningDurationMs, setRunningDurationMs] = useState(0)
  const instructionComposing = useRef(false)
  const textComposing = useRef(false)
  const systemPromptComposing = useRef(false)
  const outputRef = useRef<HTMLTextAreaElement | null>(null)
  const active = transformData.state === 'queued' || transformData.state === 'running'

  useEffect(() => { if (!instructionComposing.current) setInstructionDraft(transformData.instruction) }, [transformData.instruction])
  useEffect(() => { if (!textComposing.current) setTextDraft(transformData.text) }, [transformData.text])
  useEffect(() => { if (!systemPromptComposing.current) setSystemPromptDraft(transformData.systemPrompt) }, [transformData.systemPrompt])

  useLayoutEffect(() => {
    const editor = outputRef.current
    if (!editor) return
    editor.style.height = 'auto'
    const borderHeight = editor.offsetHeight - editor.clientHeight
    editor.style.height = `${Math.max(100, editor.scrollHeight + borderHeight)}px`
  }, [textDraft])

  useEffect(() => {
    if (transformData.state !== 'running' || transformData.startedAtMs == null) return
    const updateDuration = (): void => setRunningDurationMs(Math.max(0, Date.now() - transformData.startedAtMs!))
    updateDuration()
    const timer = window.setInterval(updateDuration, 100)
    return () => window.clearInterval(timer)
  }, [transformData.startedAtMs, transformData.state])

  const displayedDurationMs = transformData.state === 'running' ? runningDurationMs : transformData.durationMs
  return (
    <article className={`node-card text-transform-node ${selected ? 'selected' : ''}`}>
      <div className='node-kicker'>TEXT TRANSFORM</div>
      <EditableNodeTitle title={transformData.title} ariaLabel='Text Transform node title' onCommit={(title) => updateNode(id, { title })} />
      <div className='transform-input-label'>TEXT <small>optional</small></div>
      <Handle type='target' position={Position.Left} id='text' className='handle prompt-handle transform-text-handle' />

      <label className='transform-field-label'>Instruction</label>
      <textarea
        className='transform-instruction-editor nodrag nopan nowheel'
        value={instructionDraft}
        disabled={active}
        onChange={(event) => {
          setInstructionDraft(event.target.value)
          if (!instructionComposing.current) updateNode(id, { instruction: event.target.value })
        }}
        onCompositionStart={() => { instructionComposing.current = true }}
        onCompositionEnd={(event) => {
          instructionComposing.current = false
          setInstructionDraft(event.currentTarget.value)
          updateNode(id, { instruction: event.currentTarget.value })
        }}
        onKeyDown={(event) => event.stopPropagation()}
        onKeyUp={(event) => event.stopPropagation()}
        placeholder='例：英語の画像生成プロンプトにして'
      />

      <label className='transform-field-label transform-output-label'>Output</label>
      <textarea
        ref={outputRef}
        className='prompt-editor transform-output-editor nodrag nopan nowheel'
        value={textDraft}
        readOnly={active}
        onChange={(event) => {
          setTextDraft(event.target.value)
          if (!textComposing.current) updateNode(id, { text: event.target.value })
        }}
        onCompositionStart={() => { textComposing.current = true }}
        onCompositionEnd={(event) => {
          textComposing.current = false
          setTextDraft(event.currentTarget.value)
          updateNode(id, { text: event.currentTarget.value })
        }}
        onKeyDown={(event) => event.stopPropagation()}
        onKeyUp={(event) => event.stopPropagation()}
        placeholder='変換または新規生成したテキストがここへ表示されます…'
      />

      <button type='button' className='describe-system-toggle transform-system-toggle nodrag' aria-expanded={transformData.systemPromptOpen} onClick={() => updateNode(id, { systemPromptOpen: !transformData.systemPromptOpen })}>
        <svg viewBox='0 0 16 16' aria-hidden='true'><path d={transformData.systemPromptOpen ? 'm3 6 5 5 5-5' : 'm6 3 5 5-5 5'} /></svg>
        <span>System Prompt</span><small>{transformData.systemPrompt.trim() ? 'Custom' : 'Default'}</small>
      </button>
      {transformData.systemPromptOpen && (
        <textarea
          className='describe-system-editor transform-system-editor nodrag nopan nowheel'
          value={systemPromptDraft}
          disabled={active}
          onChange={(event) => {
            setSystemPromptDraft(event.target.value)
            if (!systemPromptComposing.current) updateNode(id, { systemPrompt: event.target.value })
          }}
          onCompositionStart={() => { systemPromptComposing.current = true }}
          onCompositionEnd={(event) => {
            systemPromptComposing.current = false
            setSystemPromptDraft(event.currentTarget.value)
            updateNode(id, { systemPrompt: event.currentTarget.value })
          }}
          onKeyDown={(event) => event.stopPropagation()}
          onKeyUp={(event) => event.stopPropagation()}
          placeholder={DEFAULT_TEXT_TRANSFORM_SYSTEM_PROMPT}
        />
      )}

      {displayedDurationMs != null && <div className='generation-duration'><span>{active ? '経過時間' : transformData.state === 'canceled' ? 'キャンセルまで' : '処理時間'}</span><strong>{formatDuration(displayedDurationMs)}</strong></div>}
      {transformData.error && <div className='node-error'>{transformData.error}</div>}
      {transformData.state === 'canceled' && <div className='node-canceled'>Text Transformをキャンセルしました</div>}
      {active ? (
        <button type='button' className='cancel-generation-button nodrag' onClick={() => void cancelTextTransform(id)}>Cancel</button>
      ) : (
        <button type='button' className='transform-button nodrag' disabled={!llmReady || !transformData.instruction.trim()} title={!llmReady ? 'Local LLMをロードしてください' : !transformData.instruction.trim() ? '加工指示を入力してください' : 'テキストを加工する'} onClick={() => void transformText(id)}>Transform</button>
      )}
      <Handle type='source' position={Position.Right} id='prompt' className='handle prompt-handle output-handle' />
      <div className='output-label'>TEXT</div>
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

function BatchGenerateNode({ id, data, selected }: NodeProps<EditorNode>): React.JSX.Element {
  const { comfyReady, updateNode, chooseBatchFolder, runBatch, cancelBatch, revealBatchOutput, previewResult } = useEditor()
  const batchData = data as BatchGenerateData
  const active = batchData.state === 'queued' || batchData.state === 'running'
  const [runningDurationMs, setRunningDurationMs] = useState(0)
  const progress = batchData.total > 0 ? Math.min(100, (batchData.completed / batchData.total) * 100) : 0
  const resultSize = imageMediaSize(batchData.result?.width, batchData.result?.height, { width: 360, height: 180 })
  const setSetting = (key: keyof GenerateSettings, value: number): void => {
    updateNode(id, { settings: { ...batchData.settings, [key]: value } })
  }
  useEffect(() => {
    if (batchData.state !== 'running' || batchData.startedAtMs == null) return
    const updateDuration = (): void => setRunningDurationMs(Math.max(0, Date.now() - batchData.startedAtMs!))
    updateDuration()
    const timer = window.setInterval(updateDuration, 100)
    return () => window.clearInterval(timer)
  }, [batchData.startedAtMs, batchData.state])
  const displayedDurationMs = batchData.state === 'running' ? runningDurationMs : batchData.durationMs
  return (
    <article className={'node-card batch-generate-node ' + (selected ? 'selected' : '')} style={{ width: 390 }}>
      <div className='node-kicker'>BATCH IMAGE GENERATE</div>
      <EditableNodeTitle title={batchData.title} ariaLabel='Batch Image Generate node title' onCommit={(title) => updateNode(id, { title })} />

      <div className='pin-label prompt-pin-label'>Prompt</div>
      <Handle type='target' position={Position.Left} id='prompt' className='handle prompt-handle pin-prompt' />
      <div className='pin-label image-pin-label pin-label-2'>Image 2</div>
      <div className='pin-label image-pin-label pin-label-3'>Image 3</div>
      <Handle type='target' position={Position.Left} id='image2' className='handle image-handle pin-image-2' />
      <Handle type='target' position={Position.Left} id='image3' className='handle image-handle pin-image-3' />

      <button type='button' className='batch-folder-picker nodrag' disabled={active} onClick={() => void chooseBatchFolder(id)}>
        <svg viewBox='0 0 24 24' aria-hidden='true'><path d='M3 6h7l2 2h9v10H3z' /></svg>
        <span><strong>{batchData.folder?.name ?? '入力フォルダを選択'}</strong><small>{batchData.folder ? batchData.folder.path : 'フォルダ直下の画像を順次処理します'}</small></span>
        <em>{batchData.folder ? batchData.folder.imageCount + ' images' : 'Browse'}</em>
      </button>

      <div className='settings-grid batch-settings-grid'>
        <div className='size-settings-row'>
          <NumberField label='Width' value={batchData.settings.width} min={MIN_IMAGE_DIMENSION} max={MAX_IMAGE_DIMENSION} step={IMAGE_DIMENSION_STEP} normalize={normalizeImageDimension} onChange={(value) => setSetting('width', value)} />
          <NumberField label='Height' value={batchData.settings.height} min={MIN_IMAGE_DIMENSION} max={MAX_IMAGE_DIMENSION} step={IMAGE_DIMENSION_STEP} normalize={normalizeImageDimension} onChange={(value) => setSetting('height', value)} />
        </div>
        <label className='match-size-toggle nodrag nopan'>
          <input type='checkbox' checked={batchData.matchInputSize} onChange={(event) => updateNode(id, { matchInputSize: event.target.checked })} />
          <span>各入力画像のサイズに合わせる</span>
        </label>
        <NumberField label='Seed' value={batchData.settings.seed} min={0} max={2147483647} step={1} onChange={(value) => setSetting('seed', value)} onRandomize={() => setSetting('seed', crypto.getRandomValues(new Uint32Array(1))[0] % 2147483648)} />
        <NumberField label='Steps' value={batchData.settings.steps} min={1} max={100} step={1} onChange={(value) => setSetting('steps', value)} />
        <NumberField label='CFG' value={batchData.settings.cfg} min={0} max={100} step={0.1} onChange={(value) => setSetting('cfg', value)} />
      </div>

      {(active || batchData.completed > 0) && (
        <div className='batch-progress'>
          <div className='batch-progress-summary'><span>{batchData.currentFile ?? (batchData.state === 'succeeded' ? '完了' : '待機中')}</span><strong>{batchData.completed} / {batchData.total}</strong></div>
          <div className='batch-progress-track'><span style={{ width: progress + '%' }} /></div>
          <div className='batch-progress-counts'><span className='success'>成功 {batchData.succeeded}</span><span className='failed'>失敗 {batchData.failed}</span></div>
        </div>
      )}

      <div className='result-frame batch-result-frame' style={{ height: batchData.result ? resultSize.height : 180 }}>
        {batchData.result ? (
          <button type='button' className='result-preview-button nodrag' title='最新結果を拡大表示' onClick={() => previewResult(batchData.result!)}>
            <img src={batchData.result.dataUrl} alt='Latest batch result' draggable={false} />
          </button>
        ) : active ? <span className='spinner' /> : <span className='result-placeholder'>Latest result</span>}
      </div>

      {batchData.outputDirectory && (
        <button type='button' className='batch-output-button nodrag' onClick={() => void revealBatchOutput(id)} title={batchData.outputDirectory}>
          出力フォルダを開く
        </button>
      )}
      {displayedDurationMs != null && <div className='generation-duration'><span>{batchData.state === 'running' ? '経過時間' : batchData.state === 'canceled' ? 'キャンセルまで' : '処理時間'}</span><strong>{formatDuration(displayedDurationMs)}</strong></div>}
      {batchData.error && <div className='node-error'>{batchData.error}</div>}
      {batchData.state === 'canceled' && <div className='node-canceled'>一括処理をキャンセルしました</div>}
      {active ? (
        <button type='button' className='cancel-generation-button nodrag' onClick={() => void cancelBatch(id)}>Cancel Batch</button>
      ) : (
        <button type='button' className='generate-button nodrag' disabled={!comfyReady || !batchData.folder} onClick={() => void runBatch(id)}>Start Batch</button>
      )}
    </article>
  )
}

function EditorNodeComponent(props: NodeProps<EditorNode>): React.JSX.Element {
  if (props.data.kind === 'prompt') return <TextNode {...props} />
  if (props.data.kind === 'image') return <ImageNode {...props} />
  if (props.data.kind === 'image-describe') return <ImageDescribeNode {...props} />
  if (props.data.kind === 'text-transform') return <TextTransformNode {...props} />
  if (props.data.kind === 'batch-generate') return <BatchGenerateNode {...props} />
  return <GenerateNode {...props} />
}

const initialNodes: EditorNode[] = [
  {
    id: 'prompt-1',
    type: 'editor',
    position: { x: 70, y: 80 },
    data: { kind: 'prompt', title: 'Text', text: '' }
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

const PROMPT_EDGE_COLOR = '#a878ff'
const IMAGE_EDGE_COLOR = '#45b8ff'

function connectionColor(targetHandle: string | null | undefined): string {
  return targetHandle?.startsWith('image') ? IMAGE_EDGE_COLOR : PROMPT_EDGE_COLOR
}

function normalizeEditorEdge(edge: EditorEdge): EditorEdge {
  const color = connectionColor(edge.targetHandle)
  return {
    ...edge,
    style: { ...edge.style, stroke: color },
    markerEnd: { type: MarkerType.ArrowClosed, color }
  }
}

function normalizeLoadedEdges(edges: EditorEdge[]): EditorEdge[] {
  return edges.map((edge) => normalizeEditorEdge(edge))
}

const initialEdges: EditorEdge[] = [
  normalizeEditorEdge({
    id: 'prompt-1-generate-1-prompt',
    source: 'prompt-1',
    sourceHandle: 'prompt',
    target: 'generate-1',
    targetHandle: 'prompt',
    animated: true
  }),
  normalizeEditorEdge({
    id: 'image-1-generate-1-image1',
    source: 'image-1',
    sourceHandle: 'image',
    target: 'generate-1',
    targetHandle: 'image1'
  })
]

function normalizeLoadedNodes(nodes: EditorNode[]): EditorNode[] {
  return nodes.map((node) => {
    if (node.data.kind === 'prompt' && (node.data.title === 'Edit prompt' || node.data.title === 'Prompt')) {
      return { ...node, data: { ...node.data, title: 'Text' } }
    }
    if (node.data.kind === 'image-describe' && (node.data.state === 'queued' || node.data.state === 'running')) {
      return { ...node, data: { ...node.data, state: 'canceled', error: null, startedAtMs: null } }
    }
    if (node.data.kind === 'text-transform' && (node.data.state === 'queued' || node.data.state === 'running')) {
      return { ...node, data: { ...node.data, state: 'canceled', error: null, startedAtMs: null } }
    }
    if (node.data.kind === 'batch-generate' && (node.data.state === 'queued' || node.data.state === 'running')) {
      return { ...node, data: { ...node.data, state: 'canceled', currentFile: null, error: null, startedAtMs: null } }
    }
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

function isSupportedImageFile(file: File): boolean {
  const extension = file.name.split('.').pop()?.toLowerCase()
  return file.type.startsWith('image/') || /^(png|jpe?g|webp|bmp)$/.test(extension ?? '')
}

function generationJobKey(sessionId: string, nodeId: string): string {
  return `${sessionId}:${nodeId}`
}

function promptTextFromNode(node: EditorNode | undefined): string {
  return node?.data.kind === 'prompt' || node?.data.kind === 'image-describe' || node?.data.kind === 'text-transform' ? node.data.text.trim() : ''
}

function Editor(): React.JSX.Element {
  const { fitView, getNodes, getViewport, screenToFlowPosition, setViewport } = useReactFlow()
  const [nodes, setNodes, onNodesChange] = useNodesState<EditorNode>(defaultNodes())
  const [edges, setEdges, onEdgesChange] = useEdgesState<EditorEdge>(defaultEdges())
  const [comfy, setComfy] = useState<ComfyStatus>({ phase: 'starting', message: 'Checking ComfyUI…', managed: false })
  const [comfyTogglePending, setComfyTogglePending] = useState(false)
  const [llm, setLlm] = useState<LlmStatus>(EMPTY_LLM_STATUS)
  const [llmTogglePending, setLlmTogglePending] = useState(false)
  const [llmModelPickerOpen, setLlmModelPickerOpen] = useState(false)
  const [llmModelPickerError, setLlmModelPickerError] = useState<string | null>(null)
  const [llmSettingsOpen, setLlmSettingsOpen] = useState(false)
  const [llmSettingsDraft, setLlmSettingsDraft] = useState<LlmConfig>(EMPTY_LLM_STATUS.config)
  const [llmSettingsError, setLlmSettingsError] = useState<string | null>(null)
  const [settingsTab, setSettingsTab] = useState<'llm' | 'display'>('llm')
  const [showMinimap, setShowMinimap] = useState(() => window.localStorage.getItem(MINIMAP_STORAGE_KEY) !== '0')
  const [snapToGrid, setSnapToGrid] = useState(() => window.localStorage.getItem(SNAP_TO_GRID_STORAGE_KEY) === '1')
  const [showDots, setShowDots] = useState(() => window.localStorage.getItem(DOTS_STORAGE_KEY) !== '0')
  const [library, setLibrary] = useState<LibraryInfo | null>(null)
  const [libraryMenu, setLibraryMenu] = useState<string[] | null>(null)
  const [sessions, setSessions] = useState<SessionRecord[]>([])
  const [activeSession, setActiveSession] = useState<SessionRecord | null>(null)
  const [hydratedSessionId, setHydratedSessionId] = useState<string | null>(null)
  const [canvasViewport, setCanvasViewport] = useState<SessionViewport | null>(null)
  const [viewportRestoreRevision, setViewportRestoreRevision] = useState(0)
  const [sidebarError, setSidebarError] = useState<string | null>(null)
  const [sessionMenuId, setSessionMenuId] = useState<string | null>(null)
  const [sessionMenuPosition, setSessionMenuPosition] = useState<{ left: number; top: number } | null>(null)
  const [renameTarget, setRenameTarget] = useState<SessionRecord | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [renameSaving, setRenameSaving] = useState(false)
  const [previewImage, setPreviewImage] = useState<ImageAsset | null>(null)
  const [screenshotNotice, setScreenshotNotice] = useState<string | null>(null)
  const [statusNotice, setStatusNotice] = useState<{ text: string } | null>(null)
  const [generationProgress, setGenerationProgress] = useState<GenerationProgressEvent | null>(null)
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const storedWidth = Number(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY))
    return Number.isFinite(storedWidth) && storedWidth > 0 ? clampSidebarWidth(storedWidth) : DEFAULT_SIDEBAR_WIDTH
  })
  const [sidebarResizing, setSidebarResizing] = useState(false)
  const [sidebarVisible, setSidebarVisible] = useState(() => window.localStorage.getItem(SIDEBAR_VISIBLE_STORAGE_KEY) !== '0')
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
  const batchCancelRequested = useRef(new Set<string>())
  const batchCurrentJobIds = useRef(new Map<string, string>())
  const imageDescriptionIds = useRef(new Map<string, string>())
  const textTransformationIds = useRef(new Map<string, string>())
  const viewportToRestore = useRef<SessionViewport | null>(null)
  const sidebarResizingRef = useRef(false)
  const sidebarWidthRef = useRef(sidebarWidth)
  activeSessionIdRef.current = activeSession?.id ?? null
  sidebarWidthRef.current = sidebarWidth

  const resizeSidebar = useCallback((event: React.PointerEvent<HTMLDivElement>): void => {
    if (!sidebarResizingRef.current) return
    const width = clampSidebarWidth(event.clientX)
    sidebarWidthRef.current = width
    setSidebarWidth(width)
  }, [])

  const finishSidebarResize = useCallback((event: React.PointerEvent<HTMLDivElement>): void => {
    if (!sidebarResizingRef.current) return
    sidebarResizingRef.current = false
    setSidebarResizing(false)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidthRef.current))
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }, [])

  const startSidebarResize = useCallback((event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    event.preventDefault()
    sidebarResizingRef.current = true
    setSidebarResizing(true)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    event.currentTarget.setPointerCapture(event.pointerId)
  }, [])

  const toggleSidebar = useCallback((): void => {
    setSidebarVisible((current) => {
      const next = !current
      window.localStorage.setItem(SIDEBAR_VISIBLE_STORAGE_KEY, next ? '1' : '0')
      return next
    })
  }, [])

  const resetSidebarWidth = useCallback((): void => {
    sidebarWidthRef.current = DEFAULT_SIDEBAR_WIDTH
    setSidebarWidth(DEFAULT_SIDEBAR_WIDTH)
    window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(DEFAULT_SIDEBAR_WIDTH))
  }, [])

  useEffect(() => {
    void window.imageMixer.getComfyStatus().then(setComfy)
    return window.imageMixer.onComfyStatus(setComfy)
  }, [])

  useEffect(() => {
    void window.imageMixer.getLlmStatus().then((status) => {
      setLlm(status)
      setLlmSettingsDraft(status.config)
    })
    return window.imageMixer.onLlmStatus((status) => {
      setLlm(status)
      if (!llmSettingsOpen) setLlmSettingsDraft(status.config)
    })
  }, [llmSettingsOpen])

  useEffect(() => {
    if (!llmModelPickerOpen) return
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setLlmModelPickerOpen(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [llmModelPickerOpen])

  const toggleComfyUI = useCallback(async (): Promise<void> => {
    if (comfyTogglePending || comfy.phase === 'starting' || comfy.phase === 'stopping') return
    setComfyTogglePending(true)
    try {
      const status = comfy.phase === 'ready'
        ? await window.imageMixer.stopComfyUI()
        : await window.imageMixer.startComfyUI()
      setComfy(status)
    } catch (error) {
      setComfy((current) => ({ ...current, phase: 'error', message: error instanceof Error ? error.message : String(error) }))
    } finally {
      setComfyTogglePending(false)
    }
  }, [comfy.phase, comfyTogglePending])

  const openLlmModelPicker = useCallback(async (): Promise<void> => {
    setLlmModelPickerError(null)
    setLlmModelPickerOpen(true)
    try {
      const status = await window.imageMixer.rescanLlm()
      setLlm(status)
      setLlmSettingsDraft(status.config)
    } catch (error) {
      setLlmModelPickerError(error instanceof Error ? error.message : String(error))
    }
  }, [])

  const selectLlmModel = useCallback(async (selectedModelPath: string): Promise<void> => {
    if (llmTogglePending || llm.phase === 'loading' || llm.phase === 'unloading') return
    setLlmModelPickerOpen(false)
    setLlmModelPickerError(null)
    if (llm.phase === 'ready' && !llm.restartRequired && llm.loadedModelPath === selectedModelPath) return
    setLlmTogglePending(true)
    try {
      let status = await window.imageMixer.updateLlmConfig({ selectedModelPath })
      setLlm(status)
      setLlmSettingsDraft(status.config)
      status = await window.imageMixer.loadLlm()
      setLlm(status)
    } catch (error) {
      setLlm((current) => ({ ...current, phase: 'error', message: error instanceof Error ? error.message : String(error) }))
    } finally {
      setLlmTogglePending(false)
    }
  }, [llm.loadedModelPath, llm.phase, llm.restartRequired, llmTogglePending])

  const toggleLlm = useCallback(async (): Promise<void> => {
    if (llmTogglePending || llm.phase === 'loading' || llm.phase === 'unloading') return
    setLlmTogglePending(true)
    try {
      const shouldUnload = llm.phase === 'ready' && !llm.restartRequired
      setLlm(shouldUnload ? await window.imageMixer.unloadLlm() : await window.imageMixer.loadLlm())
    } catch (error) {
      setLlm((current) => ({ ...current, phase: 'error', message: error instanceof Error ? error.message : String(error) }))
    } finally {
      setLlmTogglePending(false)
    }
  }, [llm.phase, llm.restartRequired, llmTogglePending])

  const openLlmSettings = useCallback((): void => {
    setLlmModelPickerOpen(false)
    setLlmSettingsDraft(llm.config)
    setLlmSettingsError(null)
    setSettingsTab('llm')
    setLlmSettingsOpen(true)
  }, [llm.config])

  const toggleMinimap = useCallback((visible: boolean): void => {
    setShowMinimap(visible)
    window.localStorage.setItem(MINIMAP_STORAGE_KEY, visible ? '1' : '0')
  }, [])

  const toggleSnapToGrid = useCallback((enabled: boolean): void => {
    setSnapToGrid(enabled)
    window.localStorage.setItem(SNAP_TO_GRID_STORAGE_KEY, enabled ? '1' : '0')
  }, [])

  const toggleDots = useCallback((visible: boolean): void => {
    setShowDots(visible)
    window.localStorage.setItem(DOTS_STORAGE_KEY, visible ? '1' : '0')
  }, [])

  const saveLlmSettings = useCallback(async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    try {
      setLlmSettingsError(null)
      const status = await window.imageMixer.updateLlmConfig(llmSettingsDraft)
      setLlm(status)
      setLlmSettingsDraft(status.config)
      setLlmSettingsOpen(false)
    } catch (error) {
      setLlmSettingsError(error instanceof Error ? error.message : String(error))
    }
  }, [llmSettingsDraft])

  const rescanLlm = useCallback(async (): Promise<void> => {
    try {
      setLlmSettingsError(null)
      const status = await window.imageMixer.rescanLlm()
      setLlm(status)
      setLlmSettingsDraft(status.config)
    } catch (error) {
      setLlmSettingsError(error instanceof Error ? error.message : String(error))
    }
  }, [])

  useEffect(() => window.imageMixer.onGenerationStarted(({ sessionId, nodeId, startedAtMs }) => {
    generationStartTimes.current.set(generationJobKey(sessionId, nodeId), startedAtMs)
    setGenerationProgress(null)
    if (activeSessionIdRef.current !== sessionId) return
    setNodes((current) => current.map((node) => (
      node.id === nodeId && node.data.kind === 'generate'
        ? { ...node, data: { ...node.data, state: 'running', durationMs: 0, startedAtMs } }
        : node
    )))
  }), [setNodes])

  useEffect(() => window.imageMixer.onGenerationProgress((progress) => {
    if (activeSessionIdRef.current !== progress.sessionId) return
    setGenerationProgress(progress)
  }), [])

  useEffect(() => {
    if (!statusNotice) return
    const timer = window.setTimeout(() => setStatusNotice(null), 3000)
    return () => window.clearTimeout(timer)
  }, [statusNotice])

  const showStatusNotice = useCallback((text: string): void => {
    setStatusNotice({ text })
  }, [])

  useEffect(() => {
    const removeDelta = window.imageMixer.onImageDescriptionDelta(({ descriptionId, sessionId, nodeId, content }) => {
      if (activeSessionIdRef.current !== sessionId || imageDescriptionIds.current.get(nodeId) !== descriptionId) return
      setNodes((current) => current.map((node) => node.id === nodeId && node.data.kind === 'image-describe'
        ? { ...node, data: { ...node.data, text: content, state: 'running' } }
        : node))
    })
    const removeDone = window.imageMixer.onImageDescriptionDone(({ descriptionId, sessionId, nodeId, content }) => {
      if (imageDescriptionIds.current.get(nodeId) !== descriptionId) return
      imageDescriptionIds.current.delete(nodeId)
      if (activeSessionIdRef.current !== sessionId) return
      setNodes((current) => current.map((node) => node.id === nodeId && node.data.kind === 'image-describe'
        ? { ...node, data: { ...node.data, text: content, state: 'succeeded', error: null, durationMs: node.data.startedAtMs == null ? null : Date.now() - node.data.startedAtMs, startedAtMs: null } }
        : node))
    })
    const removeError = window.imageMixer.onImageDescriptionError(({ descriptionId, sessionId, nodeId, message, canceled }) => {
      if (imageDescriptionIds.current.get(nodeId) !== descriptionId) return
      imageDescriptionIds.current.delete(nodeId)
      if (activeSessionIdRef.current !== sessionId) return
      setNodes((current) => current.map((node) => node.id === nodeId && node.data.kind === 'image-describe'
        ? { ...node, data: { ...node.data, state: canceled ? 'canceled' : 'failed', error: canceled ? null : message, durationMs: node.data.startedAtMs == null ? null : Date.now() - node.data.startedAtMs, startedAtMs: null } }
        : node))
    })
    return () => { removeDelta(); removeDone(); removeError() }
  }, [setNodes])

  useEffect(() => {
    const removeDelta = window.imageMixer.onTextTransformDelta(({ transformationId, sessionId, nodeId, content }) => {
      if (activeSessionIdRef.current !== sessionId || textTransformationIds.current.get(nodeId) !== transformationId) return
      setNodes((current) => current.map((node) => node.id === nodeId && node.data.kind === 'text-transform'
        ? { ...node, data: { ...node.data, text: content, state: 'running' } }
        : node))
    })
    const removeDone = window.imageMixer.onTextTransformDone(({ transformationId, sessionId, nodeId, content }) => {
      if (textTransformationIds.current.get(nodeId) !== transformationId) return
      textTransformationIds.current.delete(nodeId)
      if (activeSessionIdRef.current !== sessionId) return
      setNodes((current) => current.map((node) => node.id === nodeId && node.data.kind === 'text-transform'
        ? { ...node, data: { ...node.data, text: content, state: 'succeeded', error: null, durationMs: node.data.startedAtMs == null ? null : Date.now() - node.data.startedAtMs, startedAtMs: null } }
        : node))
    })
    const removeError = window.imageMixer.onTextTransformError(({ transformationId, sessionId, nodeId, message, canceled }) => {
      if (textTransformationIds.current.get(nodeId) !== transformationId) return
      textTransformationIds.current.delete(nodeId)
      if (activeSessionIdRef.current !== sessionId) return
      setNodes((current) => current.map((node) => node.id === nodeId && node.data.kind === 'text-transform'
        ? { ...node, data: { ...node.data, state: canceled ? 'canceled' : 'failed', error: canceled ? null : message, durationMs: node.data.startedAtMs == null ? null : Date.now() - node.data.startedAtMs, startedAtMs: null } }
        : node))
    })
    return () => { removeDelta(); removeDone(); removeError() }
  }, [setNodes])

  useEffect(() => {
    const closeMenus = (): void => {
      setSessionMenuId(null)
      setNodeContextMenu(null)
      setLibraryMenu(null)
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
    setEdges(hasSavedNodes ? normalizeLoadedEdges(bootstrap.snapshot.edges as EditorEdge[]) : defaultEdges())
    viewportToRestore.current = bootstrap.snapshot.viewport ?? null
    setCanvasViewport(bootstrap.snapshot.viewport ?? null)
    setViewportRestoreRevision((current) => current + 1)
    setHydratedSessionId(bootstrap.activeSession.id)
    setSidebarError(null)
  }, [setEdges, setNodes])

  useEffect(() => {
    if (!activeSession || hydratedSessionId !== activeSession.id) return
    const frame = window.requestAnimationFrame(() => {
      const savedViewport = viewportToRestore.current
      viewportToRestore.current = null
      if (savedViewport) void setViewport(savedViewport, { duration: 0 })
      else void fitView({ padding: 0.1 })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [activeSession?.id, fitView, hydratedSessionId, setViewport, viewportRestoreRevision])

  useEffect(() => {
    void window.imageMixer.bootstrapLibrary().then(applyBootstrap).catch((error: unknown) => {
      setSidebarError(error instanceof Error ? error.message : String(error))
    })
  }, [applyBootstrap])

  useEffect(() => {
    if (!activeSession || hydratedSessionId !== activeSession.id) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      const snapshot: SessionSnapshot = { nodes, edges, viewport: canvasViewport ?? getViewport() }
      void window.imageMixer.saveSession(activeSession.id, snapshot).catch((error: unknown) => {
        setSidebarError(error instanceof Error ? error.message : String(error))
      })
    }, 500)
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
    }
  }, [activeSession, canvasViewport, edges, getViewport, hydratedSessionId, nodes])

  const updateNode = useCallback((nodeId: string, patch: Partial<EditorData>) => {
    setNodes((current) => current.map((node) => node.id === nodeId ? { ...node, data: { ...node.data, ...patch } as EditorData } : node))
  }, [setNodes])

  const describeImage = useCallback(async (nodeId: string): Promise<void> => {
    if (!activeSession || llm.phase !== 'ready' || llm.restartRequired) return
    const target = nodes.find((node) => node.id === nodeId)
    if (!target || target.data.kind !== 'image-describe' || target.data.state === 'running') return
    const imageEdge = edges.find((edge) => edge.target === nodeId && edge.targetHandle === 'image')
    const source = nodes.find((node) => node.id === imageEdge?.source)
    const imagePath = source?.data.kind === 'image' ? source.data.image?.path : source?.data.kind === 'generate' ? source.data.result?.path : null
    if (!imagePath) {
      updateNode(nodeId, { state: 'failed', error: '画像が読み込まれたImageノード、または生成結果を接続してください。', durationMs: null })
      return
    }

    const descriptionId = crypto.randomUUID()
    const startedAtMs = Date.now()
    imageDescriptionIds.current.set(nodeId, descriptionId)
    updateNode(nodeId, { text: '', state: 'running', error: null, durationMs: null, startedAtMs })
    try {
      await window.imageMixer.startImageDescription({
        descriptionId,
        sessionId: activeSession.id,
        nodeId,
        imagePath,
        systemPrompt: target.data.systemPrompt
      })
    } catch (error) {
      imageDescriptionIds.current.delete(nodeId)
      updateNode(nodeId, { state: 'failed', error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - startedAtMs, startedAtMs: null })
    }
  }, [activeSession, edges, llm.phase, llm.restartRequired, nodes, updateNode])

  const cancelImageDescription = useCallback(async (nodeId: string): Promise<void> => {
    const descriptionId = imageDescriptionIds.current.get(nodeId)
    if (!descriptionId) {
      updateNode(nodeId, { state: 'canceled', error: null, startedAtMs: null })
      return
    }
    const canceled = await window.imageMixer.cancelImageDescription(descriptionId)
    if (!canceled) {
      imageDescriptionIds.current.delete(nodeId)
      updateNode(nodeId, { state: 'canceled', error: null, startedAtMs: null })
    }
  }, [updateNode])

  const transformText = useCallback(async (nodeId: string): Promise<void> => {
    if (!activeSession || llm.phase !== 'ready' || llm.restartRequired) return
    const target = nodes.find((node) => node.id === nodeId)
    if (!target || target.data.kind !== 'text-transform' || target.data.state === 'running') return
    const instruction = target.data.instruction.trim()
    if (!instruction) {
      updateNode(nodeId, { state: 'failed', error: '加工指示を入力してください。', durationMs: null })
      return
    }
    const textEdge = edges.find((edge) => edge.target === nodeId && edge.targetHandle === 'text')
    const sourceText = promptTextFromNode(nodes.find((node) => node.id === textEdge?.source))
    const transformationId = crypto.randomUUID()
    const startedAtMs = Date.now()
    textTransformationIds.current.set(nodeId, transformationId)
    updateNode(nodeId, { text: '', state: 'running', error: null, durationMs: null, startedAtMs })
    try {
      await window.imageMixer.startTextTransform({
        transformationId,
        sessionId: activeSession.id,
        nodeId,
        sourceText,
        instruction,
        systemPrompt: target.data.systemPrompt
      })
    } catch (error) {
      textTransformationIds.current.delete(nodeId)
      updateNode(nodeId, { state: 'failed', error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - startedAtMs, startedAtMs: null })
    }
  }, [activeSession, edges, llm.phase, llm.restartRequired, nodes, updateNode])

  const cancelTextTransform = useCallback(async (nodeId: string): Promise<void> => {
    const transformationId = textTransformationIds.current.get(nodeId)
    if (!transformationId) {
      updateNode(nodeId, { state: 'canceled', error: null, startedAtMs: null })
      return
    }
    const canceled = await window.imageMixer.cancelTextTransform(transformationId)
    if (!canceled) {
      textTransformationIds.current.delete(nodeId)
      updateNode(nodeId, { state: 'canceled', error: null, startedAtMs: null })
    }
  }, [updateNode])

  const chooseBatchFolder = useCallback(async (nodeId: string) => {
    try {
      const folder = await window.imageMixer.chooseBatchFolder()
      if (folder) updateNode(nodeId, { folder, error: null })
    } catch (error) {
      updateNode(nodeId, { error: error instanceof Error ? error.message : String(error) })
    }
  }, [updateNode])

  const chooseImage = useCallback(async (nodeId: string) => {
    if (!activeSession) return
    const image = await window.imageMixer.chooseImage(activeSession.id)
    if (image) updateNode(nodeId, { image })
  }, [activeSession, updateNode])

  const dropImage = useCallback(async (nodeId: string, file: File) => {
    if (!activeSession) return
    if (!isSupportedImageFile(file)) {
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

  const dragImageOverCanvas = useCallback((event: React.DragEvent): void => {
    if (!event.dataTransfer.types.includes('Files')) return
    if (event.target instanceof Element && event.target.closest('.react-flow__node')) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }, [])

  const dropImageOnCanvas = useCallback(async (event: React.DragEvent): Promise<void> => {
    if (event.target instanceof Element && event.target.closest('.react-flow__node')) return
    event.preventDefault()
    const file = event.dataTransfer.files[0]
    if (!file || !activeSession) return
    if (!isSupportedImageFile(file)) {
      setSidebarError('画像ファイルをドロップしてください。')
      return
    }
    const sessionId = activeSession.id
    const position = screenToFlowPosition({ x: event.clientX, y: event.clientY })
    try {
      const image = await window.imageMixer.importDroppedImage(file, sessionId)
      if (activeSessionIdRef.current !== sessionId) throw new Error('セッションが切り替わりました。もう一度ドロップしてください。')
      const title = file.name.replace(/\.[^.]+$/, '').trim() || 'Image'
      setNodes((current) => [...current, {
        id: `image-${crypto.randomUUID()}`,
        type: 'editor',
        position,
        data: { kind: 'image', title, image }
      }])
      setSidebarError(null)
    } catch (error) {
      setSidebarError(error instanceof Error ? error.message : String(error))
    }
  }, [activeSession, screenToFlowPosition, setNodes])

  const generate = useCallback(async (nodeId: string) => {
    if (!activeSession) return
    const sessionId = activeSession.id
    const target = nodes.find((node) => node.id === nodeId)
    if (!target || target.data.kind !== 'generate' || target.data.state === 'queued' || target.data.state === 'running') return
    const promptEdge = edges.find((edge) => edge.target === nodeId && edge.targetHandle === 'prompt')
    const promptNode = nodes.find((node) => node.id === promptEdge?.source)
    const prompt = promptTextFromNode(promptNode)
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
      updateNode(nodeId, { state: 'failed', error: 'Text、Image Describe、またはText Transformノードを接続し、テキストを入力してください。', durationMs: null })
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
      setGenerationProgress((current) => current?.nodeId === nodeId ? null : current)
      if (activeSessionIdRef.current === sessionId) {
        updateNode(nodeId, { state: 'succeeded', result, error: null, durationMs: startedAtMs == null ? null : Date.now() - startedAtMs, startedAtMs: null })
        showStatusNotice(`生成が完了しました: ${target.data.title}`)
      }
    } catch (error) {
      const startedAtMs = generationStartTimes.current.get(key)
      generationStartTimes.current.delete(key)
      const wasCanceled = canceledGenerationIds.current.delete(key) || (error instanceof Error && error.message === 'Generation canceled')
      setGenerationProgress((current) => current?.nodeId === nodeId ? null : current)
      if (activeSessionIdRef.current === sessionId) {
        updateNode(nodeId, wasCanceled
          ? { state: 'canceled', error: null, durationMs: startedAtMs == null ? null : Date.now() - startedAtMs, startedAtMs: null }
          : { state: 'failed', error: error instanceof Error ? error.message : String(error), durationMs: startedAtMs == null ? null : Date.now() - startedAtMs, startedAtMs: null })
        showStatusNotice(wasCanceled ? `生成をキャンセルしました: ${target.data.title}` : `生成に失敗しました: ${target.data.title}`)
      }
    }
  }, [activeSession, edges, nodes, showStatusNotice, updateNode])

  const runBatch = useCallback(async (nodeId: string) => {
    if (!activeSession) return
    const sessionId = activeSession.id
    const target = nodes.find((node) => node.id === nodeId)
    if (!target || target.data.kind !== 'batch-generate' || !target.data.folder || target.data.state === 'running') return
    const promptEdge = edges.find((edge) => edge.target === nodeId && edge.targetHandle === 'prompt')
    const promptNode = nodes.find((node) => node.id === promptEdge?.source)
    const prompt = promptTextFromNode(promptNode)
    if (!prompt) {
      updateNode(nodeId, { state: 'failed', error: 'Text、Image Describe、またはText Transformノードを接続し、テキストを入力してください。' })
      return
    }

    const referencePaths: Array<string | null> = []
    const referenceSourceNodeIds: Array<string | null> = []
    for (const handle of ['image2', 'image3']) {
      const edge = edges.find((candidate) => candidate.target === nodeId && candidate.targetHandle === handle)
      const source = nodes.find((node) => node.id === edge?.source)
      if (source?.data.kind === 'image' && source.data.image) {
        referencePaths.push(source.data.image.path)
        referenceSourceNodeIds.push(null)
      } else if (source?.data.kind === 'generate') {
        if (!source.data.result && source.data.state !== 'queued' && source.data.state !== 'running') {
          updateNode(nodeId, { state: 'failed', error: handle + 'へ結果のあるImage Generateノードを接続してください。' })
          return
        }
        referencePaths.push(source.data.result?.path ?? null)
        referenceSourceNodeIds.push(source.id)
      } else {
        referencePaths.push(null)
        referenceSourceNodeIds.push(null)
        if (edge) {
          updateNode(nodeId, { state: 'failed', error: handle + 'へ解像度を取得できる画像を接続してください。' })
          return
        }
      }
    }

    const batchKey = generationJobKey(sessionId, nodeId)
    const startedAtMs = Date.now()
    batchCancelRequested.current.delete(batchKey)
    updateNode(nodeId, { state: 'running', error: null, outputDirectory: null, total: 0, completed: 0, succeeded: 0, failed: 0, currentFile: 'フォルダを確認中…', durationMs: null, startedAtMs })
    try {
      const preparation = await window.imageMixer.prepareBatchFolder(target.data.folder.path)
      const manifestItems: BatchManifestItem[] = []
      let succeeded = 0
      let failed = 0
      let completed = 0
      let latestResult: GeneratedImage | null = null
      updateNode(nodeId, { folder: { ...target.data.folder, imageCount: preparation.files.length }, outputDirectory: preparation.outputDirectory, total: preparation.files.length, currentFile: preparation.files[0]?.name ?? null })

      for (let index = 0; index < preparation.files.length; index += 1) {
        if (batchCancelRequested.current.has(batchKey)) break
        const file = preparation.files[index]
        updateNode(nodeId, { currentFile: file.name })
        let settings = { ...target.data.settings, width: normalizeImageDimension(target.data.settings.width), height: normalizeImageDimension(target.data.settings.height) }
        if (target.data.matchInputSize) {
          if (!file.width || !file.height) {
            failed += 1
            completed += 1
            manifestItems.push({ inputPath: file.path, outputPath: null, seed: settings.seed, settings, error: '画像サイズを取得できませんでした。' })
            updateNode(nodeId, { completed, succeeded, failed })
            continue
          }
          const scale = Math.min(1, MAX_IMAGE_DIMENSION / file.width, MAX_IMAGE_DIMENSION / file.height)
          settings = { ...settings, width: normalizeImageDimension(file.width * scale), height: normalizeImageDimension(file.height * scale) }
        }
        const jobNodeId = nodeId + '-batch-' + crypto.randomUUID()
        batchCurrentJobIds.current.set(batchKey, jobNodeId)
        try {
          const generated = await window.imageMixer.generateImage({
            nodeId: jobNodeId,
            sessionId,
            prompt,
            imagePaths: [file.path, ...referencePaths],
            imageSourceNodeIds: [null, ...referenceSourceNodeIds],
            settings,
            transient: true
          })
          const saved = await window.imageMixer.saveBatchGeneratedImage(sessionId, generated, file.path, preparation.outputDirectory, index)
          latestResult = saved
          succeeded += 1
          manifestItems.push({ inputPath: file.path, outputPath: saved.path, seed: settings.seed, settings, error: null })
        } catch (error) {
          if (batchCancelRequested.current.has(batchKey) || (error instanceof Error && error.message === 'Generation canceled')) break
          failed += 1
          manifestItems.push({ inputPath: file.path, outputPath: null, seed: settings.seed, settings, error: error instanceof Error ? error.message : String(error) })
        } finally {
          generationStartTimes.current.delete(generationJobKey(sessionId, jobNodeId))
          batchCurrentJobIds.current.delete(batchKey)
        }
        completed += 1
        updateNode(nodeId, { completed, succeeded, failed, result: latestResult })
      }

      const canceled = batchCancelRequested.current.has(batchKey)
      const manifest: BatchManifest = {
        createdAt: new Date().toISOString(),
        inputDirectory: preparation.inputDirectory,
        outputDirectory: preparation.outputDirectory,
        prompt,
        settings: target.data.settings,
        matchInputSize: target.data.matchInputSize,
        items: manifestItems
      }
      await window.imageMixer.writeBatchManifest(preparation.outputDirectory, manifest)
      updateNode(nodeId, {
        state: canceled ? 'canceled' : succeeded === 0 && failed > 0 ? 'failed' : 'succeeded',
        result: latestResult,
        completed,
        succeeded,
        failed,
        currentFile: null,
        error: !canceled && failed > 0 ? failed + '件の処理に失敗しました。batch-result.jsonを確認してください。' : null,
        durationMs: Date.now() - startedAtMs,
        startedAtMs: null
      })
      showStatusNotice(canceled ? '一括処理をキャンセルしました' : `一括処理が完了しました (成功 ${succeeded} / 失敗 ${failed})`)
    } catch (error) {
      updateNode(nodeId, { state: batchCancelRequested.current.has(batchKey) ? 'canceled' : 'failed', currentFile: null, error: batchCancelRequested.current.has(batchKey) ? null : error instanceof Error ? error.message : String(error), durationMs: Date.now() - startedAtMs, startedAtMs: null })
    } finally {
      batchCurrentJobIds.current.delete(batchKey)
      batchCancelRequested.current.delete(batchKey)
      setGenerationProgress(null)
    }
  }, [activeSession, edges, nodes, showStatusNotice, updateNode])

  const cancelBatch = useCallback(async (nodeId: string) => {
    if (!activeSession) return
    const batchKey = generationJobKey(activeSession.id, nodeId)
    batchCancelRequested.current.add(batchKey)
    const currentJobId = batchCurrentJobIds.current.get(batchKey)
    if (currentJobId) {
      try { await window.imageMixer.cancelGeneration(activeSession.id, currentJobId) } catch { /* The batch loop records the final state. */ }
    }
    updateNode(nodeId, { state: 'canceled', currentFile: null, error: null })
  }, [activeSession, updateNode])

  const revealBatchOutput = useCallback(async (nodeId: string) => {
    const target = nodes.find((node) => node.id === nodeId)
    if (!target || target.data.kind !== 'batch-generate' || !target.data.outputDirectory) return
    try {
      await window.imageMixer.revealBatchOutput(target.data.outputDirectory)
    } catch (error) {
      updateNode(nodeId, { error: error instanceof Error ? error.message : String(error) })
    }
  }, [nodes, updateNode])

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
      showStatusNotice('生成画像をクリップボードへコピーしました')
      return true
    } catch (error) {
      updateNode(nodeId, { error: error instanceof Error ? error.message : String(error) })
      return false
    }
  }, [nodes, showStatusNotice, updateNode])

  const saveResult = useCallback(async (nodeId: string): Promise<boolean> => {
    const target = nodes.find((node) => node.id === nodeId)
    const result = target?.data.kind === 'generate' ? target.data.result : null
    if (!result) return false
    try {
      const saved = await window.imageMixer.saveImageCopy(result.path)
      if (saved) showStatusNotice('生成画像を保存しました')
      return saved
    } catch (error) {
      updateNode(nodeId, { error: error instanceof Error ? error.message : String(error) })
      return false
    }
  }, [nodes, showStatusNotice, updateNode])

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
        .filter((edge) => selectedIds.has(edge.source) || selectedIds.has(edge.target))
        .map((edge) => structuredClone({ ...edge, selected: false })),
      boundsCenter: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 },
      pasteCount: 0
    }
    setSidebarError(null)
    showStatusNotice(`${selectedNodes.length}個のノードをコピーしました`)
    return true
  }, [activeSession, edges, nodes, showStatusNotice])

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
        if (pasted.data.kind === 'image-describe' && (pasted.data.state === 'queued' || pasted.data.state === 'running')) {
          pasted.data.state = 'canceled'
          pasted.data.error = null
          pasted.data.startedAtMs = null
        }
        if (pasted.data.kind === 'text-transform' && (pasted.data.state === 'queued' || pasted.data.state === 'running')) {
          pasted.data.state = 'canceled'
          pasted.data.error = null
          pasted.data.startedAtMs = null
        }
        if (pasted.data.kind === 'batch-generate' && (pasted.data.state === 'queued' || pasted.data.state === 'running')) {
          pasted.data.state = 'canceled'
          pasted.data.currentFile = null
          pasted.data.error = null
          pasted.data.startedAtMs = null
        }
        return pasted
      })
      const existingNodeIds = new Set(nodes.map((node) => node.id))
      const occupiedExistingTargetPins = new Set(edges.map((edge) => JSON.stringify([edge.target, edge.targetHandle ?? null])))
      const pastedEdges: EditorEdge[] = clipboard.edges.flatMap((edge) => {
        const source = idMap.get(edge.source) ?? (!isCrossSessionPaste && existingNodeIds.has(edge.source) ? edge.source : null)
        const target = idMap.get(edge.target) ?? (!isCrossSessionPaste && existingNodeIds.has(edge.target) ? edge.target : null)
        if (!source || !target) return []
        if (!idMap.has(edge.target)) {
          const targetPinKey = JSON.stringify([target, edge.targetHandle ?? null])
          if (occupiedExistingTargetPins.has(targetPinKey)) return []
          occupiedExistingTargetPins.add(targetPinKey)
        }
        return [normalizeEditorEdge({
          ...structuredClone(edge),
          id: crypto.randomUUID(),
          source,
          target,
          selected: false
        })]
      })
      setNodes((current) => [...current.map((node) => ({ ...node, selected: false })), ...pastedNodes])
      setEdges((current) => [...current.map((edge) => ({ ...edge, selected: false })), ...pastedEdges])
      setSidebarError(null)
      showStatusNotice(`${pastedNodes.length}個のノードを貼り付けました`)
      return true
    } catch (error) {
      setSidebarError(`ノードを貼り付けられませんでした: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }, [activeSession, edges, nodes, screenToFlowPosition, setEdges, setNodes, showStatusNotice])

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
    if (!source || !target) return false
    if (target.data.kind === 'image-describe') {
      if (connection.targetHandle !== 'image' || (source.data.kind !== 'image' && source.data.kind !== 'generate')) return false
    } else if (target.data.kind === 'text-transform') {
      if (connection.targetHandle !== 'text' || (source.data.kind !== 'prompt' && source.data.kind !== 'image-describe' && source.data.kind !== 'text-transform')) return false
    } else {
      if (target.data.kind !== 'generate' && target.data.kind !== 'batch-generate') return false
      if (connection.targetHandle === 'prompt' && source.data.kind !== 'prompt' && source.data.kind !== 'image-describe' && source.data.kind !== 'text-transform') return false
      if (connection.targetHandle.startsWith('image') && source.data.kind !== 'image' && source.data.kind !== 'generate') return false
    }
    if (hasPath(edges, connection.target, connection.source)) return false
    return true
  }, [edges, nodes])

  const onConnect = useCallback((connection: Connection) => {
    if (!isValidConnection(connection)) return
    setEdges((current) => {
      const withoutExisting = current.filter((edge) => !(edge.target === connection.target && edge.targetHandle === connection.targetHandle))
      return addEdge(normalizeEditorEdge({
        ...connection,
        id: crypto.randomUUID(),
        animated: connection.targetHandle === 'prompt' || connection.targetHandle === 'text'
      } as EditorEdge), withoutExisting)
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

  const hasDescribeImageInput = useCallback((nodeId: string): boolean => {
    const edge = edges.find((candidate) => candidate.target === nodeId && candidate.targetHandle === 'image')
    const source = nodes.find((node) => node.id === edge?.source)
    return Boolean(source?.data.kind === 'image' ? source.data.image : source?.data.kind === 'generate' ? source.data.result : null)
  }, [edges, nodes])

  const addNode = useCallback((kind: EditorData['kind'], requestedPosition?: { x: number; y: number }) => {
    const id = `${kind}-${crypto.randomUUID()}`
    const position = requestedPosition ?? { x: 220 + Math.random() * 380, y: 120 + Math.random() * 360 }
    let data: EditorData
    if (kind === 'prompt') data = { kind, title: 'Text', text: '' }
    else if (kind === 'image') data = { kind, title: 'Image', image: null }
    else if (kind === 'image-describe') data = {
      kind,
      title: 'Image Describe',
      text: '',
      systemPrompt: '',
      systemPromptOpen: false,
      state: 'idle',
      error: null,
      durationMs: null,
      startedAtMs: null
    }
    else if (kind === 'text-transform') data = {
      kind,
      title: 'Text Transform',
      instruction: '',
      text: '',
      systemPrompt: '',
      systemPromptOpen: false,
      state: 'idle',
      error: null,
      durationMs: null,
      startedAtMs: null
    }
    else if (kind === 'batch-generate') data = {
      kind,
      title: 'Batch Image Generate',
      folder: null,
      settings: { width: 768, height: 768, seed: Math.floor(Math.random() * 2147483647), steps: 4, cfg: 1 },
      matchInputSize: true,
      state: 'idle',
      result: null,
      outputDirectory: null,
      total: 0,
      completed: 0,
      succeeded: 0,
      failed: 0,
      currentFile: null,
      error: null,
      durationMs: null,
      startedAtMs: null
    }
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
    const menuHeight = 248
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
    await window.imageMixer.saveSession(activeSession.id, { nodes, edges, viewport: getViewport() })
  }, [activeSession, edges, getViewport, hydratedSessionId, nodes])

  const chooseLibrary = useCallback(async () => {
    try {
      await saveCurrentSession()
      const bootstrap = await window.imageMixer.chooseLibrary()
      if (bootstrap) applyBootstrap(bootstrap)
    } catch (error) {
      setSidebarError(error instanceof Error ? error.message : String(error))
    }
  }, [applyBootstrap, saveCurrentSession])

  const toggleLibraryMenu = useCallback(async () => {
    setSessionMenuId(null)
    if (libraryMenu) {
      setLibraryMenu(null)
      return
    }
    try {
      setLibraryMenu(await window.imageMixer.getRecentLibraries())
    } catch (error) {
      setSidebarError(error instanceof Error ? error.message : String(error))
    }
  }, [libraryMenu])

  const openRecentLibrary = useCallback(async (rootPath: string) => {
    setLibraryMenu(null)
    try {
      await saveCurrentSession()
      applyBootstrap(await window.imageMixer.openLibrary(rootPath))
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
      viewportToRestore.current = null
      setCanvasViewport(null)
      setViewportRestoreRevision((current) => current + 1)
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
      setEdges(hasSavedNodes ? normalizeLoadedEdges(loaded.snapshot.edges as EditorEdge[]) : defaultEdges())
      viewportToRestore.current = loaded.snapshot.viewport ?? null
      setCanvasViewport(loaded.snapshot.viewport ?? null)
      setViewportRestoreRevision((current) => current + 1)
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
      setEdges(hasSavedNodes ? normalizeLoadedEdges(duplicated.snapshot.edges as EditorEdge[]) : defaultEdges())
      viewportToRestore.current = duplicated.snapshot.viewport ?? null
      setCanvasViewport(duplicated.snapshot.viewport ?? null)
      setViewportRestoreRevision((current) => current + 1)
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
    llmReady: llm.phase === 'ready' && !llm.restartRequired,
    llmVisionReady: llm.phase === 'ready' && !llm.restartRequired && Boolean(llm.models.find((model) => model.path === llm.loadedModelPath)?.mmprojPath),
    hasImageInput,
    hasDescribeImageInput,
    updateNode,
    chooseBatchFolder,
    runBatch,
    cancelBatch,
    revealBatchOutput,
    chooseImage,
    dropImage,
    generate,
    cancelGeneration,
    describeImage,
    cancelImageDescription,
    transformText,
    cancelTextTransform,
    copyResult,
    saveResult,
    previewResult: setPreviewImage
  }), [cancelBatch, cancelGeneration, cancelImageDescription, cancelTextTransform, chooseBatchFolder, chooseImage, comfy.phase, copyResult, describeImage, dropImage, generate, hasDescribeImageInput, hasImageInput, llm.loadedModelPath, llm.models, llm.phase, llm.restartRequired, revealBatchOutput, runBatch, saveResult, transformText, updateNode])

  const nodeTypes = useMemo(() => ({ editor: EditorNodeComponent }), [])
  const generationActivity = useMemo(() => {
    const runningNode = nodes.find((node) => (node.data.kind === 'generate' || node.data.kind === 'batch-generate') && node.data.state === 'running')
    const queuedCount = nodes.filter((node) => node.data.kind === 'generate' && node.data.state === 'queued').length
    if (!runningNode) return queuedCount > 0 ? { title: null, percent: null, queuedCount } : null
    const matchesRunning = generationProgress != null && (generationProgress.nodeId === runningNode.id || generationProgress.nodeId.startsWith(`${runningNode.id}-batch-`))
    const percent = matchesRunning && generationProgress.max > 0
      ? Math.min(100, Math.round((generationProgress.value / generationProgress.max) * 100))
      : null
    return { title: runningNode.data.title, percent, queuedCount }
  }, [generationProgress, nodes])
  const selectedLlmModel = llm.models.find((model) => model.path === llm.config.selectedModelPath) ?? null
  const loadedLlmModel = llm.models.find((model) => model.path === llm.loadedModelPath) ?? null
  const llmBusy = llmTogglePending || llm.phase === 'loading' || llm.phase === 'unloading'
  const llmLoaded = llm.phase === 'ready' && !llm.restartRequired && loadedLlmModel != null
  const llmBarState = llmBusy ? 'busy' : llm.phase === 'error' ? 'error' : llm.restartRequired ? 'restart' : llmLoaded ? 'loaded' : 'unloaded'

  return (
    <EditorContext.Provider value={actions}>
      <main className='app-shell'>
        <header className='topbar'>
          <button
            type='button'
            className='sidebar-toggle-button'
            title={sidebarVisible ? 'サイドバーを隠す' : 'サイドバーを表示'}
            aria-label={sidebarVisible ? 'サイドバーを隠す' : 'サイドバーを表示'}
            aria-pressed={sidebarVisible}
            onClick={toggleSidebar}
          >
            <svg viewBox='0 0 24 24' aria-hidden='true'><rect x='3' y='4' width='18' height='16' rx='2' /><path d='M9.5 4v16' /></svg>
          </button>
          <div className='llm-model-control'>
            <button
              type='button'
              className={`llm-model-trigger state-${llmBarState}`}
              title={llm.message}
              aria-haspopup='dialog'
              aria-expanded={llmModelPickerOpen}
              disabled={llmBusy}
              onClick={() => void openLlmModelPicker()}
            >
              <svg className='llm-model-icon' viewBox='0 0 24 24' aria-hidden='true'><path d='M9 3v2M15 3v2M9 19v2M15 19v2M3 9h2M3 15h2M19 9h2M19 15h2' /><rect x='5' y='5' width='14' height='14' rx='3' /><rect x='9' y='9' width='6' height='6' rx='1.5' /></svg>
              <strong className='llm-model-trigger-name'>{llmBusy ? (llm.phase === 'unloading' ? 'Unloading…' : 'Loading…') : selectedLlmModel ? displayModelName(selectedLlmModel.name) : 'Select a model'}</strong>
              <svg className={`llm-model-chevron ${llmBusy ? 'spinning' : ''}`} viewBox='0 0 24 24' aria-hidden='true'>{llmBusy ? <path d='M20 12a8 8 0 1 1-2.34-5.66' /> : <path d='m7 10 5 5 5-5' />}</svg>
            </button>
            <button
              type='button'
              className={`llm-toggle status-${llm.phase}`}
              disabled={llmBusy || !llm.serverPath || !llm.config.selectedModelPath}
              title={`${llmLoaded ? 'モデルをアンロード' : llm.restartRequired ? 'モデルを再ロード' : '選択中のモデルをロード'}: ${llm.message}`}
              aria-label={llmLoaded ? 'モデルをアンロード' : llm.restartRequired ? 'モデルを再ロード' : '選択中のモデルをロード'}
              onClick={() => void toggleLlm()}
            >
              {llmBusy ? (
                <svg className='llm-toggle-icon spinning' viewBox='0 0 24 24' aria-hidden='true'><path d='M20 12a8 8 0 1 1-2.34-5.66' /></svg>
              ) : llmLoaded ? (
                <svg className='llm-toggle-icon' viewBox='0 0 24 24' aria-hidden='true'><path d='m12 3 8 9H4l8-9Z' /><rect x='4' y='17' width='16' height='3' rx='1' /></svg>
              ) : (
                <svg className='llm-toggle-icon' viewBox='0 0 24 24' aria-hidden='true'><path d='M12 4v11m-4-4 4 4 4-4' /><path d='M5 19h14' /></svg>
              )}
            </button>
          </div>
          <button
            type='button'
            className={'comfy-status status-' + comfy.phase}
            title={comfy.phase === 'ready' && !comfy.managed ? comfy.message + '（外部プロセスはアプリからUnloadできません）' : comfy.message}
            disabled={comfyTogglePending || comfy.phase === 'starting' || comfy.phase === 'stopping' || (comfy.phase === 'ready' && !comfy.managed)}
            aria-pressed={comfy.phase === 'ready'}
            onClick={() => void toggleComfyUI()}
          >
            <span className='comfy-status-dot' />
            <strong>ComfyUI</strong>
            <span className='comfy-toggle-label'>{comfy.phase === 'ready' ? 'Unload' : comfy.phase === 'starting' ? 'Loading…' : comfy.phase === 'stopping' ? 'Unloading…' : 'Load'}</span>
          </button>
          <button type='button' className='llm-settings-button' title='設定' aria-label='設定' onClick={openLlmSettings}>
            <svg viewBox='0 0 24 24' aria-hidden='true'><path d='M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z' /><path d='M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V21h-4v-.08A1.7 1.7 0 0 0 8.96 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.03H3v-4h.08A1.7 1.7 0 0 0 4.6 8.94a1.7 1.7 0 0 0-.34-1.88L4.2 7l2.83-2.83.06.06a1.7 1.7 0 0 0 1.88.34A1.7 1.7 0 0 0 10 3.01V3h4v.08a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9a1.7 1.7 0 0 0 1.56 1.03H21v4h-.08A1.7 1.7 0 0 0 19.4 15Z' /></svg>
          </button>
        </header>
        <div className='workspace' style={{ gridTemplateColumns: sidebarVisible ? sidebarWidth + 'px 0 minmax(0, 1fr)' : 'minmax(0, 1fr)' }}>
          {sidebarVisible && <aside className='left-sidebar'>
            <section className='library-section' onPointerDown={(event) => event.stopPropagation()}>
              <div className='sidebar-label'>ROOT FOLDER</div>
              <button type='button' className='library-button' onClick={() => void toggleLibraryMenu()} title={library?.rootPath} aria-haspopup='menu' aria-expanded={libraryMenu != null}>
                <span className='folder-icon'>▰</span>
                <span><strong>{library?.name ?? 'Loading…'}</strong><small>{library?.rootPath ?? 'ルートフォルダを読み込み中'}</small></span>
                <span className='chevron'>›</span>
              </button>
              {libraryMenu && (
                <div className='library-menu' role='menu'>
                  <button type='button' role='menuitem' onClick={() => { setLibraryMenu(null); void chooseLibrary() }}>
                    <strong>フォルダを選択…</strong>
                  </button>
                  {libraryMenu.length > 0 && <div className='library-menu-separator' aria-hidden='true' />}
                  {libraryMenu.map((path) => (
                    <button key={path} type='button' role='menuitem' title={path} onClick={() => void openRecentLibrary(path)}>
                      <strong>{path.split(/[\\/]/).pop() || path}</strong>
                      <small>{path}</small>
                    </button>
                  ))}
                </div>
              )}
            </section>

            <section className='sessions-section'>
              <div className='sessions-heading'>
                <div><div className='sidebar-label'>SESSIONS</div><small>{sessions.length} sessions</small></div>
                <button type='button' className='add-session-button' onClick={() => void createSession()} title='新規セッション' aria-label='新規セッション'>
                  <svg viewBox='0 0 24 24' aria-hidden='true'><path d='M12 5v14M5 12h14' /></svg>
                </button>
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
                      >
                        <svg viewBox='0 0 24 24' aria-hidden='true'><circle cx='5' cy='12' r='1.7' /><circle cx='12' cy='12' r='1.7' /><circle cx='19' cy='12' r='1.7' /></svg>
                      </button>
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
          </aside>}

          {sidebarVisible && <div
            className={sidebarResizing ? 'sidebar-resizer resizing' : 'sidebar-resizer'}
            role='separator'
            aria-label='左サイドバーの幅を変更'
            aria-orientation='vertical'
            aria-valuemin={MIN_SIDEBAR_WIDTH}
            aria-valuemax={MAX_SIDEBAR_WIDTH}
            aria-valuenow={sidebarWidth}
            title='ドラッグで幅を変更・ダブルクリックでリセット'
            onPointerDown={startSidebarResize}
            onPointerMove={resizeSidebar}
            onPointerUp={finishSidebarResize}
            onLostPointerCapture={finishSidebarResize}
            onDoubleClick={resetSidebarWidth}
          />}

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
              onDragOver={dragImageOverCanvas}
              onDrop={(event) => void dropImageOnCanvas(event)}
              onMoveEnd={(_event, viewport) => setCanvasViewport(viewport)}
              snapToGrid={snapToGrid}
              snapGrid={[22, 22]}
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
              {showDots && <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} color='#394154' />}
              {showMinimap && <MiniMap
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
                  if (node.data.kind === 'image-describe') return '#654398'
                  if (node.data.kind === 'text-transform') return '#654398'
                  if (node.data.kind === 'batch-generate') return '#96552f'
                  return '#96552f'
                }}
                nodeStrokeColor={(node) => {
                  if (node.data.kind === 'prompt') return '#c39cff'
                  if (node.data.kind === 'image') return '#79d3ff'
                  if (node.data.kind === 'image-describe') return '#c39cff'
                  if (node.data.kind === 'text-transform') return '#c39cff'
                  if (node.data.kind === 'batch-generate') return '#ffb17d'
                  return '#ffb17d'
                }}
              />}
            </ReactFlow>
          </section>
        </div>
        <footer className='status-bar'>
          <div className='status-activity'>
            {statusNotice && <span className='status-notice'>{statusNotice.text}</span>}
            {generationActivity && (
              <span className='status-generation'>
                <span className='status-generation-label'>
                  {generationActivity.title ? `生成中: ${generationActivity.title}` : '生成待機中'}
                  {generationActivity.queuedCount > 0 ? ` (待機 ${generationActivity.queuedCount}件)` : ''}
                </span>
                {generationActivity.percent != null && (
                  <>
                    <span className='status-progress-track'><span style={{ width: `${generationActivity.percent}%` }} /></span>
                    <span className='status-progress-value'>{generationActivity.percent}%</span>
                  </>
                )}
              </span>
            )}
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
            <button type='button' onClick={() => addNodeFromContextMenu('prompt')}><span className='node-type-dot prompt' />Text</button>
            <button type='button' onClick={() => addNodeFromContextMenu('image')}><span className='node-type-dot image' />Image</button>
            <button type='button' onClick={() => addNodeFromContextMenu('image-describe')}><span className='node-type-dot image-describe' />Image Describe</button>
            <button type='button' onClick={() => addNodeFromContextMenu('text-transform')}><span className='node-type-dot text-transform' />Text Transform</button>
            <button type='button' onClick={() => addNodeFromContextMenu('generate')}><span className='node-type-dot generate' />Image Generate</button>
            <button type='button' onClick={() => addNodeFromContextMenu('batch-generate')}><span className='node-type-dot batch-generate' />Batch Image Generate</button>
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
        {llmModelPickerOpen && (
          <div className='llm-model-picker-backdrop' onPointerDown={() => setLlmModelPickerOpen(false)}>
            <section className='llm-model-picker' role='dialog' aria-modal='true' aria-labelledby='llm-model-picker-title' onPointerDown={(event) => event.stopPropagation()}>
              <header>
                <div><span>LOCAL LLM</span><h2 id='llm-model-picker-title'>モデルを選択</h2><p>選択したモデルをロードします</p></div>
                <button type='button' className='llm-dialog-close' aria-label='閉じる' onClick={() => setLlmModelPickerOpen(false)}>×</button>
              </header>
              <div className='llm-model-picker-list'>
                {llm.models.map((model) => {
                  const loaded = llmLoaded && model.path === llm.loadedModelPath
                  const selected = model.path === llm.config.selectedModelPath
                  return (
                    <button key={model.path} type='button' className={`llm-model-option ${loaded ? 'loaded' : selected ? 'selected' : ''}`} onClick={() => void selectLlmModel(model.path)}>
                      <span className='llm-model-option-indicator' />
                      <span className='llm-model-option-copy'><strong>{model.name}</strong><small title={model.path}>{model.path}</small></span>
                      <span className='llm-model-option-meta'>{model.mmprojPath && <em>Vision</em>}<b>{formatModelSize(model.sizeBytes)}</b>{loaded && <i>Loaded</i>}</span>
                    </button>
                  )
                })}
                {llm.models.length === 0 && <div className='llm-model-picker-empty'><strong>GGUFモデルがありません</strong><span>models/フォルダへモデルを追加し、設定画面から再スキャンしてください。</span></div>}
              </div>
              {llmModelPickerError && <div className='llm-settings-error'>{llmModelPickerError}</div>}
              <footer><span>{llm.message}</span><button type='button' onClick={openLlmSettings}>詳細設定</button></footer>
            </section>
          </div>
        )}
        {llmSettingsOpen && (
          <div className='llm-settings-backdrop' onPointerDown={() => setLlmSettingsOpen(false)}>
            <form className='llm-settings-dialog' onSubmit={(event) => void saveLlmSettings(event)} onPointerDown={(event) => event.stopPropagation()}>
              <header>
                <div><span>SETTINGS</span><h2>設定</h2></div>
                <button type='button' className='llm-dialog-close' aria-label='閉じる' onClick={() => setLlmSettingsOpen(false)}>×</button>
              </header>

              <div className='llm-settings-body'>
                <nav className='llm-settings-nav' aria-label='設定セクション'>
                  <button type='button' className={settingsTab === 'llm' ? 'active' : ''} onClick={() => setSettingsTab('llm')}>Local LLM</button>
                  <button type='button' className={settingsTab === 'display' ? 'active' : ''} onClick={() => setSettingsTab('display')}>表示</button>
                </nav>
                <div className='llm-settings-panel'>
                  {settingsTab === 'llm' && (<>
              <section className='llm-settings-section'>
                <div className='llm-settings-section-title'>モデル</div>
                <label className='llm-settings-field llm-settings-wide'>
                  <span>使用モデル</span>
                  <select value={llmSettingsDraft.selectedModelPath} onChange={(event) => setLlmSettingsDraft((current) => ({ ...current, selectedModelPath: event.target.value }))}>
                    {llm.models.length === 0 && <option value=''>GGUFモデルがありません</option>}
                    {llm.models.map((model) => <option key={model.path} value={model.path}>{model.name} ({formatModelSize(model.sizeBytes)})</option>)}
                  </select>
                </label>
                <div className='llm-path-summary llm-settings-wide'>
                  <span className={llm.serverPath ? 'available' : 'missing'}>{llm.serverPath ? 'llama-server 検出済み' : 'llama-server が見つかりません'}</span>
                  <span>{llm.models.find((model) => model.path === llmSettingsDraft.selectedModelPath)?.mmprojPath ? 'Vision projector 検出済み' : 'Vision projector なし'}</span>
                </div>
                <div className='llm-folder-actions llm-settings-wide'>
                  <button type='button' onClick={() => void window.imageMixer.revealLlmLocation('models')}>Modelsフォルダ</button>
                  <button type='button' onClick={() => void window.imageMixer.revealLlmLocation('server')}>Serverフォルダ</button>
                  <button type='button' onClick={() => void window.imageMixer.revealLlmLocation('logs')}>ログ</button>
                  <button type='button' onClick={() => void rescanLlm()}>再スキャン</button>
                </div>
              </section>

              <section className='llm-settings-section llm-settings-grid'>
                <div className='llm-settings-section-title llm-settings-wide'>生成設定</div>
                <label className='llm-settings-field'><span>Context length</span><input type='number' min={512} max={262144} step={512} value={llmSettingsDraft.contextLength} onChange={(event) => setLlmSettingsDraft((current) => ({ ...current, contextLength: Number(event.target.value) }))} /></label>
                <label className='llm-settings-field'><span>Max output tokens</span><input type='number' min={1} max={32768} step={1} value={llmSettingsDraft.maxTokens} onChange={(event) => setLlmSettingsDraft((current) => ({ ...current, maxTokens: Number(event.target.value) }))} /></label>
                <label className='llm-settings-field'><span>Temperature</span><input type='number' min={0} max={2} step={0.05} value={llmSettingsDraft.temperature} onChange={(event) => setLlmSettingsDraft((current) => ({ ...current, temperature: Number(event.target.value) }))} /></label>
                <label className='llm-settings-field'><span>Idle unload（分、0で無効）</span><input type='number' min={0} max={1440} step={1} value={llmSettingsDraft.idleUnloadMinutes} onChange={(event) => setLlmSettingsDraft((current) => ({ ...current, idleUnloadMinutes: Number(event.target.value) }))} /></label>
              </section>

              <section className='llm-settings-section llm-settings-grid'>
                <div className='llm-settings-section-title llm-settings-wide'>詳細設定</div>
                <label className='llm-settings-field'><span>GPU layers</span><input type='number' min={0} max={999} step={1} value={llmSettingsDraft.gpuLayers} onChange={(event) => setLlmSettingsDraft((current) => ({ ...current, gpuLayers: Number(event.target.value) }))} /></label>
                <div className='llm-setting-toggles'>
                  <label><input type='checkbox' checked={llmSettingsDraft.flashAttention} onChange={(event) => setLlmSettingsDraft((current) => ({ ...current, flashAttention: event.target.checked }))} /><span>Flash Attention</span></label>
                  <label><input type='checkbox' checked={llmSettingsDraft.mmprojOffload} onChange={(event) => setLlmSettingsDraft((current) => ({ ...current, mmprojOffload: event.target.checked }))} /><span>mmproj GPU offload</span></label>
                </div>
              </section>
                  </>)}
                  {settingsTab === 'display' && (
                    <section className='llm-settings-section'>
                      <div className='llm-settings-section-title'>表示</div>
                      <div className='llm-setting-toggles'>
                        <label><input type='checkbox' checked={showMinimap} onChange={(event) => toggleMinimap(event.target.checked)} /><span>ミニマップを表示</span></label>
                        <label><input type='checkbox' checked={showDots} onChange={(event) => toggleDots(event.target.checked)} /><span>背景のドットを表示</span></label>
                        <label><input type='checkbox' checked={snapToGrid} onChange={(event) => toggleSnapToGrid(event.target.checked)} /><span>ノードをスナップする</span></label>
                      </div>
                      <p className='llm-settings-note'>変更は即座に反映され、次回起動時も保持されます。</p>
                    </section>
                  )}
                </div>
              </div>

              {llmSettingsError && <div className='llm-settings-error'>{llmSettingsError}</div>}
              <footer>
                <span>{llm.activePort ? `127.0.0.1:${llm.activePort}` : llm.message}</span>
                <div><button type='button' onClick={() => setLlmSettingsOpen(false)}>キャンセル</button><button type='submit' className='primary'>保存</button></div>
              </footer>
            </form>
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
