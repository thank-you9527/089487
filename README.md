# Text Adventure Demo

This repo contains a simple front-end prototype for a text-based adventure game
interface.

## Running
1. Install dependencies: `npm install`
2. Configure environment variables:
   - `export DATABASE_URL=postgres://user:pass@host:5432/dbname`
   - `export JWT_SECRET=your-secret`
   - `export SESSION_TTL_HOURS=24` *(optional, defaults to 24)*
   - `export SESSION_IDLE_TIMEOUT_SEC=600` *(optional, defaults to 600 seconds)*
   - `export COOKIE_SECURE=true` *(optional; defaults to `true` when `NODE_ENV=production`, otherwise `false`)*
   - `export DISABLE_CAPTCHA=false` *(optional; set to `true` locally to skip CAPTCHA checks while developing)*
   (Windows use `set` instead of `export`.)
   You can also place these values in a `.env` file if you use a manager like [direnv](https://direnv.net/) or `dotenv-cli`.

   **Local development example**
   ```bash
   NODE_ENV=development
   COOKIE_SECURE=false
   DISABLE_CAPTCHA=true
   DATABASE_URL=postgres://user:pass@localhost:5432/game
   JWT_SECRET=replace-this-with-a-random-string
   ```
3. Start the server: `npm start`
4. Open `http://localhost:3000/` in your browser.
   The landing page offers links to register or log in before entering the game.

Authentication tokens are delivered via an HttpOnly cookie; the client does not need to store them.

### Data storage
Player accounts, sessions, the shared world map, and monster spawns live in PostgreSQL (see `schema.sql`).
Run `npm run seed:regions` to populate protected/system regions from `seeds/preset_regions.json`, and optionally execute
`npm run import:map` once to migrate legacy `data/map.json` files into the database. After seeding/importing, the server reads
and writes all region data directly through Postgres—no JSON fallbacks are required.

### Seeding system regions
- Define protected regions in `seeds/preset_regions.json`. Each entry accepts coordinates, name, level, and optional monster definitions. Regions flagged as `is_system` become non-claimable/non-destructible and can expose an `owner_display` label for GM-controlled areas.
- Run `npm run seed:regions` to upsert the presets into PostgreSQL. The script is idempotent, so you can rerun it whenever the seed file changes.

### Observability & operations
- **Real-time events** – Clients open `GET /api/events` (Server-Sent Events) to receive combat logs and system updates instantly. The stream accepts `Last-Event-ID`/`sinceId` to backfill the latest 200 events and emits keep-alives every 25 seconds to stay proxy-friendly.
- **Rate limiting** – Authenticated API routes enforce a sliding-window bucket of 3 commands per second (burst 6) per account and IP. Responses expose `X-RateLimit-*` headers and return `429 { "error": "rate-limited" }` when exceeded.
- **Session lifecycle** – Sessions last up to `SESSION_TTL_HOURS` (default 24) and expire after `SESSION_IDLE_TIMEOUT_SEC` (default 600) seconds of inactivity. The client sends `/api/ping` heartbeats while the page is open and posts to `/api/logout-beacon` when the tab closes so single-login enforcement releases promptly.
- **Slow-query logging** – Database calls slower than 200 ms (500 ms for event backfills) log `[slow-sql]` with the statement snippet to aid tuning.
- **Event retention** – An hourly background job wins an advisory lock before deleting batches of read events older than 30 days, logging the number of rows purged.


Features:
- Scrollable log area with search and lazy loading of older entries.
- Command textarea (500 characters max) and a send button.
- Sidebar menu with a logout button.
- Welcome messages for first-time and returning visitors.
- Basic command system processed by the backend, including movement, region capture, monster spawning, and combat commands.
- Character attributes use logistic growth (K=0.0046, center=2500) so level 1 stats start near their base values while level 5000 approaches the caps. Action points grow linearly from 100 to 300 by level 300 and remain there afterward.
- Regions may randomly gain a return marker (5% chance on capture) that allows binding a respawn point via the `歐歐睏` command, placing the player into a resting state.
- Player health regenerates over time and death causes respawn with a chance to drop an inventory item.
- Inventory slots cap at 10 items; excess pickups auto-discard the lowest-level piece and emit an `auto_drop` event.

Logs are stored in `localStorage` for demonstration purposes only.

## Supported Commands

- `看看` / `看看/名稱` – view your own or another unit's information.
- `看路` – show current location info.
- Movement: `前進`, `後退`, `左轉`, `右轉`, `打老鷹`, `挖地瓜`.
- `佔領/地名` – name and capture an unowned area.
- `孵化/怪物名稱` – create a monster in your territory.
- `歐歐睏` – bind your soul to a return marker for respawn and enter a resting state.
- `查看家當` – list the items in your pack.
- `捏捏/道具名稱` – craft or refresh an item you originally created.
- `蛋雕/道具名稱` – delete an item from your pack (soft delete) to free the name.
- `讓我看看/前綴+道具名稱` – inspect any crafted item’s details, regardless of owner.
- `歐拉` / `歐拉/怪物名稱` – attack random or specified targets.
