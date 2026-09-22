# Qwen Image 2.1 連携仕様

作成日時: 2026-09-23 02:29
更新日時: 2026-09-23 02:29

Image MixerのImage Generate / Batch Image Generateノードで選択できる実行モデル「Qwen Image 2.1」の構成、必要ファイル、動作の仕組み、プロンプトの書き方、注意点をまとめる。

## 概要

[Qwen-Image-2.1](https://huggingface.co/Qwen/Qwen-Image-2.1)は、テキストからの画像生成と画像編集を1つのチェックポイントで行う統合モデル(画像生成部7B、Single-Stream DiT 32層)。テキストエンコーダはQwen3-VL-8B、VAEは4チャンネル(RGBA)対応の専用VAEを使う。ネイティブ2K出力、文字描画、透過画像生成に対応する。

ComfyUIは**0.37.0以降**のコアが対応している(`comfy_extras/nodes_qwen.py`の`TextEncodeQwenImage21` / `QwenImage21Cache`)。2026-09-23に同梱ComfyUIを0.30.0からv0.37.0へ更新した。

## 必要ファイル

モデルは共有フォルダ(`data/app-settings.json`の`comfyModelRoot`、既定`D:\ai-models\diffusion\comfyui`)へ置く。

| 種別 | ファイル | 配置先 | サイズ |
| --- | --- | --- | --- |
| 拡散モデル | `qwen_image_2.1_int8_convrot.safetensors` | `diffusion_models/` | 7.3GB |
| テキストエンコーダ | `qwen3vl_8b_int8_convrot.safetensors` | `text_encoders/` | 9.4GB |
| VAE | `qwen_image_2.1_vae_bf16.safetensors` | `vae/` | 0.7GB |

- 入手元: [Comfy-Org/Qwen-Image-2.1](https://huggingface.co/Comfy-Org/Qwen-Image-2.1)
- bf16版(拡散モデル14.2GB、エンコーダ17.5GB)もあるが、公式推奨かつKrea 2と同じ方式のint8 convrot版を使う。
- `qwen3.5_9b_qwen_image_2.1_pe_*`はプロンプト拡張(Prompt Enhancer)用で、現状は未使用。

## ワークフロー構成

`src/main/index.ts`が生成ノードのModel設定(`qwen21`)と画像接続の有無で以下を選ぶ。公式テンプレート(`comfyui_workflow_templates`の`image_qwen_image_2_1_t2i` / `image_qwen_image_2_1_image_edit`)のサブグラフをAPI形式へ展開したもの。

### テキスト生成: `workflows/Qwen-Image-2.1-Generate.json`

```
UNETLoader(int8_convrot)
CLIPLoader(qwen3vl_8b_int8_convrot, type=qwen_image) ─ TextEncodeQwenImage21(Input Prompt) ─┬─ positive (出力0)
                                                                                           └─ negative (出力1)
EmptyLatentImage(Width × Height) → KSampler(euler / simple / 25 steps / CFG 1) → VAEDecode → PreviewImage
```

### 画像編集: `workflows/Qwen-Image-2.1.json`

```
UNETLoader(int8_convrot) → QwenImage21Cache(device auto / dtype default)
LoadImage ×3 → TextEncodeQwenImage21(Input Prompt, clip + vae + images.image_1〜3, resolution)
  ├─ positive / negative
  └─ latent (出力2: Image 1を縮小したサイズの空latent) → KSampler(euler / simple / 25 steps / CFG 1) → VAEDecode → PreviewImage
```

- 参照画像はAPI上`images.image_1`〜`images.image_3`という入力名で渡す(Autogrow入力。モデル自体は最大16枚まで対応するが、アプリの上限は3枚)。
- `QwenImage21Cache`はテキストと参照画像のプレフィックスをKVキャッシュし、ステップごとの再計算を省く。`device=off`にすると約2倍遅くなる(実測 10秒→21秒)。

## 出力サイズの扱い

- **テキスト生成**: Width × Heightがそのまま出力サイズになる。ただしlatentが1/16のため、16の倍数に切り下げられる(例: 1000 × 1000 → 992 × 992)。公式は32の倍数を推奨。
- **画像編集**: 出力は**Image 1の縦横比**になり、Width × Heightは画素数の目安としてだけ使う。アプリは`resolution = √(Width × Height)`(32の倍数、256〜2048)を`TextEncodeQwenImage21`へ渡し、全参照画像をその画素数へ縮小する。サンプリングにはエンコーダが返すImage 1サイズのlatentを使う(例: 設定1024 × 1024、Image 1が縦長 → 出力832 × 1248)。

### EmptyLatentImageを編集で使わない理由

編集時に`EmptyLatentImage`(Width × Height)をサンプリングに使うと、Image 1の縮小サイズとlatentサイズがずれる(例: 832 × 1216に対しImage 1は832 × 1184)。ノード定義にも「他のサイズでは編集がずれる」と記載されている。2026-09-23の実測では、この構成で特定のseed(12345)がプロンプトを無視して元画像を過剰シャープ化しただけの出力になり、エンコーダのlatentへ切り替えると同じseedで正常化した。キャッシュ設定(auto / off / なし)は無関係だった。

## プロンプトの書き方

- 参照画像は**`<image1>`〜`<image3>`**と呼ぶ。接続順はImage 1ピン=`<image1>`。例: 「Put the plaid flannel shirt from `<image2>` on the woman in `<image1>`, keep her face, hair, pose and the background unchanged.」
- Krea 2の`Picture N`表記とは異なる。
- 日本語の指示でも動作する。例: 「`<image1>`の背景を夜の東京の街並みに変えてください。人物はそのまま。」
- 残したい要素(顔、髪型、ポーズ、背景)を明示すると同一性が保たれやすい。
- 透過画像は「This is an RGBA format image with transparency. [内容]. The image has an alpha channel and a transparent background.」の形で指示する(公式テンプレートの説明より)。アプリの結果保存は現在PreviewImage経由のため、アルファ保持は未確認。

## 実行パラメータ

| 項目 | 値 | 備考 |
| --- | --- | --- |
| Steps | 25 | 公式テンプレートの既定値。Model切替時、Stepsが切替前モデルの既定値のままなら25へ変わる |
| CFG | 1 | 公式既定。negative promptは空 |
| sampler / scheduler | euler / simple | テンプレートに固定 |
| 解像度 | 1024 × 1024基準、最大2048 × 2048 | 2Kネイティブ対応 |

RTX PRO 5000 Blackwell(48GB)での実測: テキスト生成 1024 × 1024 で約7秒、参照2枚の編集で約9〜13秒(モデルロード済み時)。

## ライセンス

- Qwen-Image-2.1は**Qwen Research License Agreement**で配布される。研究用途を前提としたライセンスのため、商用利用や第三者への配布を行う場合は条文を確認する。

## 関連ファイル

- ワークフロー: [workflows/Qwen-Image-2.1.json](../../workflows/Qwen-Image-2.1.json) / [workflows/Qwen-Image-2.1-Generate.json](../../workflows/Qwen-Image-2.1-Generate.json)
- モデル選択の実装: `src/main/index.ts`(`runImageGeneration` / `applyRequest`)、`src/main/types.ts`(`GenerateModel` / `GENERATE_MODEL_OPTIONS`)
- 経緯の記録: [docs/changelog.md](../changelog.md) 2026-09-23の項
