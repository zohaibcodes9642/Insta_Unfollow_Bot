## Insta Unfollow (Visible Chrome)

This script opens your local Chrome in a real, non-headless window, reuses your existing Chrome profile (so you stay logged in), and every hour unfollows up to 15 accounts from your Instagram "Following" list. The window stays open the whole time; it will not re-login between cycles.

### Requirements
- macOS with Google Chrome installed
- Node.js 18+ (`node -v` should be 18 or newer)

### Install
1. Open a terminal and run from the project root:
   - macOS: skip Playwright browser downloads since we use your installed Chrome
   ```sh
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install
   ```

2. Copy the environment template and edit as needed:
   ```sh
cp .env.example .env
   ```

### Configure
Edit `.env`:
- CHROME_USER_DATA_DIR: Your Chrome "User Data" folder. On macOS it is typically:
  - `/Users/<you>/Library/Application Support/Google/Chrome`
- CHROME_PROFILE: Your profile directory name, e.g. `Default`, `Profile 1`, etc.
  - Tip: In Chrome, open `chrome://version` and look at "Profile Path"; the last segment is the profile name.
- IG_USERNAME and IG_PASSWORD are optional. If your Chrome profile is already logged in to Instagram, you can leave them empty. If login is required, the script will either use these or you can log in manually in the opened window.
- UNFOLLOW_PER_CYCLE: How many to unfollow each run (default 15)
- CYCLE_MINUTES: Minutes between runs (default 60)
- MAX_UNFOLLOW_PER_DAY: Safety cap per day (default 150)

Chrome session options:
- `CHROME_CLOSE_EXISTING=true` to auto-close existing Chrome if the profile is locked (preferred if you want to reuse your main profile)
- `CHROME_ALLOW_TEMP=true` to let the script create a fresh temporary profile if the main one is locked
- `CHROME_CONNECT_OVER_CDP=true` to attach to an already open Chrome that you start with `--remote-debugging-port=9222` (keeps your exact session)
  - Example to start Chrome (macOS):
  ```sh
  /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222 &
  ```
  - Then run `npm start` and the script will attach to that Chrome.

Optional skip filters (add any to `.env` as needed):
- `SKIP_VERIFIED=true` to skip verified accounts
- `SKIP_PRIVATE=true` to skip private accounts
- `SKIP_CATEGORIES=artist,news` to skip by category strings
- `SKIP_ACCOUNT_TYPES=business,creator` to skip certain account types
- `SKIP_USERNAMES_CONTAIN=bot,test` to skip usernames containing any of these substrings

### Run (attach to your current Chrome by default)
1) Start Chrome with remote debugging enabled (once):
```sh
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222
```
2) Start the script:
```sh
npm start
```
By default, it will attach to your running Chrome at `http://localhost:9222`, reuse your session, and open its own window. If it can’t attach, it will tell you to relaunch Chrome with the flag above.

### Stop
- Press Ctrl+C in the terminal to stop the script

### Notes and Tips
- Instagram UI changes can break selectors; if unfollowing stops working, update selectors in `insta-unfollow.js`.
- Avoid aggressive settings. Too many unfollows in a short time can trigger rate limits or restrictions. The defaults are conservative.
- Two-factor authentication is supported when you log in manually in the visible Chrome window.

### Environment Template
See `.env.example` for a starter set of variables.

