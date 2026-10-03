# NCOverlay Custom: agent instructions

## Scope and upstream compatibility

- 本家 `Midra429/NCOverlay` への追従性を最優先する。
- `origin` はユーザー fork、`upstream` は本家とする。`main` は安定版であり、直接 commit しない。
- 作業は専用 branch で行い、Phase または明確な機能単位で commit / push / Draft PR を作成する。
- 通常 ChatGPT の独立レビューとユーザーの merge 判断を待つ。エージェント自身で merge しない。
- 指示された Phase だけを実施する。次 Phase へ独断で進まない。
- 既存 NCOverlay の UI / 機能を原則維持する。既存挙動の変更が必要な場合は理由と影響を PR に記載する。
- 既存ソースへの変更を最小限にし、新機能は可能な限り独立 module / component として追加する。
- 不要なリファクタリング、無関係な整形、類似機能の二重実装を行わない。

## Timeline Sync

- Provider 固有処理と Provider 非依存の同期処理を分離する。Netflix 固有条件を共通 Core に埋め込まない。
- 既存 `findMarkers()` / `findChapters()` / chapter 変換を調べ、利用可能な機能を再利用する。
- 自動 Timeline Sync、Global Offset、Slot Offset の役割・単位・符号・適用順を明記し、手動微調整を維持する。
- 根拠不足の場合は自動補正を適用しない。推測による誤補正より無補正を優先する。
- 同一 episode の再初期化と episode 切替を区別する。非同期処理、video 再生成、state / Renderer / background cleanup の整合性を確認する。
- Netflix / Prime Video 等の Web UI、内部 API、再生イベントに依存する処理は変更耐性を考慮する。
- DRM 回避や広告除去は対象外。
- Prime Video 広告対応は広告を除去せず、タイムライン変化の検出とコメント同期補正のみを扱う。複数広告 break、累積補正、session 差を考慮する。

## Verification and handoff

- 変更に応じた test / typecheck / lint / build を実行し、コマンドと結果を記録する。環境不足や失敗を成功扱いしない。
- upstream の `check` script は `biome check --write` である。無関係な変更を避けるため、調査・検証時は書込みを伴わない `biome check` を使う。
- 実機確認が必要な DOM / API / playback / 広告挙動は、mock や静的調査だけで確認済みとしない。
- PR 本文には Purpose / Changes / Architecture / Files / Verification / Manual verification / Risks / Upstream compatibility / Open questions を含める。
- 完了時に branch、commit SHA、Draft PR URL、変更ファイル、主要結論、未確認事項、次工程案を報告する。
- コード、UI、設定の実変更時は原則 `review_pack/REVIEW.md` と `review_pack/changes.diff` を作る。要求、変更内容とファイル、主要箇所、検証結果、既知問題、独立レビューの重点を記載し、Git diff と照合可能な根拠を優先する。
- UI 変更時は可能なら変更後のスクリーンショットを添える。調査のみ、回答のみ、変更なし、ごく軽微な変更は review_pack を省略できる。資料のために本実装を複雑化しない。
