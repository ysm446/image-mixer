# MiniMax H3 Image 連携仕様

作成日時: 2026-11-14 00:20
更新日時: 2026-11-14 00:20

Image MixerのImage Generate / Batch Image Generateノードで選択できる実行モデル「MiniMax H3 Image」(`minimax-h3`)の構成、必要ファイル、動作の仕組み、プロンプトの書き方、注意点をまとめる。

## 概要

MiniMax-H3-Imageは、MiniMaxが公開した画像生成・編集モデル(2026-11公開)。テキストからの生成と、Image 1を編集対象・残りを参照とする画像編集を1つのモデルで行う。テキストエンコーダは動画モデルMiniMax H3と共通のQwen3-VL-32B。蒸留済みで6ステップ・CFG 1で動く。

ComfyUIは**v0.45.0以降**のコアが対応している(`comfy_extras/nodes_minimax_h3.py`の`MiniMaxH3ImageConditioning`)。カスタムノードは不要。同梱ComfyUIは2026-11-14にv0.45.3へ更新した。

以前試したPrunaAIの派生モデルP-H3-Image(`PH3ImageConditioning`)とは別物で、P-H3-Imageは2026-11-13に削除済み。

## 必要ファイル

モデルは共有フォルダ(`data/app-settings.json`の`comfyModelRoot`、既定`D:\ai-models\diffusion\comfyui`)へ置く。

| 種別 | ファイル | 配置先 | サイズ |
| --- | --- | --- | --- |
| 拡散モデル | `minimax_h3_image_pruned_int8_convrot.safetensors` | `diffusion_models/` | 20.98GB |
| テキストエンコーダ | `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` | `text_encoders/` | 15.69GB |
| VAE | `minimax_h3_image_vae_fp16.safetensors` | `vae/` | 1.17GB |

- 入手元: [Comfy-Org/MiniMax-H3-Image](https://huggingface.co/Comfy-Org/MiniMax-H3-Image)。2026-11-14に3ファイルともSHA-256がHugging Faceの値と一致することを確認済み。
- テキストエンコーダは動画モデルMiniMax H3用に配置済みだったもの(2026-08-03)をそのまま使う。nvfp4はBlackwell世代向けの形式。公式テンプレートはint8版(`qwen3vl_32b_minimax_h3_int8_convrot.safetensors`、27.14GB)を指定しているが、未導入。
- 拡散モデルにはbf16版(40.23GB)とw4a8版(12.55GB)もある。
- 公式テンプレートのプロンプト拡張(`qwen3.5_9b_w4a8_gptq.safetensors`、`TextGenerateV2`ノード)は**未使用**。必要ならアプリのText Transformで代替する。
- ダウンロードは`curl -L -C - --retry`で直接取得した。

## ワークフロー構成

`src/main/index.ts`が生成ノードのModel設定(`minimax-h3`)と画像接続の有無で以下を選ぶ。公式テンプレート(`image_minimax_h3_image_t2i.json` / `image_minimax_h3_image_edit.json`、`comfyui_workflow_templates_json`パッケージ同梱)からプロンプト拡張と入力画像のリサイズ部分を除き、API形式にしたもの。

```
UNETLoader(int8_convrot) ───────────────────────────────────────────────┐
CLIPLoader(qwen3vl_32b nvfp4, type=minimax) ─┐                          │
VAELoader(vae_fp16) ─────────────────────────┼→ MiniMaxH3ImageConditioning(Input Prompt, width, height[, images.image_1〜3])
                                             │     ├─ positive ─────────────────────┬→ KSampler(6 steps, cfg 1, euler, simple)
                                             │     │                                │     ↑ negative: ConditioningZeroOut(positive)
                                             │     └─ latent ───────────────────────┘
                                             └──────────────────────────────────────────→ VAEDecode → PreviewImage
```

- テキスト生成: `workflows/MiniMax-H3-Image-Generate.json`
- 画像編集: `workflows/MiniMax-H3-Image.json`(`LoadImage` ×3 → `images.image_1`〜`images.image_3`。ノードは100枚まで受け付けるが、アプリの上限は3枚)
- `EmptyLatentImage`は無く、`MiniMaxH3ImageConditioning`がlatentを作る。`applyRequest`はこのノードを検出すると、Width × Heightを32の倍数に丸めてノードへ入れ、`KSampler`のStepsを6、CFGを1に固定する(ノードのSteps・CFG値は無視される)。Seedはそのまま`KSampler`へ入れる。
- VAEを接続すると参照画像がlatentとしても渡される(公式どおり)。外すとテキストエンコーダ経由の参照だけになり、元画像からの変化が大きくなった。

## 出力サイズの扱い

- Width × Heightを32の倍数へ丸めた値が出力サイズになる(テキスト生成・編集とも)。
- 編集時、ノードは参照画像をQwen3-VL向けに短辺1024px、VAE向けに短辺1024〜2048pxへ縦横比を保って縮小・拡大する。出力サイズとは独立しているので、構図の維持にはImage 1の縦横比へWidth × Heightを合わせるのがよい。
- 公式の説明では有効範囲は約4MP〜20MPで、16MP前後(4096 × 4096など)が最良。公式テンプレートは4MPで開く。1024 × 1024でも破綻はしなかったが、TIPSでは2048 × 2048以上を推奨している。

## プロンプトの書き方

- 参照画像は**`<Picture 1>`〜`<Picture 3>`**と呼ぶ。Image 1ピン=`<Picture 1>`が編集対象で、残りは参照。
- 残したいもの(人物、看板など)を明記すると保たれやすい。
- 文字描画が得意(「OPEN 24/7」のネオン看板や「HELLO」の手書き看板を正確に描けた)。
- seedによって結果の当たり外れがある。同じ指示でもseed 42では雪の指示が強い雨+過剰シャープな質感になり、seed 1では自然な雪景色になった。結果が不自然なときはseedを変える。

## 実行パラメータ

| 項目 | 値 | 備考 |
| --- | --- | --- |
| Steps | 6(固定) | 蒸留で6段の出力ヘッドに合わせてある。既定値は6 |
| CFG | 1(固定) | negativeは`ConditioningZeroOut`。negative promptなし |
| sampler / scheduler | euler / simple | 公式テンプレートどおり |

## 動作確認(2026-11-14)

RTX PRO 5000 Blackwell(48GB、他プロセスが約11GB使用中)、ComfyUI v0.45.3。8190番で別途起動したComfyUIへ、アプリと同じ差し替え規則でワークフローを投入した。時間は投入から取得まで(初回はモデルロード込み)。

| ケース | サイズ | seed | 時間 | 結果 |
| --- | --- | --- | --- | --- |
| テキスト生成 | 2048 × 2048 | 42 | 15.3秒(ロード込み) | 正常、ネオン看板の文字も正確 |
| テキスト生成 | 1024 × 1024 | 42 | 2.1秒 | 正常 |
| テキスト生成 | 2560 × 1440 | 7 | 5.1秒 | 正常、看板の文字も正確 |
| 編集・参照1枚(雪へ変更) | 2048 × 2048 | 42 | 17.3秒 | 雨のまま強まり、全体が過剰シャープ |
| 編集・参照1枚(同上) | 2048 × 2048 | 1 | 15.2秒 | 人物・傘・看板を保って自然な雪景色 |
| 編集・参照2枚 | 2048 × 2048 | 42 | 50.8秒 | `<Picture 2>`のロボットを`<Picture 1>`へ配置、他は維持。質感はやや過剰シャープ |

同時に、v0.45.3で既存のQwen Rapid AIO / Krea 2 Turbo / Qwen Image 2.1のテキスト生成(1024 × 1024)が正常に動くことを確認した。アプリ(Electron)からの実行は未確認。

## ライセンス

- MiniMax H3 Image License Agreement(元のMiniMax H3のライセンスとは別)。
- 年間売上が100万ドルを超える場合、または第三者向けにホスティングサービスを提供する場合は、MiniMaxの書面による許可が別途必要。
- 詳細は[Comfy-Org/MiniMax-H3-Image](https://huggingface.co/Comfy-Org/MiniMax-H3-Image)のライセンス表記を参照する。

## 関連ファイル

- ワークフロー: [workflows/MiniMax-H3-Image.json](../../workflows/MiniMax-H3-Image.json) / [workflows/MiniMax-H3-Image-Generate.json](../../workflows/MiniMax-H3-Image-Generate.json)
- モデル選択の実装: `src/main/index.ts`(`runImageGeneration` / `applyRequest`)、`src/main/types.ts`(`GenerateModel` / `GENERATE_MODEL_OPTIONS`)
- 経緯の記録: [docs/changelog.md](../changelog.md) 2026-11-14 00:20の項
