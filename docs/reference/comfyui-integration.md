# ComfyUI 連携仕様

作成日時: 2026-08-05 22:27
更新日時: 2026-08-06 01:45

## 対象

- ComfyUI: `runtime/ComfyUI`、調査時点 0.30.0。
- workflow UI 保存版: `workflows/Qwen-Rapid-AIO.json`。
- 画像生成用workflow: `workflows/Qwen-Rapid-AIO-Generate.json`。
- checkpoint: `Qwen-Rapid-AIO-NSFW-v23.safetensors`。
- conditioning node: `TextEncodeQwenImageEditPlus`。
- 接続先既定値: `127.0.0.1:8189`。8188番の既存Stability Matrix環境とは分離する。

## ワークフローファイルの扱い

`workflows/Qwen-Rapid-AIO.json` は、node IDをkeyにし、各要素が `class_type` と `inputs` を持つAPI形式へ置き換え済みです。このファイルをアプリが直接読み込み、実行ごとにcloneして値を上書きします。

ComfyUI画面で編集するUI保存版も保管する場合は、実行版と混同しない別名にします。

```text
workflows/
  Qwen-Rapid-AIO.json           # 1～3画像を使う画像編集用API形式
  Qwen-Rapid-AIO-Generate.json  # 画像入力のない画像生成用API形式
  Qwen-Rapid-AIO.ui.json        # 任意。ComfyUI画面編集用
```

UI版から更新するときはComfyUIの `Export (API)` を使います。UI版から独自変換する処理は実装しません。

## 現在の UI ワークフロー

| node ID | class | 役割 | アプリから変更する値 |
|---:|---|---|---|
| 1 | `CheckpointLoaderSimple` | model / CLIP / VAE 読込 | checkpoint 名 |
| 2 | `KSampler` | sampling | seed、steps、CFG、sampler、scheduler、denoise |
| 3 | `TextEncodeQwenImageEditPlus` | positive prompt と参照画像 | prompt、image1～image3。3入力対応済み |
| 4 | `TextEncodeQwenImageEditPlus` | negative conditioning | negative prompt |
| 5 | `VAEDecode` | latent から画像へ変換 | 変更なし |
| 6 | `PreviewImage` | 結果出力 | 変更なし。API smoke test 後に `SaveImage` も検討 |
| 7 | `LoadImage` | 参照画像1 | upload 後の ComfyUI filename |
| 8 | `LoadImage` | 参照画像2 | upload 後の ComfyUI filename |
| 9 | `EmptyLatentImage` | 出力サイズ | width、height、batch size |
| 10 | `LoadImage` | 参照画像3 | upload 後の ComfyUI filename |

node 3の `image1`～`image3` はnode 7、8、10へ接続済みです。未接続ピンに対応する `LoadImage` は、実行時cloneから除去してComfyUIへ送信します。

画像ピンが1本も接続されていない場合は`Qwen-Rapid-AIO-Generate.json`を選択する。このworkflowは画像編集用を基に`LoadImage`と`image1`～`image3`参照を除いた構成とし、Prompt、EmptyLatentImage、KSamplerから画像を生成する。

## checkpoint

現在の workflow 値は次の通りです。

```text
Qwen\Qwen-Rapid-AIO-v1.safetensors
```

指定モデルへ変更し、ComfyUI が返す checkpoint の相対名と完全一致させます。想定例は次の通りです。

```text
runtime/ComfyUI/models/checkpoints/Qwen/Qwen-Rapid-AIO-NSFW-v23.safetensors
API input: Qwen\Qwen-Rapid-AIO-NSFW-v23.safetensors
```

別の共通 model directory を使う場合は `extra_model_paths.yaml` で明示します。ファイル名を決め打ちするだけでなく、起動後の `/object_info/CheckpointLoaderSimple` から候補に存在することを確認します。

モデルの配布条件、派生元ライセンス、商用利用条件、成人向け生成に関する運用要件は、アプリを第三者へ配布する前に別途確認します。

## API 実行フロー

1. `GET /system_stats` などで ComfyUI の応答を確認する。
2. API workflow template を読み込み、必須 node と input schema を検証する。
3. 画像編集モードではproject assetの入力画像を `POST /upload/image` へmultipart uploadする。画像生成モードではuploadを行わない。
4. 画像編集モードでは返却されたfilename / subfolder / typeを`LoadImage.inputs.image`へ設定する。
5. アプリ値を workflow clone へ設定する。
6. `client_id` と `prompt_id` を用意し、`POST /prompt` へ投入する。
7. `WS /ws?clientId=<client_id>` から対象 prompt の進捗、実行 node、error、完了を受信する。
8. `GET /history/{prompt_id}` で output metadata を取得する。
9. 各 output を `GET /view?filename=...&subfolder=...&type=...` から取得する。
10. project asset へ atomic に保存し、execution を `succeeded` にする。

HTTP response と WebSocket event は `prompt_id` で対応付け、別ジョブの event を混同しないようにします。

## API workflow の差し替え規約

API export 後は実際の input 名を基準に、次を変更します。

```text
CheckpointLoaderSimple.inputs.ckpt_name
KSampler.inputs.seed
KSampler.inputs.steps
KSampler.inputs.cfg
KSampler.inputs.sampler_name
KSampler.inputs.scheduler
KSampler.inputs.denoise
TextEncodeQwenImageEditPlus.inputs.prompt
TextEncodeQwenImageEditPlus.inputs.image1 / image2 / image3
LoadImage.inputs.image
EmptyLatentImage.inputs.width
EmptyLatentImage.inputs.height
EmptyLatentImage.inputs.batch_size
```

アプリコード内の散在した node ID 参照を避けるため、workflow ごとの manifest を用意します。

```yaml
id: qwen-rapid-aio
version: 1
apiWorkflow: Qwen-Rapid-AIO.api.json
bindings:
  checkpoint: { node: 1, input: ckpt_name }
  sampler: { node: 2 }
  positive: { node: 3, input: prompt }
  negative: { node: 4, input: prompt }
  size: { node: 9 }
  output: { node: 6 }
```

これは設計例です。API export 後の node ID と input 名を検証して確定します。

## seed と再現性

- UI の Random は API へ特別値として渡さず、キュー投入直前に有効範囲内の整数へ解決する。
- 解決済み seed を execution snapshot と result metadata に保存する。
- 再実行には保存済み seed を既定で使い、「新しい seed」は別操作にする。
- 同じ seed でも ComfyUI、PyTorch、CUDA、model、workflow が変われば同一画像を保証できないため、それらの version/hash も記録する。

## Python 仮想環境

推奨構成:

```text
image-mixer/
  .venv/
  runtime/ComfyUI/
  models/
  workflows/
```

PowerShell での想定手順:

```powershell
$venvPath = '.venv'
py -3.11 -m venv $venvPath
$pythonPath = Join-Path $venvPath 'Scripts\python.exe'
& $pythonPath -m pip install --upgrade pip
& $pythonPath -m pip install -r 'runtime\ComfyUI\requirements.txt'
```

起動例:

```powershell
$pythonPath = '.venv\Scripts\python.exe'
$comfyPath = 'runtime\ComfyUI\main.py'
& $pythonPath $comfyPath --listen 127.0.0.1 --port 8189
```

実際の PyTorch install は GPU、CUDA、driver に依存するため、汎用 requirements の前後どちらで導入するかを smoke test してセットアップスクリプトへ固定します。`.venv/` はバージョン管理対象外です。

## ComfyUI プロセス管理

- localhost のみで listen し、MVP では LAN へ公開しない。
- 起動前に port 使用状況を確認する。
- すでに互換 ComfyUI が応答している場合は、接続利用かアプリ管理プロセスの起動かを区別する。
- stdout / stderr を `data/logs` へ保存し、UI には直近行だけを表示する。
- window close 時は、アプリが起動した process だけを graceful shutdown する。
- renderer へ process handle や任意 command 実行機能を公開しない。

## キャンセル

- prompt投入前のupload・history待機・結果downloadは`AbortController`で中断する。
- prompt投入後は`POST /api/jobs/{prompt_id}/cancel`を使い、pending jobの削除またはrunning jobのtargeted interruptをComfyUI側で判定する。
- 対象job cancel APIを利用できないComfyUIでは、`POST /queue`の`delete`とprompt ID付き`POST /interrupt`へフォールバックする。
- rendererは対象jobへのキャンセル要求が受理された時点で`canceled`とし、main process側の生成Promiseも中断する。
- 結果保存中にキャンセルされた場合は、不完全なセッションassetを削除する。

## エラー処理

- workflow validation error: node ID、class type、input 名、ComfyUI message を表示。
- checkpoint missing: 期待する相対名と認識済み候補を表示。
- input upload error: 対象 asset と HTTP status を表示し、prompt は投入しない。
- server disconnect: 自動再接続し、history から prompt の状態を復元する。
- execution error / OOM: ComfyUI error event と log excerpt を保存し、入力・設定を保持したまま再実行可能にする。
- output download/save error: ComfyUI history を保持したまま download retry を可能にする。

## 最初の smoke test

1. `.venv` から ComfyUI を起動する。
2. 指定 checkpoint が一覧に出ることを確認する。
3. UI workflow を開き、不足 node がないことを確認する。
4. 2枚の固定画像、768 x 768、seed `65454653`、steps 4、CFG 1 で UI 実行する。
5. API 形式へ export し、同じ入力で `/prompt` 実行する。
6. WebSocket 完了、history、view から結果を取得する。
7. 3枚目の入力を追加した版でも実行し、VRAM 使用量と結果を確認する。

この smoke test が成功するまで、アプリ UI の本実装よりワークフロー互換性の解消を優先します。
