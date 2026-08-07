# Image Mixer

ローカルのComfyUIを利用し、複数の画像とプロンプトをノードグラフ上で組み合わせて画像を生成・再編集するWindows向けデスクトップアプリです。

ComfyUIの内部ワークフローを直接編集するのではなく、素材画像、編集指示、生成結果の関係をシンプルなノードとして管理します。生成結果は次の生成ノードへ接続できるため、作業の流れを残したまま段階的に編集できます。

> 現在は開発中のMVPです。ローカル環境での単一ユーザー利用を想定しています。

## 主な機能

- React Flowベースのノードエディタ
- キャンバスの右クリックメニューから、クリック位置へノードを追加
- 左ドラッグによる範囲選択と選択ノードの一括移動
- 選択ノードと選択範囲内のエッジをまとめてコピー＆ペースト
- `F`で選択ノードへフォーカス、`A`で全ノードを表示
- Prompt、Image、Image Generate、Batch Image Generateノード
- 長文に合わせて高さが自動で広がるPromptノード
- 編集アイコンから変更できるノードタイトル
- Promptだけを接続した画像生成と、生成ノード1つにつき最大3枚の参照画像を使う画像編集
- PNG / JPEG / WebP / BMPの選択・ドラッグ＆ドロップ読み込み
- キャンバスの空白部分への画像ドロップによるImageノードの自動作成
- ImageノードとImage Generateノードで共通の360 × 360px基準を使う画像表示と解像度表示
- Imageノードの画像クリックによる拡大表示と、変更アイコン・ドラッグ＆ドロップによる差し替え
- 設定解像度または生成結果の縦横比に合わせたImage Generateノード表示
- Generate時にImage 1の解像度を生成サイズへ自動反映するチェックボックス
- width、height、seed、steps、CFGのワークフロー上書きとseedランダム化ボタン
- Image Generateの生成結果を次の生成ノードへ接続
- 生成開始から結果保存または失敗までの経過時間をImage Generateノードへ表示・保存
- 複数の生成要求を1件ずつ順番に処理するFIFOキューと、待機中の削除・実行中のキャンセル
- 生成中のCancelボタンによるComfyUI promptの中断
- 生成結果を画像としてクリップボードへコピー、または保存先を選んで書き出し
- 生成結果をクリックして画面内へ拡大表示
- ルートフォルダと複数セッションの作成・名前変更・複製・削除（見切れない三点メニューとシンプルなスクロールバー）
- グラフ、入力画像、生成結果のセッション別自動保存
- ComfyUIの自動起動・自動停止
- 下部ステータスバーでComfyUI状態、現在のセッション、CPU・RAM・GPU・VRAM使用量を表示
- Electronアプリの二重起動防止

## 使用するモデルとワークフロー

- Checkpoint: `Qwen-Rapid-AIO-NSFW-v23.safetensors`
- Workflow: `workflows/Qwen-Rapid-AIO.json`
- ComfyUI node: `TextEncodeQwenImageEditPlus`
- ComfyUI address: `127.0.0.1:8189`

ワークフローはComfyUIのAPI形式です。画面保存形式のJSONはそのまま実行できません。ComfyUIで編集した場合は、`Export (API)`で保存した内容に置き換えてください。

## 必要環境

- Windows 10またはWindows 11
- Node.jsとnpm
- Python 3.10以上
- NVIDIA GPU、対応ドライバー、使用環境に合ったCUDA版PyTorch
- `runtime/ComfyUI`へ配置したComfyUI
- `.venv`のPython仮想環境
- 指定checkpoint

動作確認済みのローカル環境はPython 3.10.19、PyTorch 2.10.0 + CUDA 13.0、ComfyUI 0.30.0です。GPUやドライバーによって適切なPyTorch構成は異なります。

## ディレクトリ構成

起動前に、少なくとも次の構成を用意します。

```text
image-mixer/
├─ .venv/
├─ runtime/
│  └─ ComfyUI/
│     ├─ main.py
│     └─ models/
│        └─ checkpoints/
│           └─ Qwen-Rapid-AIO-NSFW-v23.safetensors
├─ workflows/
│  └─ Qwen-Rapid-AIO.json
├─ src/
├─ package.json
└─ start.bat
```

ComfyUI本体は独立したGitリポジトリとして扱い、ルート側のGit管理から除外します。モデルファイル、仮想環境、生成画像もGit管理の対象外です。

## セットアップ

既にこのリポジトリのローカル環境が構築済みなら、この節を飛ばして`start.bat`を実行できます。

### 1. Node.js依存関係

```powershell
npm install
```

### 2. Python仮想環境

```powershell
$venvPath = '.venv'
py -3.10 -m venv $venvPath
$pythonPath = Join-Path $venvPath 'Scripts\python.exe'
& $pythonPath -m pip install --upgrade pip
& $pythonPath -m pip install -r 'runtime\ComfyUI\requirements.txt'
```

使用するGPUとドライバーに対応したCUDA版PyTorchを`.venv`へ導入してください。

### 3. モデル

次の場所へcheckpointを配置します。

```text
runtime/ComfyUI/models/checkpoints/Qwen-Rapid-AIO-NSFW-v23.safetensors
```

ファイル名はワークフローの`CheckpointLoaderSimple.inputs.ckpt_name`と一致させる必要があります。

## 起動

エクスプローラーから`start.bat`を実行するか、PowerShellで次を実行します。

```powershell
.\start.bat
```

起動時にNode.js、npm、`node_modules`、`.venv`を確認します。アプリがComfyUIを`127.0.0.1:8189`で自動起動し、アプリ終了時には自身が起動したComfyUIプロセスを停止します。

アプリをもう一度起動した場合、新しいプロセスは終了し、既存ウィンドウが前面に表示されます。

## 基本操作

1. 左サイドバーで保存先のルートフォルダを選択します。
2. `+`からセッションを作成します。
3. キャンバスを右クリックしてImageノードを追加し、画像領域のクリックまたはドラッグ＆ドロップで画像を読み込みます。読込後は画像クリックで拡大し、右上の変更アイコンから差し替えられます。
4. Promptノードを追加し、編集内容を入力します。
5. Image Generateノードを追加します。
6. Promptノードを`Prompt`へ、Imageノードを`Image 1`～`Image 3`へ接続します。
7. 必要に応じて生成パラメータを設定します。
8. `Generate`を押して生成します。
9. 生成結果の出力ピンを別のImage Generateノードへ接続すると、続けて再編集できます。

複数のノードで`Generate`を押すとクリック順にキューへ入り、1件ずつ生成します。接続した生成ノードを続けて実行した場合、後続ノードは実行直前に先行ノードの最新結果を受け取ります。待機中はキューから削除でき、実行中は`Generate`ボタンが`Cancel`へ切り替わります。キャンセルするとComfyUIの対象promptを停止し、次の生成へ進みます。

生成結果をクリックすると画面内へ拡大表示します。画面外の背景をクリックするか`Esc`を押すと元の表示へ戻ります。右上にあるコピーアイコンで画像をクリップボードへコピーし、保存アイコンで任意の場所へ書き出せます。

Image 1と同じ出力サイズにする場合は、`Generate時にImage 1のサイズへ合わせる`をチェックします。チェック中はGenerateを押すたびに最新サイズを反映し、4096px以内を維持して各辺を8の倍数へ補正します。

### キャンバス操作

| 操作 | 内容 |
|---|---|
| 左ドラッグ | 矩形範囲に触れたノードを複数選択 |
| 選択ノードをドラッグ | 選択中のノードをまとめて移動 |
| ホイールボタンのドラッグ | キャンバスを移動 |
| `F` | 選択中のノードが収まるようにフォーカス |
| `A` | すべてのノードが収まるように表示 |
| `Ctrl+C` | 選択ノードと、選択ノード同士を結ぶエッジをコピー |
| `Ctrl+V` | コピーしたノードとエッジを同じセッションまたは別セッションへ貼り付け |
| `F12` | アプリ画面をPNG保存し、右下の通知をクリックすると保存フォルダを開く |

文字入力欄へフォーカスしている間は、キャンバス用のキーボードショートカットは動作しません。

ノードのコピー内容はアプリ内に保持されます。別セッションへ貼り付ける場合、画像ノードや生成結果の画像アセットは貼り付け先セッションへ独立コピーされます。

## ノード

| ノード | 役割 | 入出力 |
|---|---|---|
| Prompt | ComfyUIへ送る編集指示を入力 | Prompt出力 |
| Image | ローカル画像をセッションへ読み込む | IMAGE出力 |
| Image Generate | 最大3枚の画像とPromptから画像を生成 | Prompt入力、IMAGE入力×3、IMAGE出力 |
| Batch Image Generate | 選択フォルダ直下の画像をImage 1として1枚ずつ生成 | Prompt入力、IMAGE入力×2 |

Image Generateノードでは次の値を指定できます。

| 項目 | 内容 |
|---|---|
| Width / Height | 出力解像度。64～4096、step 8 |
| Seed | 生成seed。右側のサイコロボタンでランダム値へ変更 |
| Steps | サンプリングstep数 |
| CFG | guidance scale |

## セッションの保存

選択したルートフォルダの下へ、セッションごとのJSONと画像を保存します。

```text
<ルートフォルダ>/
└─ sessions/
   └─ <session-id>/
      ├─ session.json
      └─ assets/
         ├─ <input-asset>.<ext>
         └─ generated-<asset-id>.<ext>
```

グラフは編集後に自動保存されます。読み込んだ画像は`assets`へコピーされるため、元ファイルを移動してもセッション内の画像は維持されます。セッション削除では、対応するセッションフォルダと画像も削除されます。

## 開発用コマンド

```powershell
npm run dev       # 開発モードで起動
npm run typecheck # TypeScript型チェック
npm run build     # 型チェックと本番ビルド
npm run preview   # ビルド済みアプリのプレビュー
```

## トラブルシューティング

### ComfyUIが起動しない

- `.venv\Scripts\python.exe`が存在するか確認します。
- `runtime\ComfyUI\main.py`が存在するか確認します。
- `8189`番ポートを別のプロセスが使用していないか確認します。
- `data\logs\comfyui.log`を確認します。

### Checkpointが見つからない

- モデルの配置場所とファイル名を確認します。
- `workflows/Qwen-Rapid-AIO.json`内の`ckpt_name`と一致しているか確認します。

### 画像を読み込めない

- 対応形式はPNG / JPEG / WebP / BMPです。
- OneDriveなどのオンライン専用ファイルは、ローカルへダウンロードしてから使用します。
- コードや依存関係を更新した後は、アプリを完全終了して再起動します。
- 再起動時やセッション読込時に、対応する実行処理がないまま保存された`running`ノードは自動的にキャンセル状態へ復旧します。

## 現在の制限

- ローカルLLMによるプロンプト作成支援は未実装です。
- 詳細な生成キュー、進捗表示、過去結果の履歴UIは今後追加予定です。
- 現在は固定のQwen workflowと単一のローカルComfyUIを使用します。
- セッションのexport/importは未実装です。

## ドキュメント

- [プロジェクト目標](docs/plan/goals.md)
- [実装計画](docs/plan/plan.md)
- [進捗](docs/plan/progress.md)
- [エディタ仕様](docs/reference/editor-spec.md)
- [ComfyUI連携仕様](docs/reference/comfyui-integration.md)
- [変更履歴](docs/changelog.md)

## ライセンスと利用上の注意

アプリの`package.json`上のライセンスはMITです。ComfyUI、checkpoint、派生元モデルにはそれぞれ別のライセンスと利用条件があります。

指定checkpointは成人向けコンテンツを生成できる派生モデルです。第三者への配布や公開利用を行う場合は、モデルライセンス、年齢制限、地域の法令、サービスの利用規約を必ず確認してください。
