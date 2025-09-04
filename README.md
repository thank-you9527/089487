# Text Adventure Demo

This repo contains a simple front-end prototype for a text-based adventure game
interface.

## Running
1. Install dependencies: `npm install`
2. Start the server: `npm start`
3. Open `http://localhost:3000/` in your browser.
   The landing page offers links to register or log in before entering the game.


Features:
- Scrollable log area with search and lazy loading of older entries.
- Command textarea (500 characters max) and a send button.
- Sidebar menu with a logout button.
- Welcome messages for first-time and returning visitors.
- Basic command system processed by the backend, including movement, region capture, monster spawning, and combat commands.
- Character attributes (HP, attack, and XP limits) follow logistic growth, while action points increase linearly from 100 at level 1 to 300 at level 100 and remain capped thereafter.
- Regions may randomly gain a return marker (5% chance on capture) that allows binding a respawn point via the `歐歐睏` command, placing the player into a resting state.
- Player health regenerates over time and death causes respawn with a chance to drop an inventory item.
- Simple inventory with up to 20 items and commands to inspect contents.

Logs are stored in `localStorage` for demonstration purposes only.

## Supported Commands

- `看看` / `看看/名稱` – view your own or another unit's information.
- `看路` – show current location info.
- Movement: `前進`, `後退`, `左轉`, `右轉`, `打老鷹`, `挖地瓜`.
- `佔領/地名` – name and capture an unowned area.
- `孵化/怪物名稱` – create a monster in your territory.
- `歐歐睏` – bind your soul to a return marker for respawn and enter a resting state.
- `查看家當` / `查看家當/道具名稱` – inspect your inventory or a specific item.
- `歐拉` / `歐拉/怪物名稱` – attack random or specified targets.
