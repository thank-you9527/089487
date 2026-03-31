# 可執行清單：你本機測試、我在 GitHub 編輯

> 目的：你先照清單在本機可重複執行；確認方向 OK 後，我再分批提交程式修改，你只要 pull 下來測試回報結果。

---

## 協作模式（先對齊）

- **我負責**：在 GitHub 上改程式、提交 commit、寫變更說明。
- **你負責**：把最新分支拉到本機，執行命令與回報結果。
- **節奏**：每一批改動都用「一個目標 + 一組驗收命令」。

---

## A. 第 0 階段（一次性）— 先建立穩定本機環境

### A1) 建立本機環境變數檔
在專案根目錄建立 `.env.local`（你本機用，不要上傳）：

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5432/game_local
JWT_SECRET=replace-with-a-random-secret
COOKIE_SECURE=false
DISABLE_CAPTCHA=true
SESSION_TTL_HOURS=24
SESSION_IDLE_TIMEOUT_SEC=1800
NODE_ENV=development
```

### A2) 用 Docker 啟本機 Postgres（若你已安裝本機 PG 可略過）
```bash
docker run --name game-pg \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_DB=game_local \
  -p 5432:5432 \
  -d postgres:16
```

### A3) 安裝依賴
```bash
npm install
```

---

## B. 每次拿到我新 commit 時，你要跑的固定流程（可直接複製）

> 以下假設你在專案根目錄。

### B1) 拉最新程式
```bash
git fetch origin
git checkout <我們約定的分支>
git pull
```

### B2) 匯入環境變數
macOS/Linux:
```bash
set -a
source .env.local
set +a
```

Windows PowerShell（改用手動 `setx` 或工具載入）

### B3) 啟動伺服器（開新終端）
```bash
npm start
```

### B4) 跑測試（回報完整輸出）
```bash
npm test
npx jest --runInBand
```

### B5) 你回報給我的格式（直接貼）
```text
[批次名稱]：
1) npm test：PASS/FAIL（附錯誤前 30 行）
2) npx jest --runInBand：PASS/FAIL（附失敗 suite 名稱）
3) 手動驗收：
   - 註冊/登入：PASS/FAIL
   - 地圖移動/看路：PASS/FAIL
   - 佔領/怪物生成：PASS/FAIL
   - 戰鬥/掉落：PASS/FAIL
4) 其他異常：
```

---

## C. 我們接下來的「可執行改版順序」

> 你說方向 OK 後，我就按這個順序在 GitHub 分批提交；你每批 pull 下來測。

### 批次 1（優先）：讓 `npm test` 真正執行測試
**我會做**
- 把 `package.json` 的 `test` script 改為 Jest（不再是 no-op）。

**你驗收**
```bash
npm test
```
預期：會真的跑測試，而不是只印 `(no tests)`。

---

### 批次 2（優先）：修 `pg-mem` 與 `plpgsql` 相容
**我會做**
- 調整 `db.js init()`：測試模式下略過不相容語句，或改成相容寫法。

**你驗收**
```bash
npx jest --runInBand
```
預期：不再出現 `Unknown language "plpgsql"`。

---

### 批次 3：降低 `DATABASE_URL` 載入時崩潰風險
**我會做**
- 避免在 require 階段直接 throw，改為啟動階段檢查或測試可覆寫。

**你驗收**
```bash
npm test
npx jest --runInBand
```
預期：測試載入模組不會因為缺環境變數立刻崩潰。

---

### 批次 4：文件與安全預設對齊
**我會做**
- README 的 TTL 預設值對齊實作。
- DB SSL 設定改成可安全預設（production 驗證憑證）。

**你驗收**
```bash
npm start
```
預期：本機可正常啟動；你確認設定說明與實際一致。

---

## D. 你現在只要先做這 3 件事

1. 在本機建立 `.env.local`。  
2. 確認本機 Postgres 可連線（Docker 或本機服務皆可）。  
3. 回我一句：**「方向 OK，請開始批次 1」**。

收到後我就開始改第一批，並給你「精準驗收命令 + 預期結果」。
