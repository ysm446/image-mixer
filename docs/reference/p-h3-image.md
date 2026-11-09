# P-H3-Image 連携仕様

作成日時: 2026-11-10 01:37
更新日時: 2026-11-10 01:37

Image MixerのImage Generate / Batch Image Generateノードで選択できる実行モデル「P-H3-Image」の構成、必要ファイル、動作の仕組み、プロンプトの書き方、注意点をまとめる。

## 概要

[P-H3-Image](https://huggingface.co/PrunaAI/P-H3-Image)は、PrunaAIが動画生成モデルMiniMax-H3から作った画像生成・編集モデル(2026-11公開)。テキストからの生成と、Image 1を編集対象・残りを参照とする画像編集を1つのモデルで行う。テキストエンコーダはQwen3-VL-4Bベース。蒸留済みで8ステップ・CFGなしで動く。

ComfyUIは**v0.44.0以降**のコアが対応している(`comfy_extras/nodes_minimax_h3.py`の`PH3ImageConditioning` / `MiniMaxH3SigmaShift`)。カスタムノードは不要。同梱ComfyUIは設定画面の「ComfyUI」タブからv0.44.2へ更新済み。

## 必要ファイル

モデルは共有フォルダ(`data/app-settings.json`の`comfyModelRoot`、既定`D:\ai-models\diffusion\comfyui`)へ置く。

| 種別 | ファイル | 配置先 | サイズ |
| --- | --- | --- | --- |
| 拡散モデル | `p-h3-image_int8_convrot.safetensors` | `diffusion_models/` | 21.2GB |
| テキストエンコーダ | `p-h3-image_text_encoder_int8_convrot.safetensors` | `text_encoders/` | 5.1GB |
| VAE | `p-h3-image_vae_int8_convrot.safetensors` | `vae/` | 3.1GB |

- 入手元: [PrunaAI/P-H3-Image-Comfy](https://huggingface.co/PrunaAI/P-H3-Image-Comfy)。2026-11-10にSHA-256がHugging Faceの値と一致することを確認済み。
- 公式のピークVRAMはint8一式で約31GB(8MP時)。bf16一式(約56GB)は48GBのGPUに収まらないため、既存モデルと同じint8 convrot版を使う。最小のw4a8版(約21GB)もある。
- 公式ワークフローにはプロンプトアップサンプラー(`p-h3-image_prompt_upsampler_*`、Qwen3.5-9Bベース、`TextGenerate`ノード)があるが、現状は**未使用**。短い指示を詳しいプロンプトへ書き換える用途で、必要ならアプリのText Transformで代替する。
- Hugging Face CLI(`.venv`の`hf download`)とPython API(Xetバックエンド)は今回の環境で失敗または停止したため、`curl -L -C -`で直接取得した。

## ワークフロー構成

`src/main/index.ts`が生成ノードのModel設定(`ph3`)と画像接続の有無で以下を選ぶ。公式ワークフロー(`workflows/p-h3-image_text_to_image.json` / `p-h3-image_edit.json`)からアップサンプラー部分を除き、API形式にしたもの。

```
UNETLoader(int8_convrot) → MiniMaxH3SigmaShift(shift_video 1.0 / shift_audio 1.0) ─┐
CLIPLoader(text_encoder_int8_convrot, type=minimax) ─┐                                  │
VAELoader(vae_int8_convrot) ────────────────────────┼→ PH3ImageConditioning(Input Prompt, width, height[, images.image_1〜3])
                                                     │     ├─ positive → BasicGuider(model, conditioning) ─┐
                                                     │     └─ latent ──────────────────────────────────────┼→ SamplerCustomAdvanced
RandomNoise(seed) / KSamplerSelect(euler) / ManualSigmas(8ステップ固定) ───────────────────────────────────┘        ↓
                                                                                               VAEDecode → PreviewImage
```

- テキスト生成: `workflows/P-H3-Image-Generate.json`
- 画像編集: `workflows/P-H3-Image.json`(`LoadImage` ×3 → `images.image_1`〜`images.image_3`。モデルは最大9枚まで受け付けるが、アプリの上限は3枚)
- `KSampler`を使わないため、`applyRequest`は`PH3ImageConditioning`を検出すると、Seedを`RandomNoise.noise_seed`へ、Width × Heightを32の倍数に丸めて`PH3ImageConditioning`へ入れる。Steps・CFGは反映しない(sigmaは公式の8ステップ固定グリッド`1.0, 0.984753, 0.967905, 0.951688, 0.925372, 0.881923, 0.810083, 0.528718, 0.0`)。

## 出力サイズの扱い

- Width × Heightを32の倍数へ丸めた値が出力サイズになる(テキスト生成・編集とも)。
- 編集時、`PH3ImageConditioning`は各参照画像を縦横比を保ってWidth × Heightの画素数以内へ縮小してからVAEでエンコードする。Image 1と縦横比がずれた出力サイズでも動作するが、構図の維持にはImage 1の比率へ合わせるのがよい。
- 公式推奨はテキスト生成8MP(1:1で2912 × 2912)、編集4MP。ただし768 × 768や1024 × 1024でも破綻なく生成できることを確認した。

## プロンプトの書き方

- 参照画像は**`<Picture 1>`〜`<Picture 3>`**と呼ぶ。Image 1ピン=`<Picture 1>`が編集対象で、残りは参照。
- 画像を接続すると、ノードがプロンプトの先頭へ自動で`Edit <Picture 1>. `を付ける(`Edit <Picture`で始まる指示はそのまま使う)。
- 編集では**残したいものを明記する**。「Change the background to a snowy mountain landscape.」だけでは人物まで消えて雪山だけの画像になったが、「…Keep the police officer and the monster exactly as they are, same pose, same position and same art style.」を足すと人物・怪物・画風を保ったまま背景だけが変わった(同じseed)。
- 文字描画が得意(「OPEN 24/7」のネオン看板を正確に描けた)。

## 実行パラメータ

| 項目 | 値 | 備考 |
| --- | --- | --- |
| Steps | 8(固定) | ノードのSteps値は無視される。既定値は8 |
| CFG | なし | `BasicGuider`。negative promptなし |
| sampler | euler | `KSamplerSelect` |
| ModelSamplingMiniMaxH3 | 1.0 / 1.0 | ノード説明で指定されている値 |

## 動作確認(2026-11-10)

RTX PRO 5000 Blackwell(48GB)、ComfyUI v0.44.2、seed 42。時間はモデルロード後(初回のt2i 1024はロード込み)。

| ケース | サイズ | 時間 | 結果 |
| --- | --- | --- | --- |
| テキスト生成 | 768 × 768 | 2.0秒 | 正常 |
| テキスト生成 | 1024 × 1024 | 13.4秒(ロード込み) | 正常、看板文字も正確 |
| テキスト生成 | 2048 × 2048 | 7.1秒 | 正常 |
| 編集・参照1枚 | 2048 × 1536 | 10.3秒 | 指示が短いと被写体ごと描き直される(上記) |
| 編集・参照1枚(保持指示つき) | 2048 × 1536 | 10.1秒 | 被写体と画風を保って背景のみ変更 |
| 編集・参照2枚 | 2048 × 1536 | 14.2秒 | `<Picture 2>`の看板を`<Picture 1>`の看板と差し替え、他は維持 |

アプリ(Electron)からの実行は未確認。検証は8190番で別途起動したComfyUIへ、アプリと同じ差し替え規則でワークフローを投入して行った。

## ライセンス

- P-H3-Imageの重みは**MiniMax H3 Community License**。EU・英国・韓国・米国は、MiniMaxから別途ライセンスを得ない限り対象外。これを使った製品には「Powered by MiniMax H3」の表示が必要。
- テキストエンコーダのQwen3-VL-4B部分とプロンプトアップサンプラー(Qwen3.5-9B)はApache License 2.0。
- 詳細はリポジトリの`LICENSE` / `NOTICE`を参照する。

## 関連ファイル

- ワークフロー: [workflows/P-H3-Image.json](../../workflows/P-H3-Image.json) / [workflows/P-H3-Image-Generate.json](../../workflows/P-H3-Image-Generate.json)
- モデル選択の実装: `src/main/index.ts`(`runImageGeneration` / `applyRequest`)、`src/main/types.ts`(`GenerateModel` / `GENERATE_MODEL_OPTIONS`)
- 経緯の記録: [docs/changelog.md](../changelog.md) 2026-11-10 01:37の項
