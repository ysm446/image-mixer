# Krea 2 Turbo 連携仕様

作成日時: 2026-08-17 15:38
更新日時: 2026-08-17 15:38

Image MixerのImage Generate / Batch Image Generateノードで選択できる実行モデル「Krea 2 Turbo」の構成、必要ファイル、動作の仕組み、プロンプトの書き方、トラブルシューティングをまとめる。

## 概要

Krea 2は12.9BのSingle-Stream DiTモデルで、テキストエンコーダにQwen3-VL-4B(12層タップ)、VAEにQwen Image VAEを使う。ComfyUI 0.30.0以降のコアが対応している(`comfy/ldm/krea2`、CLIPLoaderの`krea2`タイプ)。

Qwen Image Edit系と同じ`TextEncodeQwenImageEditPlus`ノードで最大3枚の参照画像を受け取れるため、アプリの「生成ノードへ画像を最大3枚接続する」UIモデルをそのまま使える。

## 必要ファイル

| 種別 | ファイル | 配置先 | サイズ |
| --- | --- | --- | --- |
| 拡散モデル | `krea2_turbo_int8_convrot.safetensors` | `runtime/ComfyUI/models/diffusion_models/` | 12.6GB |
| テキストエンコーダ | `qwen3vl_4b_fp8_scaled.safetensors` | `runtime/ComfyUI/models/text_encoders/` | 4.9GB |
| VAE | `qwen_image_vae.safetensors` | `runtime/ComfyUI/models/vae/` | 0.24GB |
| 編集用LoRA | `krea2_identity_edit_v1_2.safetensors` | `runtime/ComfyUI/models/loras/` | 1.8GB |
| 画風参照用LoRA(未使用・任意) | `krea2_style_reference.safetensors` | `runtime/ComfyUI/models/loras/` | 0.46GB |

- 拡散モデル・エンコーダ・VAE・style referenceの入手元: [Comfy-Org/Krea-2](https://huggingface.co/Comfy-Org/Krea-2)
- identity edit LoRAの入手元: [conradlocke/krea2-identity-edit](https://huggingface.co/conradlocke/krea2-identity-edit)
- `krea2_turbo_fp8_scaled.safetensors`(12.2GB)も配置済みだが現在は未使用。LoRA併用なら正常動作することを確認済みで、削除しても問題ない。

### int8_convrot版を使う理由

INT8 ConvRotは重み行列に回転(Hadamard)を掛けてから8bit整数量子化する方式で、fp8_scaledより量子化誤差が小さく、INT8テンソルコアで高速に動く。編集・テキスト生成の両ワークフローをint8へ統一しているため、同じノードで編集⇔生成を切り替えてもモデルの再ロード(12GB)が発生しない。

## ワークフロー構成

`src/main/index.ts`が生成ノードのModel設定と画像接続の有無で以下を選ぶ。

### テキスト生成: `workflows/Krea2-Turbo-Generate.json`

```
UNETLoader(int8_convrot)
CLIPLoader(qwen3vl_4b_fp8_scaled, type=krea2) ─ CLIPTextEncode(Input Prompt) ─┬─ positive
                                                └ ConditioningZeroOut ────────┴─ negative
EmptyLatentImage → KSampler(euler / simple / 8 steps / CFG 1) → VAEDecode → PreviewImage
```

### 画像編集: `workflows/Krea2-Turbo.json`

```
UNETLoader(int8_convrot)
  → LoraLoaderModelOnly(krea2_identity_edit_v1_2, 強度1.0)
  → ModelSamplingFlux(max_shift 1.15 / base_shift 0.5, width/heightは実行時に反映)
LoadImage ×3 → TextEncodeQwenImageEditPlus(Input Prompt, clip + vae + image1〜3)
  → FluxKontextMultiReferenceLatentMethod(index_timestep_zero) ─┬─ positive
     └ ConditioningZeroOut ────────────────────────────────────┴─ negative
EmptyLatentImage → KSampler(euler / simple / 8 steps / CFG 1) → VAEDecode → PreviewImage
```

参照画像は2経路でモデルへ入る。

1. **Qwen3-VL視覚トークン**: `TextEncodeQwenImageEditPlus`が各画像を384×384相当へ縮小してVLエンコーダに渡し、`Picture N:`ラベル付きでプロンプトと融合する。キャラクターや構図の「意味」を運ぶ。
2. **参照ラテント**: 同ノードがVAEで1024×1024相当のラテントへエンコードし、`index_timestep_zero`方式でDiTのトークン列に連結する(参照トークンはt=0の変調を受ける)。ディテールの忠実度を上げる。

## 重要な制約: LoRAなしで参照ラテントを使わない

**参照ラテント注入は素のTurboモデルでは機能しない。** 対応LoRAを挟まずに実行すると次のようになる(fp8・int8とも同じ。2026-08-17に全方式を実測)。

| 構成 | 結果 |
| --- | --- |
| LoRAなし + `index_timestep_zero` | 出力全体に約16px(1トークン)格子のブロックノイズ |
| LoRAなし + `offset` / `index` / `uxo` | 参照画像がそのまま画面に重なり、プロンプトの構図を無視 |
| LoRAなし + 参照ラテントなし(VLのみ) | 正常だがディテール忠実度が低め |
| **identity edit LoRA + `index_timestep_zero`** | **正常。同一性・構図とも良好(現在の構成)** |

この参照方式はComfyUI本体に[PR #14843](https://github.com/Comfy-Org/ComfyUI/pull/14843)で「編集用LoRA向け」として実装されたもので、LoRAが参照トークンの解釈を担う。

### LoRAの選択

- `krea2_identity_edit_v1_2`(採用): 被写体の同一性を保持したまま指示部分だけを編集する。キャラクター合成に適する。
- `krea2_style_reference`(不採用): 参照画像から**画風だけ**を抽出する。キャラクターは別物になるため、スタイル転写機能を作る場合のみ使う。

## プロンプトの書き方

- 参照画像は**`Picture 1`〜`Picture 3`**と呼ぶ。`TextEncodeQwenImageEditPlus`が視覚トークンをこのラベルで登録するため、`image1`等では紐づかない。接続順はImage 1ピン=Picture 1。
- 日本語の短い指示で動作する。例: 「Picture 1とPicture 2のキャラクターが握手する」。
- 同一性の維持をさらに強めたい場合は、維持したい特徴を明示する。例: 「元の外見・色・模様を保ったまま(keeping their original appearance)」、またはキャラクターの特徴を言葉でも添える。
- identity edit LoRAの2入力編集は「シーンをPicture 1、被写体をPicture 2」とする学習をしており、入力順が結果に影響する。キャラ2体の合成では主役をPicture 1にするのが無難。

## 実行パラメータ

| 項目 | 値 | 備考 |
| --- | --- | --- |
| Steps | 8 | Turbo蒸留モデルの推奨値。増やしてもブロックノイズ等は改善しない |
| CFG | 1 | **1のまま使う。** 2以上にするとノイズが増えて劣化する |
| sampler / scheduler | euler / simple | テンプレートに固定。アプリからは変更しない |
| 解像度 | 1024 × 1024基準 | `ModelSamplingFlux`のwidth/heightもアプリが実行時に上書きする |

## トラブルシューティング

- **出力が16px格子のブロックノイズになる**: 編集ワークフローのLoRAが外れているか、参照ラテントだけが有効になっている。`LoraLoaderModelOnly`が`krea2_identity_edit_v1_2.safetensors`を強度1.0で読んでいるか確認する。
- **キャラクターが別人になる**: LoRAが`krea2_style_reference`になっていないか確認する(画風転写用のため同一性を捨てる)。プロンプトで`Picture N`表記を使っているかも確認する。
- **参照画像がそのまま貼り付いたような出力になる**: `FluxKontextMultiReferenceLatentMethod`のmethodが`index_timestep_zero`以外になっている。
- **さらに同一性を高めたい場合の拡張余地**: LoRA配布元は専用ノードパック[comfyui-krea2edit](https://github.com/lbouaraba/comfyui-krea2edit)の`Krea2EditRebalance`(ref_boost≒4)を推奨している。現状はComfyUIコアノードのみで運用しており未導入。導入する場合は`runtime/ComfyUI/custom_nodes/`への追加が必要。

## ライセンス

- Krea 2本体・派生LoRAは[Krea 2 Community License](https://huggingface.co/krea/Krea-2-Turbo)の下で配布される。年商$1M未満の商用利用は許可(§2.3)。
- identity edit LoRAも同ライセンスの継承。非合意のディープフェイク生成は不可。

## 関連ファイル

- ワークフロー: [workflows/Krea2-Turbo.json](../../workflows/Krea2-Turbo.json) / [workflows/Krea2-Turbo-Generate.json](../../workflows/Krea2-Turbo-Generate.json)
- モデル選択の実装: `src/main/index.ts`(`runImageGeneration` / `applyRequest`)、`src/main/types.ts`(`GenerateModel`)
- 経緯の記録: [docs/changelog.md](../changelog.md) 2026-08-17の各項
