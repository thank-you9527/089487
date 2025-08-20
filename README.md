# Text Adventure Demo

This repo contains a simple front-end prototype for a text-based adventure game
interface. Open `index.html` in a browser to try it.

Features:
- Scrollable log area with search and lazy loading of older entries.
- Command textarea (500 characters max) and a send button.
- Sidebar menu with a logout button.
- Welcome messages for first-time and returning visitors.
- Basic command system processed by the backend, including movement, region capture, monster spawning, and combat commands.
- Character attributes (HP, attack, action points, and XP limits) are derived from logistic growth formulas up to level 5000.
- Regions may carry a return marker that allows binding a respawn point via the `歐歐睏` command.
- Player health regenerates over time and death causes respawn with a chance to drop an inventory item.
- Simple inventory with up to 20 items and commands to inspect contents.

Logs are stored in `localStorage` for demonstration purposes only.

## Supported Commands

- `看看` / `看看/名稱` – view your own or another unit's information.
- `看路` – show current location info.
- Movement: `前進`, `後退`, `左轉`, `右轉`, `打老鷹`, `挖地瓜`.
- `佔領/地名` – name and capture an unowned area.
- `孵化/怪物名稱` – create a monster in your territory.
- `歐歐睏` – bind your soul to a return marker for respawn.
- `查看家當` / `查看家當/道具名稱` – inspect your inventory or a specific item.
- `歐拉` / `歐拉/怪物名稱` – attack random or specified targets.
