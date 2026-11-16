# 開發流程移轉清單（草稿 v0.1）

日期：2026-11-16　狀態：**草稿**，由文書串（文件管理）追蹤；每做完一步，勾選並註明日期與誰做的。
來源：交接 md 第 6 節，加上原則草稿裡新增的前置條件（WP-03、WP-05、E-07、S-06、S-09）。

做不到的步驟只有 Simon 本人能做（需要他的 Google 與 GitHub 帳號）的，標「👤 Simon」；Claude 可以代做的，標「🤖」。
連結是我依 GitHub 與 Google 現行網址整理的，若畫面和描述不同，以實際畫面為準並回報修正。

## 順序重點

先停推送、再撤權杖、最後才鎖 `main`。倒過來做會讓正在跑的 GAS 推送失敗或留下仍有效的權杖。

## 階段一：切斷舊的發布管道（資安優先）

| # | 步驟 | 誰 | 連結 | 完成條件 |
| --- | --- | --- | --- | --- |
| 1 | 關閉 GAS 從 Drive 推送到 GitHub 的定時觸發器（06:00／11:00／15:00 那組） | 👤 Simon | [GAS 觸發器總覽](https://script.google.com/home/triggers)（找到對應專案，刪除所有 `syncDriveBackupToGitHub` 相關觸發器） | 觸發器清單中沒有該函式 |
| 2 | 到 GitHub 撤銷存在 GAS 裡的存取權杖 | 👤 Simon | [Personal access tokens（classic）](https://github.com/settings/tokens)、[Fine-grained tokens](https://github.com/settings/personal-access-tokens)（依當初建立類型擇一，找到給此 repo 用的那把刪除） | 兩個頁面都沒有此用途的權杖 |
| 3 | 清掉 GAS 指令碼屬性裡的 `GITHUB_TOKEN` | 👤 Simon | GAS 專案編輯器 → 專案設定 → 指令碼屬性（連結因專案而異，請從[GAS 首頁](https://script.google.com/home)進入） | 屬性清單中無 `GITHUB_TOKEN` |
| 4 | 確認 GAS 部署權限與用途：目前「所有人」可存取，確認只用於家庭資料同步，不再有發布功能 | 👤 Simon（🤖 協助審 `Code.gs`） | 同上 | 見階段二第 6 項的審查結論 |

## 階段二：把程式納入 repo 與審查

| # | 步驟 | 誰 | 連結 | 完成條件 |
| --- | --- | --- | --- | --- |
| 5 | 把 `Code.gs` 放進 repo（例如 `/gas`），以 PR 提交 | 🤖（需 Simon 先授權開工，依 W-08） | [repo](https://github.com/simonyu26/family-disaster-kit) | PR 合併，`Code.gs` 在 repo 內 |
| 6 | 審查 `Code.gs`：PIN 驗證方式、`setGitHubConfig` 權限、是否仍含 GitHub 推送程式碼（S-06、S-09） | 🤖 工程顧問 | 同 PR | 審查結論附在 PR，含是否移除推送程式碼 |
| 7 | 補進美術規範與對照表：`ART_DESIGN_SPEC.md`、`EMOJI_MAP.json`（emoji 掃描工具暫不補，依 E-07、Q-5，待 v3.0 處理） | 🤖（需授權開工） | 同 repo | 檔案在 repo 內 |
| 8 | 新增 `CLAUDE.md`（內容取自定案後的原則；交接 md 第 7 節只是草稿） | 🤖（需授權開工） | 同 repo | PR 合併 |
| 9 | 新增 PR 範本（部署核對勾選項，WP-05） | 🤖（需授權開工） | 同 repo（`.github/pull_request_template.md`） | 範本在 repo 內 |

## 階段三：連結 Claude 與保護 main

| # | 步驟 | 誰 | 連結 | 完成條件 |
| --- | --- | --- | --- | --- |
| 10 | 確認 claude.ai 已連結 GitHub | 👤 Simon | [連結 GitHub](https://claude.ai/connect-github) | 連結狀態為已連結 |
| 11 | 安裝 Claude GitHub App 到此 repo | 👤 Simon | [安裝 Claude GitHub App](https://github.com/apps/claude/installations/select_target)（只勾選 `family-disaster-kit`） | App 出現在 [已安裝 App 清單](https://github.com/settings/installations) |
| 12 | `main` 設為禁止直接推送，只能經 PR 合併（WP-03） | 👤 Simon | [Branch 保護設定](https://github.com/simonyu26/family-disaster-kit/settings/branches)（建議開：要求 PR、至少 1 位核准、禁止強制推送、管理員也適用） | 直接推送到 `main` 被拒絕 |
| 13 | 確認 GitHub Pages 發布來源是 `main`，並確認舊推送不再覆蓋 | 👤 Simon | [Pages 設定](https://github.com/simonyu26/family-disaster-kit/settings/pages) | 來源為 `main`；第一次合併後網站更新正常 |

## 階段四：試跑

| # | 步驟 | 誰 | 完成條件 |
| --- | --- | --- | --- |
| 14 | 以一個小 PR 完整試跑一次：執行長串開發 → 顧問審查 → 協調者合併建議 → Simon 在 06:00 時段合併 → 發布 → 文書串更新進度表與 Drive 備份 | 全員 | 全流程跑通，記錄問題 |

## 待確認

- 階段一第 1、3 項的實際位置要在 GAS 專案內看，我沒有該專案連結，請 Simon 開啟後告訴我或直接勾選。
- 第 12 項「至少 1 位核准」：Simon 是 repo 唯一擁有者，若自己的 PR 不能自己核准，需決定是否關掉此項；建議先不要求核准人數，只要求 PR。
