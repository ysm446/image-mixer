# 進捗

作成日時: 2026-08-05 22:27
更新日時: 2026-08-06 02:01

## 現在の状態

Electron + React Flowの動作版を実装済みです。Prompt、Image、Qwen Editノードに加え、左サイドバーからルートフォルダと複数セッションを管理できます。各セッションのグラフ、入力画像、生成結果は個別のフォルダへ保存されます。

## 確認済みの資産

- [ysm446/lm-graph](https://github.com/ysm446/lm-graph)
  - Electron + React + TypeScript + `@xyflow/react` のデスクトップ構成。
  - renderer / preload / main の分離、SQLite snapshot、型付きノード・エッジを参考にできる。
- `runtime/ComfyUI`
  - ComfyUI 0.30.0 のソースが配置済み。
  - `pyproject.toml` 上の Python 要件は 3.10 以上。
  - `TextEncodeQwenImageEditPlus` は ComfyUI 標準側の `comfy_extras/nodes_qwen.py` に存在し、最大3枚の画像入力を持つ。
- `workflows/Qwen-Rapid-AIO.json`
  - ComfyUI API保存形式で、3つの `LoadImage` を含む10ノード構成。
  - `TextEncodeQwenImageEditPlus` の `image1`～`image3` は接続済み。

## 判明している差分・注意点

- checkpoint `Qwen-Rapid-AIO-NSFW-v23.safetensors` は `runtime/ComfyUI/models/checkpoints` に配置済みで、APIから認識確認済み。
- ワークフローはAPI形式へ置き換え済みで、3つ目の `LoadImage` と `image3` 接続を追加済み。
- 出力は `PreviewImage` だけである。履歴から取得可能かを smoke test し、安定したファイル管理が必要なら API 版では `SaveImage` を採用する。
- `package.json`、`.venv`、`.gitignore`、Electronアプリケーションコードを作成済み。
- ルートプロジェクトをGitリポジトリとして初期化済み。`runtime/ComfyUI`は独立したGitリポジトリとしてルート側の追跡対象から除外する。

## 完了済み

- アプリ名を`Image Mixer`へ変更し、表示名、パッケージ名、preload API、起動メッセージ、README・仕様書を統一した。
- エッジのクリック選択を強調表示し、Delete・Backspaceおよびダブルクリックで削除できるようにした。
- Promptだけを接続したQwenノードを画像生成モード、画像ピンを接続したノードを画像編集モードとして、専用workflowと表示を自動切替するようにした。
- Qwen Editノード上部の余白を縮め、Image 1の解像度反映操作をアイコン化してWidth・Height入力欄の右横へ配置した。
- 新規セッションのデフォルトPrompt・Image・Qwen Editノードを、対応するPrompt入力とImage 1入力へ接続済みの状態にした。
- 左サイドバー内の主要テキストのフォントサイズを一段階大きくし、視認性を改善した。
- プロジェクト目標と MVP の定義。
- 参照プロジェクト `lm-graph` の技術構成と保存モデルの確認。
- ComfyUI ワークフローのノード、接続、可変パラメータの確認。
- ComfyUI の HTTP / WebSocket 実行フローの確認。
- エディタのノード種別、接続制約、生成状態、保存対象の初期仕様。
- Python `.venv` と ComfyUI プロセスの推奨構成。
- 段階的な実装計画と完了条件の定義。
- Prompt / Image / Qwen Editノードと型付き接続。
- width、height、seed、steps、CFGのworkflow上書き。
- ComfyUIへの画像upload、prompt投入、history監視、結果download。
- Qwen Editの生成結果を次段の画像入力として利用する処理。
- アプリ専用8189番でのComfyUI自動起動・自動停止。
- Python 3.10.19 `.venv`、PyTorch 2.10.0 + CUDA 13.0の構築。
- RTX PRO 5000 Blackwell、指定checkpoint、Qwen 3画像inputの起動確認。
- `npm run build` 成功。
- Node.js、npm、`node_modules`、`.venv` を確認してアプリを起動する `start.bat` を追加。
- 左サイドバーへルートフォルダ選択とセッション一覧を追加。
- セッションの新規作成、切り替え、確認付き削除を追加。
- nodes / edgesの自動保存と再読込、画像thumbnailの再構築を追加。
- 入力画像と生成結果をセッションごとの `assets/` へ保存するよう変更。
- Imageノードへの画像ドラッグ＆ドロップを追加。
- Electronのsingle-instance lockを追加し、二重起動時は新しいプロセスを終了して既存ウィンドウを前面表示するようにした。
- Promptノードの日本語IME変換中はlocal draftだけを更新し、composition確定時にグラフへ反映するよう修正。
- Prompt入力中のkeyboard eventをReact Flowへ伝播させないようにした。
- Imageノードを画像の縦横比に合わせて変形し、元画像の解像度を表示するようにした。
- Qwen Editノードに、Image 1の解像度をwidth / heightへ反映するボタンを追加した。
- 旧セッションの画像と生成結果にも、読み込み時に画像ファイルから解像度を補完するようにした。
- 画像デコードをElectronの`nativeImage`から`sharp`へ変更し、WebP / BMPのimport、解像度取得、サムネイル生成に対応した。
- READMEへ概要、必要環境、セットアップ、起動、基本操作、保存形式、トラブルシューティング、現在の制限を整理した。
- Gitリポジトリを`main`ブランチで初期化し、ComfyUI本体とTypeScript build infoを追跡対象から除外した。
- Qwen Editノードの幅と結果表示領域を、未生成時は設定解像度、生成後は実画像の縦横比に合わせて変形するようにした。
- Electronで非対応の`window.prompt()`により新規セッションボタンが停止する問題を修正し、空いている`Session N`名で即時作成するようにした。
- React Flowキャンバスからズーム、縮小、fit view、ロックのControlsとattribution表示を非表示にした。
- セッション行へ三点メニューを追加し、アプリ内モーダルからの名前変更と確認付き削除を提供した。
- セッション名の変更をモーダルから一覧内のインライン編集へ変更し、Enter・フォーカス移動での確定とEscapeでの取消に対応した。
- セッション名の変更を`session.json`へ保存し、一覧とアクティブセッションへ即時反映するIPCを追加した。
- キャンバスの右クリックメニューからPrompt / Image / Generateを選び、クリック位置へノードを追加できるようにした。
- `lm-graph`と同様に左ドラッグを部分一致の範囲選択へ割り当て、選択ノードの一括移動に対応した。
- `F`で選択ノード、`A`で全ノードへfit viewするキーボードショートカットを追加した。
- 範囲選択の確定後に複数ノードを囲む矩形を非表示にし、各ノードの選択表示だけを残した。
- 生成開始から結果保存または失敗までの経過時間を計測し、Qwen Editノードへの表示とセッション保存に対応した。
- 生成中の経過時間をリアルタイム更新し、完了または失敗後は確定した生成時間を表示したまま保持するようにした。
- Electron標準のFile / Edit / Viewなどのアプリケーションメニューを削除し、Altキーによる再表示も無効化した。
- Qwen Editノードの生成結果へコピー・保存アイコンを追加し、画像クリップボードと保存先ダイアログに対応した。
- コピー・保存対象をセッションライブラリ配下の画像へ制限した。
- `Ctrl+C` / `Ctrl+V`による選択ノードのコピー＆ペーストと、選択ノード同士を結ぶエッジの複製に対応した。
- 貼り付けるノード群の中心を現在のキャンバス表示領域の中央へ合わせ、連続貼り付け時だけ位置をずらすようにした。
- 貼り付け時にノード・エッジIDを再発行し、連続貼り付け位置のオフセットと同一セッション制約を追加した。
- セッションの三点メニューへ複製を追加し、グラフ、入力画像、生成結果を新しいセッションへ独立コピーするようにした。
- 複製先の画像パス再割り当て、自動採番、不完全フォルダの失敗時クリーンアップに対応した。
- Qwen Editノードの生成画像をクリックして拡大表示し、背景クリックまたはEscapeで閉じられるようにした。
- 下部ステータスバーを追加し、ComfyUI状態、現在のセッション、CPU・RAM・GPU・VRAM使用量をリソースバーで表示するようにした。
- CPU・RAMを1秒ごと、NVIDIA GPU・VRAMを`nvidia-smi`から2秒ごとに取得するmain process監視とIPC通知を追加した。
- Qwen EditノードのSeed欄へサイコロアイコンのランダム化ボタンを追加し、0～2147483647のseedを設定できるようにした。
- 生成中のQwen EditノードへCancelボタンを追加し、画像upload・history待機・結果downloadの中断とComfyUIの対象prompt停止に対応した。
- キャンセル状態とキャンセルまでの経過時間をノードへ保持し、キャンセル途中に保存された不完全な生成assetを削除するようにした。
- 上部ヘッダーのPrompt・Image・Generate新規作成ボタンを削除し、ノード追加をキャンバスの右クリックメニューへ一本化した。
- Qwen EditノードのPrompt・Image 1～3・IMAGEピン文言を、ハンドルに対応するノード外側へ移動した。
- セッション読込時に実行ジョブのない`running`生成ノードを`canceled`へ自動復旧し、古いエラーと開始時刻を除去して保存するようにした。
- 実行中セッションの複製では、複製先に実体のない生成状態を引き継がないようにした。

## 次に行うこと

1. 実画像3枚を使ったend-to-end生成をUIから手動確認する。
2. 実行progress、履歴表示を追加する。
3. セッションのexport/importを追加する。
4. ローカルLLMによるPromptノード執筆支援を設計・実装する。

## 未確定事項

- 画像入力は最大3枚、自動起動・自動停止、可変値はwidth / height / seed / steps / CFGとして確定。
- 生成ノードに高度な sampler 設定を常時表示するか、基本設定と詳細設定へ分けるか。基本/詳細の分離を推奨する。
- NSFW モデルを使用するため、配布を予定する場合の年齢確認、利用規約、モデルライセンス表示をどこまで実装するか。
