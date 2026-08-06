# 実装計画

作成日時: 2026-08-05 22:27
更新日時: 2026-08-06 13:23

## 基本方針

- UI は [ysm446/lm-graph](https://github.com/ysm446/lm-graph) を参考に Electron + React + TypeScript + React Flow で構築する。
- renderer からローカルファイルや ComfyUI へ直接アクセスせず、preload の型付き IPC を介して Electron main に処理を集約する。
- Electron main が ComfyUI プロセス、HTTP API、WebSocket、画像ファイル、プロジェクト DB を管理する。
- Electronのsingle-instance lockを使い、アプリとComfyUIの管理主体が二重にならないようにする。2回目の起動要求では既存ウィンドウを前面表示する。
- Python はリポジトリ直下の `.venv/` を使用し、`runtime/ComfyUI/main.py` を同環境から起動する。MVP では独自の常駐 Python API サーバーを増やさない。
- 現在のMVPでは、選択したルートフォルダの `sessions/<session-id>/session.json` にグラフを保存し、画像本体は同セッションの `assets/` にコピーする。SQLiteへの移行は履歴・検索要件が増えた段階で再検討する。
- アプリの編集グラフを ComfyUI の内部ワークフローと1対1対応させず、生成ノードの実行時に固定テンプレートへコンパイルする。
- ComfyUI の画面保存形式と API 形式を区別し、実行には API 形式だけを使用する。

## 推奨スタック

- Desktop: Electron
- Frontend: React + TypeScript
- Graph UI: `@xyflow/react`
- Build: electron-vite
- Styling: Tailwind CSS または既存 `lm-graph` の CSS 方針
- Persistence: SQLite (`better-sqlite3`) + ローカル画像ファイル
- ComfyUI client: Electron main の `fetch` + WebSocket
- Runtime: Python 3.10.19 の `.venv` と `runtime/ComfyUI`

利用可能なPython 3.10.19から `.venv` を作成し、PyTorch 2.10.0 + CUDA 13.0を導入済みです。ComfyUI専用ポートは、既存のStability Matrix環境と競合しない `127.0.0.1:8189` とします。

## アーキテクチャ

```text
React Flow renderer
  └─ typed preload IPC
      └─ Electron main
          ├─ SQLite / data/assets
          ├─ ComfyUI process manager
          └─ ComfyUI HTTP + WebSocket client
                 └─ runtime/ComfyUI (Python .venv)
                      └─ Qwen-Rapid-AIO-NSFW-v23.safetensors
```

詳細は [エディタ仕様](../reference/editor-spec.md) と [ComfyUI 連携仕様](../reference/comfyui-integration.md) を参照します。

## 実装フェーズ

### Phase 0: 実行環境の固定

- Git 管理の初期化方針と `.gitignore` を整える。
- Node.js / npm / Python / CUDA / PyTorch の対応バージョンを決める。
- `.venv` の作成、ComfyUI requirements の導入、起動スクリプトを用意する。
- checkpoint を ComfyUI の `models/checkpoints/` から認識できるようにする。
- UI 保存形式のワークフローを ComfyUI から API 形式で export し、別ファイルとして保存する。
- 手動で API ワークフローを実行し、モデルとワークフローの互換性を確認する。

完了条件: アプリを介さず、固定画像と固定 prompt で API 実行して結果を取得できる。

### Phase 1: デスクトップ基盤

- Electron + React + TypeScript のプロジェクトを作成する。
- renderer / preload / main の責務と IPC 型を定義する。
- ComfyUI の起動、停止、health check、ログ表示を実装する。
- UI 設定とランタイムパスを保存する。
- main processでCPU・RAMとNVIDIA GPU・VRAMを定期取得し、型付きIPCで下部ステータスバーへ通知する。

完了条件: アプリから ComfyUI を起動し、接続状態を確認して安全に停止できる。2026-08-05時点で実装・単体起動確認済み。

### Phase 2: グラフ編集と保存

- 画像入力、画像生成、生成結果ノードを実装する。
- 型付きハンドル、最大入力数、自己接続・サイクル防止を実装する。
- キャンバスの右クリック位置へPrompt / Image / Generateノードを追加できるコンテキストメニューを実装する。
- ノード追加操作はキャンバスの右クリックメニューへ一本化し、上部ヘッダーには新規作成ボタンを置かない。
- 左ドラッグの部分一致範囲選択、複数ノード移動、`F` / `A`のfit viewショートカットを実装する。
- `Ctrl+C` / `Ctrl+V`で選択ノードと選択集合内のエッジを新しいIDへ複製する。別セッションへ貼り付ける場合は、参照画像と生成結果を貼り付け先セッションの`assets/`へ独立コピーしてパスを付け替える。
- 画像 import、thumbnail 作成、プロジェクト snapshot 保存を実装する。
- 未保存状態、プロジェクト切り替え確認、ノード複製・削除を実装する。
- 左サイドバーでルートフォルダとセッション一覧を管理し、セッションの作成・名前変更・複製・切り替え・削除と編集内容の自動保存を行う。
- セッション複製では`assets`を新しいUUIDフォルダへコピーし、snapshot内の画像パスを複製先へ付け替える。
- ファイル選択とドラッグ＆ドロップのどちらからでも、画像を現在のセッションへimportする。
- Imageノードを画像の縦横比に合わせて表示し、解像度表示と生成ノードへのサイズ反映操作を提供する。
- Qwen Editノードの結果領域とノード幅を、設定解像度または実際の生成結果の縦横比に合わせて表示する。
- Qwen Editノードの結果画像をクリックすると画面内へ拡大し、背景クリックまたはEscapeで閉じるプレビューを提供する。
- Qwen EditノードのSeed欄へランダム化ボタンを設け、有効範囲内の値を即時設定する。
- Qwen Editノードのinput / outputピン文言はノード内へ重ねず、対応するピンの外側へ配置する。

完了条件: 再起動後もセッションのグラフと入力画像を復元できる。2026-08-05時点でJSON snapshotとセッションassetによる永続化を実装済み。

### Phase 3: ComfyUI レンダリング

- API ワークフローテンプレートの読込とスキーマ検証を実装する。
- 画像を `/upload/image` へ送り、返された名前を `LoadImage` 入力へ反映する。
- prompt、モデル、width、height、batch size、seed、steps、CFG、sampler、scheduler、denoise をテンプレートへ反映する。
- `/prompt` でキューへ投入し、`/ws` で進捗と完了を監視する。
- `/history/{prompt_id}` と `/view` から結果を取得してローカル資産化する。
- エラー、キャンセル、ComfyUI 切断、VRAM 不足をノード状態へ反映する。
- Generate操作をアプリ内FIFOキューへ追加し、main processが常に1件ずつ順番にComfyUIへ投入する。待機中は`queued`を表示し、待機ジョブの削除と実行中ジョブのキャンセルに対応する。接続元もキューにある場合は、後続ジョブの実行直前に接続元の最新生成結果を入力へ解決する。
- 生成中はCancelボタンを表示し、投入前のHTTP処理はAbortController、投入後はComfyUIの対象job cancel APIで中断する。
- セッション読込時に保存済み`running`ノードとmain processの実行ジョブを照合し、実体がない状態は`canceled`へ自動修復して永続化する。
- 生成中は開始時刻からの経過時間をリアルタイム表示し、結果保存または失敗時に確定した生成時間を生成ノードデータへ保存する。
- 生成結果をクリップボードへコピーするIPCと、保存先ダイアログから書き出すIPCを提供する。

完了条件: 生成ノードから2枚の入力画像を合成し、結果を次段の入力として利用できる。

### Phase 4: 実用性と再現性

- キュー順変更、再実行、ランダム seed、結果バリエーションを実装する。
- 実行時に解決した seed、モデル名、テンプレート hash、全パラメータを記録する。
- 進捗、実行時間、ComfyUI ログ、失敗理由を確認できるようにする。
- project export/import と不足アセット検出を実装する。

完了条件: 保存済み実行を同じ条件で再投入でき、入力から結果まで追跡できる。

## 優先順位

1. ComfyUI API ワークフローと指定モデルの手動動作確認。
2. データを失わないプロジェクト・画像保存。
3. 1ノードの確実なレンダリングと進捗表示。
4. 複数段の画像編集と再現性。
5. UI の細かな改善と高度なキュー操作。

## 変更時の判断基準

- UI ノードは利用者の作業概念を表し、ComfyUI の実装詳細を必要以上に露出させない。
- ワークフローの node ID だけへ依存せず、起動時に `class_type` と必須 input を検証して不一致を明示する。
- 元画像と過去の生成結果は原則として上書きしない。
- renderer に任意ファイルパスや ComfyUI の生 API を公開しない。
- モデルや巨大な生成物をリポジトリへ含めない。
- `runtime/ComfyUI` 本体への変更は必要最小限にし、可能な限り外側の adapter で吸収する。

## 検証方針

- TypeScript/Electron 変更: `npm run build`。
- Python 変更: `.venv` の Python による `py_compile` と対象テスト。
- ワークフロー変更: schema 検証と固定 seed の smoke test。
- 保存処理変更: 新規保存、再読込、アセット欠損、未保存切り替えを確認する。
- ComfyUI 連携変更: 正常完了、API validation error、切断、キャンセル、VRAM 不足を確認する。
