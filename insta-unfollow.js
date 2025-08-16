import 'dotenv/config';
import { chromium } from 'playwright';
import { mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { exec as execCb } from 'child_process';
import { promisify } from 'util';

const exec = promisify(execCb);

// Configuration
const INSTAGRAM_URL = 'https://www.instagram.com/';
const PROFILE_URL = (username) => `https://www.instagram.com/${username}/`;
const UNFOLLOW_PER_CYCLE = parseInt(process.env.UNFOLLOW_PER_CYCLE || '15', 10);
const CYCLE_MINUTES = parseInt(process.env.CYCLE_MINUTES || '60', 10); // 60 minutes
const MAX_UNFOLLOW_PER_DAY = parseInt(process.env.MAX_UNFOLLOW_PER_DAY || '150', 10); // safety cap
const RUN_ON_START = (process.env.RUN_ON_START || 'true').toLowerCase() !== 'false';
// Skip rules
const SKIP_VERIFIED = (process.env.SKIP_VERIFIED || 'false').toLowerCase() === 'true';
const SKIP_PRIVATE = (process.env.SKIP_PRIVATE || 'false').toLowerCase() === 'true';
const SKIP_CATEGORIES = (process.env.SKIP_CATEGORIES || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const SKIP_USERNAME_SUBSTRINGS = (process.env.SKIP_USERNAMES_CONTAIN || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const SKIP_ACCOUNT_TYPES = (process.env.SKIP_ACCOUNT_TYPES || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean); // e.g. business, creator

// Use your existing Chrome profile to avoid re-login prompts as much as possible.
// Edit this path if Chrome is installed elsewhere.
// On macOS default: ~/Library/Application Support/Google/Chrome
// On Windows default: C:\\Users\\<you>\\AppData\\Local\\Google\\Chrome\\User Data
// On Linux default: ~/.config/google-chrome
const DEFAULT_USER_DATA_DIR = process.env.CHROME_USER_DATA_DIR || `${process.env.HOME}/Library/Application Support/Google/Chrome`;
const DEFAULT_PROFILE = process.env.CHROME_PROFILE || 'Default';
const FALLBACK_USER_DATA_DIR = process.env.CHROME_FALLBACK_USER_DATA_DIR || path.join(process.env.HOME || process.cwd(), '.insta-unfollow-chrome');
const CHROME_ALLOW_TEMP = (process.env.CHROME_ALLOW_TEMP || 'false').toLowerCase() === 'true';
const CHROME_CLOSE_EXISTING = (process.env.CHROME_CLOSE_EXISTING || 'false').toLowerCase() === 'true';
const CHROME_CONNECT_OVER_CDP = (process.env.CHROME_CONNECT_OVER_CDP || 'false').toLowerCase() === 'true';
const CHROME_CDP_URL = process.env.CHROME_CDP_URL || 'http://localhost:9222';
const CHROME_FALLBACK_SLOTS = parseInt(process.env.CHROME_FALLBACK_SLOTS || '5', 10);
// Clock-based scheduling
const RUN_AT_HOURS = (process.env.RUN_AT_HOURS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => Number(s))
  .filter((n) => Number.isInteger(n) && n >= 0 && n <= 23);
const RUN_AT_MINUTE = parseInt(process.env.RUN_AT_MINUTE || '0', 10);
const RUN_AT_SECOND = parseInt(process.env.RUN_AT_SECOND || '0', 10);

// Credentials are optional if your Chrome profile is already logged in
const USERNAME = process.env.IG_USERNAME || '';
const PASSWORD = process.env.IG_PASSWORD || '';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isLoggedIn(page) {
  try {
    const cookies = await page.context().cookies('https://www.instagram.com');
    return cookies.some((c) => c.name === 'sessionid' && c.value);
  } catch {
    return false;
  }
}

async function waitForLoggedIn(page, timeoutMs = 10 * 60 * 1000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isLoggedIn(page)) return true;
    // If redirected to challenge/2FA pages, just keep waiting for manual completion
    await sleep(3000);
  }
  return false;
}

async function ensureLoggedIn(page) {
  await page.goto(INSTAGRAM_URL, { waitUntil: 'domcontentloaded' });
  if (await isLoggedIn(page)) return; // already logged in via cookies

  // If login form is visible, either manual or credential-based login
  const loginFormVisible = await page.locator('input[name="username"]').first().isVisible().catch(() => false);
  if (!loginFormVisible) {
    // Maybe on some interstitial, but not logged in yet; wait for manual login/2FA
    console.log('Waiting for you to log in (2FA supported). You have up to 10 minutes...');
    await waitForLoggedIn(page);
    return;
  }

  if (!USERNAME || !PASSWORD) {
    console.log('Instagram shows login. Login manually in the opened window and complete 2FA if prompted. Waiting up to 10 minutes...');
    await waitForLoggedIn(page);
    return;
  }

  await page.fill('input[name="username"]', USERNAME, { timeout: 30_000 });
  await page.fill('input[name="password"]', PASSWORD);
  const loginSelectors = [
    'button[type="submit"]',
    'button:has-text("Log in")',
    'button:has-text("Log In")',
    'text=Log in'
  ];
  for (const sel of loginSelectors) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible().catch(() => false)) {
      await btn.click().catch(() => {});
      break;
    }
  }
  console.log('If 2FA challenge appears, complete it in the browser. Waiting (up to 10 minutes)...');
  await waitForLoggedIn(page);

  // Handle dialogs like "Save Your Login Info?" or notifications
  const buttons = page.locator('div[role="dialog"] button');
  const count = await buttons.count().catch(() => 0);
  for (let i = 0; i < count; i += 1) {
    const txt = (await buttons.nth(i).innerText().catch(() => '')).toLowerCase();
    if (['not now', 'cancel'].some((t) => txt.includes(t))) {
      await buttons.nth(i).click().catch(() => {});
    }
  }
}

async function dismissPopups(page) {
  // Cookie dialogs
  const cookieButtons = [
    'button:has-text("Only allow essential cookies")',
    'button:has-text("Allow all cookies")',
    'button:has-text("Accept all")',
    'button:has-text("Accept")',
  ];
  for (const sel of cookieButtons) {
    const b = page.locator(sel).first();
    if (await b.isVisible().catch(() => false)) {
      await b.click().catch(() => {});
    }
  }
  // Save login / notifications dialogs
  const dialogButtons = page.locator('div[role="dialog"] button');
  const count = await dialogButtons.count().catch(() => 0);
  for (let i = 0; i < count; i += 1) {
    const txt = (await dialogButtons.nth(i).innerText().catch(() => '')).toLowerCase();
    if (['not now', 'cancel'].some((t) => txt.includes(t))) {
      await dialogButtons.nth(i).click().catch(() => {});
    }
  }
}

async function resolveUsername(page) {
  if (USERNAME) return USERNAME;
  // Try Instagram internal API
  try {
    const data = await page.evaluate(async () => {
      try {
        const r = await fetch('https://www.instagram.com/api/v1/accounts/current_user/', { credentials: 'include' });
        if (!r.ok) return null;
        return await r.json();
      } catch {
        return null;
      }
    });
    const fromApi = data?.user?.username || data?.username || '';
    if (fromApi) return fromApi;
  } catch {}

  // Fallback: read from accounts/edit username input
  try {
    await page.goto('https://www.instagram.com/accounts/edit/', { waitUntil: 'domcontentloaded' });
    const input = page.locator('input[name="username"]').first();
    await input.waitFor({ timeout: 30_000 });
    const val = (await input.inputValue()).trim();
    if (val) return val;
  } catch {}

  return '';
}

async function getCurrentUserId(page) {
  try {
    const data = await page.evaluate(async () => {
      try {
        const r = await fetch('https://www.instagram.com/api/v1/accounts/current_user/', { credentials: 'include' });
        if (!r.ok) return null;
        return await r.json();
      } catch {
        return null;
      }
    });
    return data?.user?.pk || data?.user?.id || data?.pk || data?.id || null;
  } catch {
    return null;
  }
}

async function fetchFollowingUsers(page, maxNeeded = 50) {
  const userId = await getCurrentUserId(page);
  if (!userId) return [];
  let nextMaxId = undefined;
  const users = [];
  while (users.length < maxNeeded) {
    // Instagram web app id header improves success rate
    const result = await page.evaluate(async ({ uid, max_id }) => {
      const headers = { 'X-IG-App-ID': '936619743392459' };
      const url = new URL(`https://www.instagram.com/api/v1/friendships/${uid}/following/`);
      url.searchParams.set('count', '50');
      if (max_id) url.searchParams.set('max_id', max_id);
      const r = await fetch(url.toString(), { credentials: 'include', headers });
      if (!r.ok) return null;
      return await r.json();
    }, { uid: String(userId), max_id: nextMaxId || null }).catch(() => null);

    if (!result || !Array.isArray(result.users)) break;
    for (const u of result.users) {
      if (u?.username) users.push(u);
      if (users.length >= maxNeeded) break;
    }
    nextMaxId = result.next_max_id;
    if (!nextMaxId) break;
  }
  return users;
}

function shouldSkipUser(u) {
  const uname = (u?.username || '').toLowerCase();
  const fname = (u?.full_name || '').toLowerCase();
  if (SKIP_VERIFIED && u?.is_verified) return true;
  if (SKIP_PRIVATE && u?.is_private) return true;
  if (SKIP_USERNAME_SUBSTRINGS.some((s) => uname.includes(s))) return true;
  if (SKIP_CATEGORIES.length && (u?.category || u?.category_name)) {
    const cat = (u.category || u.category_name || '').toLowerCase();
    if (SKIP_CATEGORIES.some((c) => cat.includes(c))) return true;
  }
  if (SKIP_ACCOUNT_TYPES.length && (u?.account_type || u?.is_business || u?.is_professional)) {
    const types = [];
    if (u.account_type) types.push(String(u.account_type).toLowerCase());
    if (u.is_business) types.push('business');
    if (u.is_professional) types.push('creator');
    if (types.some((t) => SKIP_ACCOUNT_TYPES.includes(t))) return true;
  }
  return false;
}

async function waitForFollowState(page, timeoutMs = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    // Expect to see Follow or Follow back after successful unfollow
    const followBtn = page.locator('button:has-text("Follow"), button:has-text("Follow back")').first();
    if (await followBtn.isVisible().catch(() => false)) return true;
    await sleep(300);
  }
  return false;
}

async function unfollowByVisitingProfiles(page, usersOrUsernames, maxCount) {
  let unfollowed = 0;
  for (const entry of usersOrUsernames) {
    if (unfollowed >= maxCount) break;
    const uname = typeof entry === 'string' ? entry : entry?.username;
    const userObj = typeof entry === 'string' ? null : entry;
    if (!uname) continue;
    if (userObj && shouldSkipUser(userObj)) continue;
    try {
      await page.goto(`https://www.instagram.com/${uname}/`, { waitUntil: 'domcontentloaded' });
      await dismissPopups(page);
      const followButtonSelectors = [
        'button:has-text("Following")',
        'div[role="button"]:has-text("Following")',
        'button[aria-label="Following"]',
        'button:has-text("Requested")',
      ];
      let clicked = false;
      for (const sel of followButtonSelectors) {
        const btn = page.locator(sel).first();
        if (await btn.isVisible().catch(() => false)) {
          await btn.click({ delay: 50 }).catch(() => {});
          clicked = true;
          break;
        }
      }
      if (!clicked) continue; // not following or button not found

      // Handle confirmation or request-cancel menu
      const confirmSelectors = [
        'button:has-text("Unfollow")',
        'button:has-text("Cancel request")',
        'div[role="dialog"] button:has-text("Unfollow")',
        'div[role="dialog"] button:has-text("Cancel request")',
        'div[role="menu"] button:has-text("Cancel request")',
      ];
      for (const sel of confirmSelectors) {
        const c = page.locator(sel).first();
        if (await c.isVisible().catch(() => false)) {
          await c.click().catch(() => {});
          break;
        }
      }

      await waitForFollowState(page, 5000);
      unfollowed += 1;
      await sleep(900 + Math.floor(Math.random() * 600));
    } catch {
      // ignore and continue
    }
  }
  return unfollowed;
}

async function getFollowingContext(page) {
  // Option A: dialog overlay
  const dialog = page.locator('div[role="dialog"]').first();
  if (await dialog.isVisible().catch(() => false)) {
    let scrollArea = dialog.locator('ul, div[style*="overflow"]').first();
    if (!await scrollArea.isVisible().catch(() => false)) scrollArea = dialog;
    return { container: dialog, scrollArea, type: 'dialog' };
  }
  // Option B: full page list
  const main = page.locator('main').first();
  const hasButtons = await page.locator('main button:has-text("Following")').count().catch(() => 0);
  if (hasButtons > 0) {
    return { container: main, scrollArea: page, type: 'page' };
  }
  return null;
}

async function navigateToFollowing(page, username) {
  // Try direct following URL first
  await page.goto(`${PROFILE_URL(username)}following/`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await dismissPopups(page);
  let ctx = await getFollowingContext(page);
  if (!ctx) {
    // Fallback: go to profile and click following count/link
    await page.goto(PROFILE_URL(username), { waitUntil: 'domcontentloaded' });
    await dismissPopups(page);
    const candidates = [
      `a[href='/${username}/following/']`,
      'a[role="link"]:has-text("Following")',
      'li:has-text("Following") a',
      'a[href$="/following/"]',
      'a:has-text("Following")'
    ];
    for (const sel of candidates) {
      const el = page.locator(sel).first();
      if (await el.isVisible().catch(() => false)) {
        await el.click().catch(() => {});
        break;
      }
    }
    await page.waitForTimeout(2000);
    ctx = await getFollowingContext(page);
  }
  if (!ctx) {
    throw new Error('Could not open Following list. UI selectors may have changed.');
  }
  return ctx;
}

async function navigateToFollowingWithTimeout(page, username, timeoutMs = 20000) {
  const start = Date.now();
  let lastError;
  while (Date.now() - start < timeoutMs) {
    try {
      const ctx = await navigateToFollowing(page, username);
      return ctx;
    } catch (e) {
      lastError = e;
      await sleep(1000);
    }
  }
  throw lastError || new Error('Timeout opening Following list');
}

async function unfollowFromList(page, context, maxCount) {
  // The dialog contains a scrollable list; each row has a button that says Following
  let unfollowed = 0;
  const { container, scrollArea, type } = context;

  // Helper to get visible following buttons
  async function getFollowingButtons() {
    const buttons = container.locator('button:has-text("Following"), button:has-text("Requested")');
    const total = await buttons.count();
    const items = [];
    for (let i = 0; i < total; i += 1) {
      items.push(buttons.nth(i));
    }
    return items;
  }

  // Scroll and attempt unfollow
  while (unfollowed < maxCount) {
    const buttons = await getFollowingButtons();
    if (buttons.length === 0) {
      // scroll to load more
      if (type === 'dialog') {
        await scrollArea.evaluate((el) => el.scrollBy(0, el.scrollHeight));
      } else {
        await page.evaluate(() => window.scrollBy(0, document.documentElement.clientHeight));
      }
      await sleep(1000);
      continue;
    }

    for (const btn of buttons) {
      if (unfollowed >= maxCount) break;
      // Ensure the button is attached and visible
      const visible = await btn.isVisible().catch(() => false);
      if (!visible) continue;

      await btn.click({ delay: 50 }).catch(() => {});
      // Confirm dialog appears with Unfollow or Cancel request
      const confirmSelectors = [
        'button:has-text("Unfollow")',
        'button:has-text("Cancel request")',
        'div[role="dialog"] button:has-text("Unfollow")',
        'div[role="dialog"] button:has-text("Cancel request")',
        'div[role="menu"] button:has-text("Cancel request")',
      ];
      for (const sel of confirmSelectors) {
        const c = page.locator(sel).first();
        if (await c.isVisible().catch(() => false)) {
          await c.click().catch(() => {});
          break;
        }
      }
      // Wait the button to change to Follow/Follow back state to avoid accidental re-follow clicks later
      await page.waitForTimeout(200);
      unfollowed += 1;
      // Small random delay to be human-like and avoid rate limits
      await sleep(800 + Math.floor(Math.random() * 500));
    }

    // Scroll a bit between batches
    if (type === 'dialog') {
      await scrollArea.evaluate((el) => el.scrollBy(0, el.clientHeight || 600));
    } else {
      await page.evaluate(() => window.scrollBy(0, document.documentElement.clientHeight));
    }
    await sleep(700);
  }

  return unfollowed;
}

let userDataDirGlobal;
async function tryLaunch(dir, profileDirName) {
    const args = [];
    if (profileDirName) args.push(`--profile-directory=${profileDirName}`);

    const baseOptions = {
      headless: false,
      viewport: null,
      args,
    };
    try {
      return await chromium.launchPersistentContext(dir, { channel: 'chrome', ...baseOptions });
    } catch (e) {
      // Retry with executablePath on macOS
      try {
        const macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
        return await chromium.launchPersistentContext(dir, { executablePath: macChrome, ...baseOptions });
      } catch (e2) {
        throw e2;
      }
    }
  }

async function launchWithFallbackPoolFactory(defaultDir, profileToUse) {
  return async function launchWithFallbackPool() {
    const errors = [];
    // First try main profile
    try {
      return await tryLaunch(defaultDir, profileToUse);
    } catch (e) {
      errors.push(e);
      const message = String(e?.message || e);
      if (!(message.includes('ProcessSingleton') || message.includes('profile directory') || message.includes('SingletonLock'))) {
        throw e;
      }
    }

    if (CHROME_CLOSE_EXISTING) {
      console.log('Chrome profile is locked. Closing existing Chrome and retrying...');
      try {
        await exec('pkill -x "Google Chrome" || true');
        await sleep(2000);
      } catch {}
      return tryLaunch(defaultDir, profileToUse);
    }

    if (!CHROME_ALLOW_TEMP) {
      throw new Error('Chrome profile is in use. Set CHROME_ALLOW_TEMP=true to use a dedicated profile for the automation, or CHROME_CLOSE_EXISTING=true to close running Chrome.');
    }

    // Build pool of persistent fallback dirs: base + numbered slots
    const dirs = [FALLBACK_USER_DATA_DIR];
    for (let i = 1; i <= CHROME_FALLBACK_SLOTS; i += 1) {
      dirs.push(`${FALLBACK_USER_DATA_DIR}-${i}`);
    }
    for (const dir of dirs) {
      try {
        if (!existsSync(dir)) await mkdir(dir, { recursive: true });
        // No explicit profile; let Chrome create Default inside
        const ctx = await tryLaunch(dir, undefined);
        console.log(`Using persistent automation profile: ${dir}`);
        userDataDirGlobal = dir;
        return ctx;
      } catch (e) {
        const msg = String(e?.message || e);
        if (msg.includes('ProcessSingleton') || msg.includes('profile directory') || msg.includes('SingletonLock')) {
          // locked; try next slot
          continue;
        }
        errors.push(e);
      }
    }
    // If all slots locked, final fallback: new unique temp dir for this run
    const timestamp = Date.now();
    const tempDir = path.join(FALLBACK_USER_DATA_DIR, `run-${timestamp}`);
    await mkdir(tempDir, { recursive: true });
    console.log(`All persistent profiles are busy; using temporary profile for this run: ${tempDir}`);
    userDataDirGlobal = tempDir;
    return tryLaunch(tempDir, undefined);
  };
}

async function run() {
  let userDataDir = `${DEFAULT_USER_DATA_DIR}`;
  let context;
  let launchWithFallbackPool;
  if (CHROME_CONNECT_OVER_CDP) {
    console.log(`Attaching to existing Chrome via CDP at ${CHROME_CDP_URL} ...`);
    try {
      launchWithFallbackPool = async () => {
        const browser = await chromium.connectOverCDP(CHROME_CDP_URL);
        const contexts = browser.contexts();
        const ctx = contexts[0] || await browser.newContext();
        if (!ctx) throw new Error('No default Chrome context found. Make sure Chrome is running with your profile.');
        return ctx;
      };
      context = await launchWithFallbackPool();
    } catch (err) {
      const message = String(err?.message || err);
      throw new Error(`Could not attach to existing Chrome at ${CHROME_CDP_URL}. Start Chrome with --remote-debugging-port=9222 and try again. Original error: ${message}`);
    }
  } else {
  // Choose a profile directory inside userDataDir if it exists; otherwise, let Chrome create one
  const candidateProfiles = Array.from(new Set([
    DEFAULT_PROFILE,
    'Default',
    'Profile 1',
    'Profile 2',
    'Profile 3',
    'Profile 4',
    'Profile 5',
  ]));
  let profileToUse = candidateProfiles.find((name) => existsSync(path.join(userDataDir, name)));

  launchWithFallbackPool = await launchWithFallbackPoolFactory(userDataDir, profileToUse);
  context = await launchWithFallbackPool();
  }
  let page = await context.newPage();

  // If attached over CDP and on macOS, move this tab into a separate window while keeping the same profile
  if (CHROME_CONNECT_OVER_CDP && process.platform === 'darwin') {
    try {
      const marker = `automation_${Date.now()}`;
      await page.goto(`${INSTAGRAM_URL}?${marker}`, { waitUntil: 'domcontentloaded' });
      const osa = `
        tell application "Google Chrome"
          set targetUrl to "${marker}"
          set foundTab to missing value
          set foundWindow to missing value
          repeat with w in every window
            repeat with t in every tab of w
              try
                if (URL of t contains targetUrl) then
                  set foundTab to t
                  set foundWindow to w
                  exit repeat
                end if
              end try
            end repeat
            if foundTab is not missing value then exit repeat
          end repeat
          if foundTab is not missing value then
            set newWindow to make new window
            move foundTab to newWindow
            set active tab index of newWindow to 1
            set index of newWindow to 1
            activate
          end if
        end tell`;
      await exec(`osascript -e '${osa.replace(/'/g, "'\\''")}'`).catch(() => {});
    } catch {}
  }

  await ensureLoggedIn(page);

  // Resolve logged-in username robustly
  let username = await resolveUsername(page);

  if (!username) {
    console.log('Could not determine username automatically. Set IG_USERNAME in .env.');
  }

  let unfollowedToday = 0;
  const startOfDay = () => new Date().toDateString();
  let currentDay = startOfDay();

  console.log(`Automation started. Unfollowing up to ${UNFOLLOW_PER_CYCLE} per ${CYCLE_MINUTES} minutes. Window will stay open.`);
  console.log(`Target account (Following) will be: ${username || '(unknown yet)'}`);

  // Global guards to avoid unexpected exits that could close the automation Chrome
  process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    // Don't exit, just log and continue
  });
  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection:', reason);
    // Don't exit, just log and continue
  });

  // Keep the process alive even if Chrome closes
  process.on('SIGINT', async () => {
    console.log('Received SIGINT, shutting down gracefully...');
    try {
      if (context) await context.close();
    } catch {}
    process.exit(0);
  });
  process.on('SIGTERM', async (signal) => {
    console.log(`Received ${signal}, but ignoring to keep automation running...`);
    // Don't exit, just log and continue
  });
  process.on('SIGHUP', async (signal) => {
    console.log(`Received ${signal}, but ignoring to keep automation running...`);
    // Don't exit, just log and continue
  });

  // Resilience: if the page or browser closes unexpectedly, reopen and continue
  let relaunching = false;
  async function relaunchBrowser() {
    if (relaunching) return;
    relaunching = true;
    try {
      console.log('Browser/page closed unexpectedly. Relaunching automation browser...');
      if (context) {
        try {
          await context.close();
        } catch {}
      }
      context = await launchWithFallbackPool();
      page = await context.newPage();
      await ensureLoggedIn(page);
      console.log('Relaunch successful. Continuing cycles.');
    } catch (e) {
      console.error('Relaunch failed:', e?.message || e);
      // Try again in 30 seconds
      setTimeout(() => {
        relaunching = false;
        relaunchBrowser();
      }, 30000);
    } finally {
      relaunching = false;
    }
  }

  // Monitor context and page for unexpected closures
  if (context) {
    context.on('close', () => {
      console.log('Chrome context closed unexpectedly');
      setTimeout(relaunchBrowser, 5000);
    });
  }
  if (page) {
    page.on('close', () => {
      console.log('Page closed unexpectedly');
      setTimeout(relaunchBrowser, 5000);
    });
  }

  // Scheduling helpers
  function getNextScheduledDate(fromDate) {
    const now = new Date(fromDate.getTime());
    if (!RUN_AT_HOURS.length) {
      // Fallback: fixed interval
      return new Date(now.getTime() + CYCLE_MINUTES * 60 * 1000);
    }
    const hours = [...new Set(RUN_AT_HOURS)].sort((a, b) => a - b);
    // Try today
    for (const h of hours) {
      const candidate = new Date(now);
      candidate.setHours(h, RUN_AT_MINUTE, RUN_AT_SECOND, 0);
      if (candidate > now) return candidate;
    }
    // Otherwise pick the first hour tomorrow
    const candidate = new Date(now);
    candidate.setDate(candidate.getDate() + 1);
    candidate.setHours(hours[0], RUN_AT_MINUTE, RUN_AT_SECOND, 0);
    return candidate;
  }

  // Initial wait to align to clock if schedule is defined
  if (RUN_AT_HOURS.length) {
    const firstAt = getNextScheduledDate(new Date());
    const ms = Math.max(0, firstAt.getTime() - Date.now());
    console.log(`Waiting until first scheduled run at ${firstAt.toLocaleString()} before starting.`);
    await sleep(ms);
  } else {
    // If no specific hours set, run at clock hours (1pm, 2pm, 3pm, etc.)
    console.log('No specific schedule set. Will run at clock hours (1:00 PM, 2:00 PM, 3:00 PM, etc.)');
  }

  // Keep process alive and run on schedule
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      if (!username) {
        username = await resolveUsername(page);
        if (username) console.log(`Resolved username: ${username}`);
      }
      // Reset daily counter at day change
      const nowDay = startOfDay();
      if (nowDay !== currentDay) {
        unfollowedToday = 0;
        currentDay = nowDay;
      }

      if (!username) {
        console.log('Username still unknown; skipping this cycle.');
      } else if (unfollowedToday >= MAX_UNFOLLOW_PER_DAY) {
        console.log(`Reached daily cap (${MAX_UNFOLLOW_PER_DAY}). Waiting until next day.`);
      } else if (username) {
        let done = 0;
        const allowed = Math.min(UNFOLLOW_PER_CYCLE, MAX_UNFOLLOW_PER_DAY - unfollowedToday);
        console.log(`\n=== Starting unfollow cycle ===`);
        console.log(`Target: ${allowed} accounts to unfollow`);
        console.log(`Already unfollowed today: ${unfollowedToday}`);
        
        try {
          console.log(`Attempting to open Following list for ${username}...`);
          const ctx = await navigateToFollowingWithTimeout(page, username, 15000);
          console.log('Following list opened successfully, starting unfollow process...');
          done = await unfollowFromList(page, ctx, allowed);
          console.log(`Unfollowed ${done} accounts via Following list UI.`);
        } catch (e) {
          console.log(`Following list UI failed: ${e.message}`);
          console.log('Falling back to API method...');
          try {
            const users = await fetchFollowingUsers(page, allowed + 20);
            console.log(`API fetched ${users.length} users from your Following.`);
            if (users.length > 0) {
              done = await unfollowByVisitingProfiles(page, users, allowed);
              console.log(`Unfollowed ${done} accounts via profile visits.`);
            } else {
              console.log('No users found via API. Checking if logged in...');
              const isLoggedIn = await isLoggedIn(page);
              if (!isLoggedIn) {
                console.log('Not logged in. Please log in to Instagram in the Chrome window.');
                await ensureLoggedIn(page);
              } else {
                console.log('Logged in but API returned 0 users. Instagram may have changed their API.');
              }
            }
          } catch (apiError) {
            console.error('API fallback also failed:', apiError.message);
          }
        }
        
        unfollowedToday += done;
        console.log(`\n=== Cycle complete ===`);
        console.log(`Unfollowed this cycle: ${done}`);
        console.log(`Total unfollowed today: ${unfollowedToday}`);
        console.log(`Daily cap: ${MAX_UNFOLLOW_PER_DAY}`);
      }
    } catch (err) {
      console.error('Cycle error:', err?.message || err);
      console.log('Waiting 5 minutes before retrying...');
      await sleep(5 * 60 * 1000);
      continue;
    }

    // Determine next run time
    let nextAt, sleepMs, nextStr;
    if (RUN_AT_HOURS.length) {
      nextAt = getNextScheduledDate(new Date());
      sleepMs = Math.max(0, nextAt.getTime() - Date.now());
      nextStr = nextAt.toLocaleString();
      console.log(`Next scheduled run at ${nextStr}`);
    } else {
      // Default: run at clock hours (1:00 PM, 2:00 PM, 3:00 PM, etc.)
      const now = new Date();
      const currentHour = now.getHours();
      const nextHour = currentHour + 1;
      nextAt = new Date(now);
      nextAt.setHours(nextHour, 0, 0, 0); // Set to next hour at 00:00
      sleepMs = Math.max(0, nextAt.getTime() - now.getTime());
      nextStr = nextAt.toLocaleString();
      console.log(`Next run at ${nextStr} (clock hour)`);
    }
    
    console.log(`Sleeping for ${Math.round(sleepMs / 1000 / 60)} minutes...`);
    await sleep(sleepMs);
  }
}

run().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

