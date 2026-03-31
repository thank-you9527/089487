# 本地優先（Local-first）驗證草案

> 目標：先在本機把「登入/指令/戰鬥/地圖」整條流程跑穩，再把同一套 schema + migration 部署到雲端資料庫。

## 先回答你的問題：這個方向對嗎？

**方向是對的，而且很推薦。**
原因是：
1. 本地可快速迭代，不會被雲端網路延遲與權限問題干擾。
2. 先把資料模型與 migration 固定，才能避免「雲端先改、程式後補」造成漂移。
3. 測試與 seed 流程在本地可重複執行，失敗可快速重建。

---

## 建議的執行順序（草案）

## Phase 0：先「凍結現況」避免再漂移

- 把目前雲端 DB schema 匯出成 baseline（SQL 檔）。
- 記錄目前正在使用的環境變數（不含密碼本身）。
- 建一份 migration 清單（已執行到哪個版本）。

**說明**：
先凍結現況，才知道「本地要對齊到哪個真實版本」。

## Phase 1：建立本地 Postgres（不要再直接依賴雲端）

- 用 Docker 啟一個本地 PostgreSQL（建議固定版本，例如 16）。
- 建立 `.env.local`（只給本機使用）：
  - `DATABASE_URL=postgres://...localhost...`
  - `JWT_SECRET=...`
  - `COOKIE_SECURE=false`
  - `DISABLE_CAPTCHA=true`
- 專案啟動時只讀 `.env.local`（或用啟動腳本切換）。

**說明**：
你現在最需要的是「可重建、可反覆測」的環境，而不是先連雲端。

## Phase 2：資料庫初始化流程標準化

- 把 schema 建立、索引、trigger、seed 拆成可重複執行步驟：
  1) schema
  2) migration
  3) seed（地圖/系統區域）
- 每次本地重建都用同一組命令（例如 `db:reset` + `seed:regions`）。

**說明**：
這能避免「某人手動在 DB 改過，程式裡沒有」的隱藏狀況。

## Phase 3：先補齊自動化測試入口（最優先）

- 把 `npm test` 改成真的跑 Jest（現在是 no-op）。
- 測試環境固定注入 `DATABASE_URL=pg-mem://tests` 或 local test DB。
- 若採 `pg-mem`：
  - 避免在測試初始化執行不相容 `plpgsql` 區塊，或改成可相容寫法。
- 至少確保以下測試全綠：
  - 註冊/登入/登出
  - 地圖讀寫（移動、佔領、查詢）
  - 戰鬥與掉落
  - 背包與 crafting

**說明**：
沒有自動化測試綠燈，就不建議上雲端。

## Phase 4：本地驗收清單（手動 + 自動）

### 核心驗收
- 新帳號註冊、登入、拿 token/cookie 正常。
- 地圖操作完整可用（看路、移動、佔領、怪物生成）。
- DB 重啟後資料仍在（地圖與角色狀態一致）。
- 多帳號同時操作不會出現資料競態或覆蓋錯亂。

### 失敗情境驗收
- DB 連線中斷時 API 有正確錯誤回應。
- 非法指令、缺參數、越權操作都有明確錯誤訊息。
- Session 過期與單點登入策略符合預期。

## Phase 5：再推回雲端（託管 DB）

- 用同一份 migration 自動部署，不要手動改表。
- 部署前先備份雲端 DB（snapshot）。
- 先把 staging 連到託管 DB，通過驗收再上 production。
- 上線後觀察：慢查詢、錯誤率、連線數、session 異常率。

**說明**：
關鍵不是「有沒有上雲」，而是「是否用同一套可回放流程上雲」。

---

## 推薦實務（你現在就可以採用）

1. **雙環境設定檔**
   - `.env.local`：本機開發
   - `.env.staging`：預備環境
   - `.env.production`：正式環境

2. **固定 migration 工具**（擇一）
   - node-pg-migrate / Knex / Prisma Migrate

3. **資料重建一鍵化**
   - `npm run db:reset`
   - `npm run db:migrate`
   - `npm run seed:regions`

4. **先 staging、再 production**
   - 不要從 local 直接跳 production。

5. **回滾策略先寫好**
   - 每次 DB 結構變更都要有 rollback plan。

---

## 你下一步可以直接做的 7 天小計畫（草案）

- Day 1：建立本地 Postgres + `.env.local` + 啟動成功。
- Day 2：整理 migration 流程，確保可重跑。
- Day 3：修 `npm test` 真正執行測試。
- Day 4：修 `pg-mem`/測試 DB 相容問題。
- Day 5：地圖與戰鬥核心流程驗收。
- Day 6：staging 對接託管 DB，跑完整驗收。
- Day 7：寫上線與回滾 Runbook，準備 production。

---

## 結論

- 你的方向（先回本地驗證，再上託管雲端 DB）是正確且成熟的作法。
- 最重要的是把「本地可重現流程」與「migration 一致性」建立起來。
- 若你同意，我下一版可以幫你把這份草案落成**可直接執行的 checklist + 指令清單**（含 `.env` 範本、Docker 啟動、驗收腳本）。
