# 程式碼檢查報告（2026-03-31）

## 1) 已確認的 bug

### Bug A：`pg-mem` 測試環境無法執行 `plpgsql`，導致 DB 初始化失敗
- 問題位置：`db.js` 在 `init()` 的 DDL 字串中包含多段 `DO $$ ... $$` 與 `LANGUAGE plpgsql` trigger/function 定義。
- 影響：使用 `DATABASE_URL=pg-mem://...` 的單元測試會在初始化時失敗，錯誤為 `Unkonwn language "plpgsql"`（原始拼字來自 pg-mem 錯誤訊息）。
- 風險：CI 與本地測試不穩定，造成回歸缺陷無法被及時攔截。

### Bug B：`npm test` 沒有執行任何測試
- 問題位置：`package.json` 的 test script 只輸出 `(no tests)` 後 `exit 0`。
- 影響：即使測試實際失敗，`npm test` 仍顯示成功，容易誤判品質狀態。
- 風險：發布前缺陷未被發現。

## 2) 可能的風險

### 風險 A：啟動即強依賴 `DATABASE_URL`
- 問題位置：`db.js` 在模組載入階段就直接檢查 `process.env.DATABASE_URL` 並 `throw`。
- 影響：某些只想載入命令模組、或尚未注入環境變數的測試情境會直接崩潰。
- 風險：測試可維護性下降、模組耦合過高。

### 風險 B：Postgres SSL 預設關閉憑證驗證
- 問題位置：`db.js` 的 `Pool` 設定在 `DB_SSL !== 'false'` 時使用 `{ rejectUnauthorized: false }`。
- 影響：若在公開網路部署且未透過私網/可信代理，可能遭受中間人攻擊風險。
- 風險：連線安全性不符合較嚴格的生產環境要求。

### 風險 C：文件與實作的 session TTL 預設值不一致
- README 寫預設 `SESSION_TTL_HOURS=24`，但 `db.js` 內實作預設是 `24 * 7`（7 天）。
- 影響：維運參數認知錯誤，導致會話存活時間與預期不一致。
- 風險：安全策略與實際行為偏差。

## 3) 預計要作但未完成／落地不足的項目

### 未完成 A：測試流程尚未整合到標準入口
- 現況：已有 Jest 測試檔案，但 `npm test` 沒有接到 Jest。
- 判定：這通常代表「測試治理」尚未完成（標準命令未落地）。

### 未完成 B：`pg-mem` 相容策略未完成
- 現況：程式已判斷 `IS_PG_MEM`，但初始化 SQL 仍含 `pg-mem` 不支援的 `plpgsql` 語句，顯示相容性處理未完成。

## 4) 建議修正優先順序（高→低）
1. **先修測試可用性**：讓 `npm test` 執行 Jest，並補 `DATABASE_URL=pg-mem://tests` 的測試啟動設定。
2. **處理 pg-mem 相容**：在 `IS_PG_MEM` 分支跳過 `DO $$` / `plpgsql` 區塊，或在 pg-mem 註冊對應語言/改寫為相容 SQL。
3. **修正文檔一致性**：README 與實作統一 session TTL 預設值。
4. **強化 DB SSL**：生產預設啟用憑證驗證，允許用明確環境變數在開發環境覆寫。
