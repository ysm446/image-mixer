import { spawn } from 'node:child_process'
import type { ComfyVersionInfo } from './types'

// runtime/ComfyUI は upstream (Comfy-Org/ComfyUI) の Git clone をタグで detached checkout して使う。
// 更新は「タグを取得 → 選択タグへ checkout → .venv で requirements を入れ直す」で行う。
const STABLE_TAG = /^v\d+\.\d+\.\d+$/
const MAX_LISTED_TAGS = 20

export type CommandLogger = (line: string) => void

type CommandResult = { code: number; stdout: string; stderr: string }

function runCommand(command: string, args: string[], cwd: string, log?: CommandLogger): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const forward = (chunk: Buffer, sink: 'stdout' | 'stderr'): void => {
      const text = chunk.toString('utf8')
      if (sink === 'stdout') stdout += text
      else stderr += text
      if (!log) return
      for (const line of text.split(/\r?\n|\r/)) {
        if (line.trim()) log(line)
      }
    }
    child.stdout.on('data', (chunk: Buffer) => forward(chunk, 'stdout'))
    child.stderr.on('data', (chunk: Buffer) => forward(chunk, 'stderr'))
    child.once('error', (error) => reject(new Error(`${command} を実行できません: ${error.message}`)))
    child.once('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
  })
}

async function git(comfyDir: string, args: string[], log?: CommandLogger): Promise<string> {
  const result = await runCommand('git', args, comfyDir, log)
  if (result.code !== 0) throw new Error(`git ${args[0]} に失敗しました (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`)
  return result.stdout.trim()
}

async function gitOptional(comfyDir: string, args: string[]): Promise<string | null> {
  try {
    return await git(comfyDir, args)
  } catch {
    return null
  }
}

function compareVersionTags(a: string, b: string): number {
  const pa = a.slice(1).split('.').map(Number)
  const pb = b.slice(1).split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    if (pa[index] !== pb[index]) return pb[index] - pa[index]
  }
  return 0
}

async function listStableTags(comfyDir: string): Promise<string[]> {
  const tagList = (await gitOptional(comfyDir, ['tag', '--list', 'v*'])) ?? ''
  return tagList.split(/\r?\n/).map((tag) => tag.trim()).filter((tag) => STABLE_TAG.test(tag)).sort(compareVersionTags)
}

export async function readComfyVersionInfo(comfyDir: string, checkedAt: number | null = null): Promise<ComfyVersionInfo> {
  const commit = await gitOptional(comfyDir, ['rev-parse', '--short', 'HEAD'])
  if (!commit) throw new Error('runtime/ComfyUI が Git リポジトリではないため、バージョンを確認できません')
  const exactTag = await gitOptional(comfyDir, ['describe', '--tags', '--exact-match', 'HEAD'])
  const describe = exactTag ?? await gitOptional(comfyDir, ['describe', '--tags', 'HEAD'])
  const dirty = Boolean(await gitOptional(comfyDir, ['status', '--porcelain', '--untracked-files=no']))
  const tags = (await listStableTags(comfyDir)).slice(0, MAX_LISTED_TAGS)
  // 古いタグへ戻せるよう、現在のタグは一覧の範囲外でも残す。
  if (exactTag && STABLE_TAG.test(exactTag) && !tags.includes(exactTag)) tags.push(exactTag)
  return {
    current: describe,
    currentIsTag: Boolean(exactTag),
    commit,
    latest: tags[0] ?? null,
    tags,
    dirty,
    checkedAt
  }
}

export async function fetchComfyTags(comfyDir: string, log?: CommandLogger): Promise<ComfyVersionInfo> {
  // ブランチは取らず、タグだけを取得する。
  await git(comfyDir, ['fetch', '--force', '--no-tags', 'origin', '+refs/tags/*:refs/tags/*'], log)
  return readComfyVersionInfo(comfyDir, Date.now())
}

export function isValidComfyTag(tag: string): boolean {
  return STABLE_TAG.test(tag)
}

// 呼び出し側で ComfyUI プロセスを止めてから呼ぶ。pip が失敗した場合は元のコミットへ戻す。
export async function checkoutComfyTag(comfyDir: string, pythonPath: string, tag: string, log: CommandLogger): Promise<void> {
  if (!isValidComfyTag(tag)) throw new Error(`不正なバージョン指定です: ${tag}`)
  const info = await readComfyVersionInfo(comfyDir)
  if (info.dirty) throw new Error('runtime/ComfyUI に未コミットの変更があるため更新できません')
  if (!(await listStableTags(comfyDir)).includes(tag)) throw new Error(`${tag} が見つかりません。先に「更新を確認」を実行してください`)

  const previous = await git(comfyDir, ['rev-parse', 'HEAD'])
  log(`> git checkout ${tag}`)
  await git(comfyDir, ['-c', 'advice.detachedHead=false', 'checkout', '--quiet', tag], log)

  log('> python -m pip install -r requirements.txt')
  const pip = await runCommand(pythonPath, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', 'requirements.txt'], comfyDir, log)
  if (pip.code !== 0) {
    log(`pip が失敗したため ${info.current ?? previous.slice(0, 7)} へ戻します`)
    await git(comfyDir, ['-c', 'advice.detachedHead=false', 'checkout', '--quiet', previous], log)
    throw new Error(`requirements のインストールに失敗しました (${pip.code})。ComfyUI は ${info.current ?? previous.slice(0, 7)} に戻しました。ログを確認してください`)
  }
}
