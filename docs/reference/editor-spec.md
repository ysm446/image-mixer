# ノード画像エディタ仕様

作成日時: 2026-08-05 22:27
更新日時: 2026-08-07 14:59

## 目的

この文書は、Image Mixer のアプリ側グラフと基本 UI を定義します。ComfyUI の内部ノード構造は [ComfyUI 連携仕様](comfyui-integration.md) で扱います。

## 設計原則

アプリのグラフは「ユーザーの編集手順」を表し、ComfyUI のグラフは「1回の推論処理」を表します。この2つを分離します。

- アプリ側: 複数段の編集、素材、結果、履歴を永続化する。
- ComfyUI 側: 選択した1つの生成ノードを実行する一時的な prompt graph。
- 生成時: 対象ノードの直接入力と設定を API ワークフローテンプレートへ反映する。

## MVP のノード種別

各ノードのタイトルは通常時に表示専用とし、タイトル横の編集アイコンを押すと入力欄へ切り替える。Enterまたはフォーカス移動で確定し、Escapeで変更を取り消す。

### Prompt

生成・編集指示を入力するノードです。本文入力欄は固定幅で折り返し、内容の高さに合わせてノードごと自動拡張する。入力欄内部にはスクロールバーを表示しない。

### Image Input

ローカルから読み込んだ元画像です。

- fields: title、asset ID、元ファイル名、width、height、mime type。
- output: `IMAGE`。
- 画像は project data へコピーし、外部の元ファイルが移動しても利用できるようにする。
- thumbnail は表示用に別生成し、原寸画像をキャンバス描画へ直接使わない。
- ImageノードとImage Generateノードは共通の360 × 360px基準で画像領域を計算し、同じ解像度・縦横比なら同じ表示サイズにする。ノードの画像領域は元画像の縦横比を保って変形し、ファイル名と元画像のwidth × heightを表示する。極端な縦横比でもキャンバス操作を妨げない範囲へ表示サイズを制限する。
- ノードの画像領域へPNG / JPEG / WEBP / BMPをドロップして読み込める。読込済みの場合は新しい画像へ差し替える。
- 未読込時は画像領域のクリックでファイルを選択する。読込後は画像クリックで画面内へ拡大表示し、右上の画像変更アイコンから別ファイルへ差し替える。拡大表示は生成結果と共通化し、背景クリックまたはEscapeで閉じる。
- 画像の検証、解像度取得、表示用PNGサムネイル生成には`sharp`を使用し、Electronの`nativeImage`が直接デコードできないWebP / BMPも扱う。
- 読み込んだ画像は現在のセッションの `assets/` へUUID名でコピーし、元ファイルの移動や削除の影響を受けないようにする。

### Image Generate

画像編集を実行する中心ノードです。

- inputs: `IMAGE` を0～3本。画像入力が0本なら画像生成、1～3本なら画像編集として実行する。
- output: `IMAGE`。
- basic fields: prompt、width、height、seed、生成枚数。
- advanced fields: steps、CFG、sampler、scheduler、denoise、negative prompt。
- workflow ID と workflow version を保持する。
- 実行前に入力数、画像存在、サイズ、ComfyUI 接続、モデル、workflow schema を検証する。
- 「Generate時にImage 1のサイズへ合わせる」チェックボックスを有効にすると、Generate操作のたびに`image1`へ接続したImageノードまたはImage Generateノードの出力解像度をwidth / heightへ反映する。生成待ちのImage Generateノードでは設定中の出力サイズを使用する。4096px以内へ縮小し、各辺を8の倍数へ丸める。
- Image Generateノードの結果領域とノード幅は、未生成時にはwidth / height、生成後には実際の結果画像の解像度から縦横比を求めて変形する。極端な比率では設定欄を操作できる最小幅・高さを維持する。

入力画像の順番は意味を持ちます。接続順ではなく、`image1`、`image2`、`image3` の番号付き handle へ明示的に接続し、ComfyUI の同名 input へ対応させます。

画像ピンが1本も接続されていない場合は画像生成モードとして`IMAGE GENERATE`を表示する。画像ピンが接続されている場合は画像編集モードとして`IMAGE EDIT`を表示し、接続元に実画像または生成結果がなければ実行前エラーとする。

### Batch Image Generate

- 選択フォルダ直下の`.png`、`.jpg`、`.jpeg`、`.webp`、`.bmp`を対象とし、サブフォルダは走査しない。
- Start Batch時点で対象ファイル一覧と設定を固定し、各ファイルをImage 1として既存のアプリ内FIFOキューへ1件ずつ投入する。Image 2・Image 3とPromptは通常ノードから接続できる。
- 「各入力画像のサイズに合わせる」が有効な場合は、ファイルごとに4096px以内かつ8の倍数へ正規化した解像度を使用する。
- 入力フォルダ直下へ`image-mixer-output-<日時>`を作成し、連番付き画像と`batch-result.json`を保存する。マニフェストには入力、出力、seed、設定、個別エラーを記録する。
- 個別ファイルの失敗は記録して次へ進み、Cancelでは現在の生成を停止して処理済み結果とマニフェストを残す。
- バッチ結果はフォルダ単位で管理するためIMAGE出力を持たない。ノードには進捗、成功・失敗件数、現在の経過時間、最新結果、出力フォルダを開く操作を表示する。完了・失敗・キャンセル後は確定した処理時間を保持する。

### Image Generate の生成結果

MVPではImage Generateノード内に最新の生成結果を表示し、同ノードの `IMAGE` outputから次段へ接続します。これにより、生成結果をそのまま次のImage Generateの `image1`～`image3` へ入力できます。

- fields: result asset、prompt ID、使用 seed、status、error、生成経過時間。
- 生成経過時間はComfyUI呼び出し開始からリアルタイム更新し、結果の取得・セッションasset保存完了後も確定値を保持する。失敗時はエラー確定までを記録し、1秒未満はms、1分未満は秒、それ以上は分・秒で表示する。
- output: `IMAGE`。成功済みの最新結果がある場合だけ下流生成に利用できる。
- 再生成すると表示上の最新結果を更新する。
- 過去結果を履歴として保持する永続化は次のフェーズで実装する。
- 結果画像の右上にコピーと保存アイコンを表示する。コピーは画像データとしてOSクリップボードへ書き込み、保存は保存先ダイアログで選択した場所へ元ファイルを複製する。
- 結果画像をクリックすると画面内へアスペクト比を保って拡大表示する。最大768 × 768pxとし、ウインドウが小さい場合は上下左右32pxの余白内へ縮小する。背景クリックまたはEscapeで閉じ、拡大中は画像の解像度を表示する。
- main processはコピー・保存対象が現在のセッションライブラリ配下にあることを検証する。

将来は結果を独立したGenerated Imageノードへ展開し、複数revisionをグラフ上へ固定できるようにします。

## 接続規則

- `IMAGE` output から Image Generateの`image1`～`image3`、またはBatch Image Generateの`image2`～`image3` inputだけへ接続できる。
- 1つの入力 handle に接続できる edge は1本。
- 同じ画像を複数 handle へ接続する操作は許可するが、警告を表示してもよい。
- 自己接続と有向サイクルは禁止する。
- Image Generate の出力は、成功した execution が1つもなければ downstream 実行に使用できない。
- 複数結果がある場合、どの result revision を downstream へ渡すかを明示する。

## 生成パラメータ

| 項目 | MVP の扱い |
|---|---|
| prompt | 必須。空文字は実行不可 |
| negative prompt | 任意。既定は空文字 |
| width / height | 64～4096。手入力の確定時と生成直前に最寄りの8の倍数へ自動補正する。Image 1から反映する場合も4096px以内・8の倍数へ補正する |
| seed | 0～2147483647の固定値。入力欄右側のサイコロボタンで有効範囲内のランダム値へ変更し、実値をノードへ記録する |
| batch size | 既定1。VRAM 使用量への警告を付ける |
| steps | workflow 既定4 |
| CFG | workflow 既定1 |
| sampler | workflow 既定 `sa_solver` |
| scheduler | workflow 既定 `beta` |
| denoise | workflow 既定1 |

最小値、最大値、step は ComfyUI の `/object_info` またはアプリ側 workflow schema から検証し、UI と API で同じ規則を使います。

## 実行状態

```text
idle → validating → uploading → queued → running → downloading → succeeded
                  ↘ failed       ↘ canceled          ↗
```

- `idle`: 未実行または設定変更後。
- `validating`: 入力と workflow を検証中。
- `uploading`: 入力画像を ComfyUI へ転送中。
- `queued`: Generate操作をアプリ内FIFOキューへ追加済みで、先行ジョブの完了待ち。
- `running`: ComfyUI が対象 prompt を実行中。
- `downloading`: history から結果を取得中。
- `succeeded`: 結果を project asset として保存済み。
- `failed`: validation、HTTP、実行、保存のいずれかで失敗。
- `canceled`: 待機または実行をユーザーが中止。

Generate操作はセッションにかかわらずアプリ内FIFOキューへ追加し、main processが同時に1件だけ実行する。Batch Image Generateも各ファイルを同じキューへ順次追加する。待機中は「キュー待機中」と「キューから削除」を表示し、実行開始後はCancelボタンへ切り替える。待機ジョブの削除、実行ジョブの成功・失敗・キャンセルのいずれでも次のジョブを自動開始する。接続元の生成ノードも先にキューへ入っている場合、後続ジョブはクリック時の古い結果を固定せず、実行直前に接続元の最新成功結果を入力として解決する。キャンセル後は`canceled`状態と実行開始後の経過時間をノードへ保存し、同じノードから再生成できる。

セッション読込時は、保存された`queued`または`running`ノードに対応するmain processの実行ジョブが存在するか照合する。実行ジョブが存在しない場合は、アプリ終了・更新・renderer再読込による中断とみなし、`canceled`へ変更して開始時刻と古いエラーを消去し、修復後のsnapshotを保存する。

エラーには利用者向け要約と、debug 用の ComfyUI node ID、node type、server message を分けて保存します。

## 画面構成

- top bar: ComfyUI起動状態とLoad／Unloadトグル。アプリ管理プロセスだけを停止対象とし、外部ComfyUIへ接続中はUnloadを無効にする。

- 初期ウィンドウサイズは、タイトルバーと外枠を除いたコンテンツ領域で1920 × 1080とする。
- 上部バーは右端にComfyUI状態だけを表示し、アプリ名や説明文は表示しない。

- 左 sidebar: ルートフォルダ選択、セッション一覧、新規作成、切り替え。各セッションの三点メニューから名前変更、複製、削除を行う。 三点メニューは一覧のレイアウトを押し下げず、スクロール領域に切られない画面基準の位置へ重ねて表示する。画面下端の空きが足りない場合はボタンの上側へ開く。セッション一覧のスクロールバーは細く簡素な外観にする。左sidebarの境界はマウスドラッグで220〜520pxの範囲をリサイズでき、選択幅を端末内に保存する。境界のダブルクリックでは標準幅270pxへ戻す。
- 新規セッションにはPrompt・Image・Image Generateノードを配置し、PromptをImage GenerateのPrompt入力へ、ImageをImage 1入力へ接続した状態を初期グラフとする。
- セッション複製は`<元の名前> Copy`を基本名とし、重複時は末尾へ2以降の番号を付ける。グラフと`assets`を新しいUUIDフォルダへコピーし、Image / Generated Imageの絶対パスを複製先へ更新してから新セッションへ切り替える。
- 中央: React Flow canvas、MiniMap、zoom、fit view。
- MiniMapはPrompt・Image・Image Generate・Batch Image Generateを種類別の塗りと明るい輪郭で表示し、現在の表示範囲を青い枠で示す。パネルには暗いグラデーション、角丸、影、ホバー強調を適用する。
- canvasの空白部分を右クリックするとノード追加メニューを表示し、選択したPrompt / Image / Image Generate / Batch Image Generateノードをクリック位置へ配置する。ノード追加はこのメニューへ一本化し、上部バーにはComfyUI状態以外を表示しない。
- canvasの空白部分へ対応画像をドロップすると、その位置へImageノードを作成して現在のセッションへimportした画像を割り当てる。既存Imageノードの画像領域へドロップした場合は新規作成せず、そのノードの画像を差し替える。
- Image Generateノードのinputピン文言は左側、outputピン文言は右側のノード外へ配置し、設定欄や生成結果へ重ねない。
- Prompt・Image・Image Generateノードの種類別アクセントカラーは、四辺が均一な太さの外周枠線へ適用し、選択時は同色のグローを追加する。
- キャンバスの空白部分へマウスを重ねたときは通常の矢印カーソル、ノード本体では人差し指の手形カーソルを表示する。ボタン、入力欄、画像選択、拡大表示などの操作要素は用途別カーソルを維持する。
- canvasの左ドラッグは部分一致の矩形範囲選択とし、複数選択後にいずれかの選択ノードをドラッグするとまとめて移動する。キャンバス移動はホイールボタンのドラッグを使う。
- エッジはクリックすると強調選択し、DeleteまたはBackspaceで削除する。ダブルクリックでも対象エッジを直接削除できる。
- 範囲選択中の矩形は表示するが、選択確定後に複数ノード全体を囲む矩形は表示しない。選択状態は各ノード自身の枠で示す。
- 入力欄以外で`F`を押すと選択ノード全体へ、`A`を押すと全ノードへ300msでfit viewする。
- `F12`を押すと入力フォーカスに関係なくアプリのコンテンツ領域をPNG撮影し、選択中Root Folder直下の`screenshot/`へ日時付きファイル名で保存する。
- スクリーンショット保存後は画面右下へファイル名付き通知を表示する。通知の本文をクリックするとエクスプローラーで保存フォルダを開いて撮影したPNGを選択し、通知は6秒経過または閉じるボタンで消す。
- 入力欄以外で`Ctrl+C`を押すと選択ノードと選択ノード同士を結ぶエッジをアプリ内クリップボードへ保存し、`Ctrl+V`で新しいIDへ複製する。source / target handle、edge style、node dataは維持し、ノード群の中心を現在表示しているキャンバスの中央付近へ配置する。
- 貼り付けたノード群だけを選択し、連続貼り付けでは24pxずつ右下へずらす。同一セッション内では、コピー対象外の既存ノードへつながる境界エッジも元の接続先へつなぎ直す。ただし接続先の同一入力ピンが既存エッジで使用中の場合は、2本目の境界エッジを作成しない。別セッションまたは削除済みの相手への境界エッジも作成しない。別セッションへ貼り付ける場合は、選択ノードが保持する入力画像と生成結果を貼り付け先の`assets/`へUUID名で独立コピーし、ノード内のパスを付け替えてセッション間参照を防ぐ。
- 右 inspector: 選択ノードの prompt、生成設定、画像情報。
- 下部ステータスバー: ComfyUI状態、現在のセッション、CPU・RAM・GPU・VRAMの使用量。CPU・RAMはNode.jsのOS API、NVIDIA GPU・VRAMは`nvidia-smi`から取得し、GPU情報を取得できない環境ではCPU・RAMだけを表示する。
- result viewer: 原寸確認、before/after、保存先を開く、次の編集へ接続。

基本設定には prompt、サイズ、seed、生成枚数だけを表示し、sampler 関連は詳細設定へまとめます。

## 永続化

### 現在のMVP保存形式

```text
<選択したルート>/
  sessions/
    <session-id>/
      session.json
      assets/
        <asset-id>.<ext>
        generated-<asset-id>.<ext>
```

`session.json` にはセッション情報、nodes、edges、キャンバスのviewport（x、y、zoom）を保存します。画像の `dataUrl` は保存せず、読み込み時にassetからthumbnailを再生成します。編集後500msで自動保存し、セッション・ルート切り替え前にも明示保存します。保存時とライブラリ読込時には、ImageノードまたはImage Generateの生成結果から参照されていない画像ファイルを各セッションの`assets/`から削除します。取り込み中または生成結果保存中の画像はsnapshotへ反映されるまで削除対象から一時的に除外します。Batch Image Generateの結果とマニフェストはユーザーが選んだ入力フォルダ直下の専用出力フォルダへ保存し、セッションassetのクリーンアップ対象外とします。

### 将来のSQLite構成

- projects
- nodes
- edges
- executions
- execution_inputs
- execution_outputs
- assets
- workflow_templates

各 execution には少なくとも次を保存します。

- project ID / source node ID / execution ID / ComfyUI prompt ID。
- status と各段階の時刻。
- 解決済みの全生成パラメータ。
- checkpoint の相対名と可能なら file hash。
- workflow ID、version、template hash。
- 入力 asset ID と入力順。
- output asset ID。
- エラー要約と debug detail。

### 従来の設計案

```text
data/
  app.db
  preferences.json
  assets/
    images/<asset-id>/original.<ext>
    images/<asset-id>/thumbnail.webp
  logs/
```

workflow、モデル、ComfyUI input/output は project asset の正本にしません。生成後に結果を `data/assets` へコピーし、ComfyUI 側の履歴削除から保護します。

## 保存と未保存状態

- ノード編集は renderer の working state へ即時反映する。
- 明示保存または安全な autosave で project snapshot を確定する。
- プロジェクト切り替え、window close、import 上書き時は未保存確認を行う。
- 生成開始前に対象ノードの現在値を execution snapshot として固定し、実行中の UI 編集で内容を変えない。

## MVP 後の候補

- mask / inpaint ノード。
- prompt template、style preset、parameter preset。
- compare / contact sheet ノード。
- upscale、crop、resize など非生成画像処理ノード。
- 複数 workflow template とモデル切り替え。
- branch 一括実行、依存順の自動実行、低解像度 preview。
