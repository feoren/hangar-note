// Renders the README screenshots into docs/images from the real frontend with a mocked backend
// (mock.ts) in a headless Chromium based browser: one image per scene and color scheme, e.g.
// hangar-note-dark.png (the overview) and hangar-note-sticky-light.png. Modeled on Hangar's
// tools/readme-shots (MIT, same owner).
//
// Usage: pnpm readme:shots [--scene <name>]...   (default: every scene)
//
// Starts its own Vite server on a free port, never touches a running Hangar Note, and keeps all
// temporary files (browser profile, Vite cache) under tests/.tmp/readme-shots, which it removes at
// the end. A scene that gets stuck leaves the page as it stood in
// tests/.tmp/readme-shots-failed-<scene>.png.
import react from "@vitejs/plugin-react";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import path from "node:path";
import { createServer } from "vite";

import { findBrowser, launchBrowser, sleep, waitFor } from "./browser.mjs";
import { optimizePng, pngSize } from "./png.mjs";

const HERE = import.meta.dirname;
const REPO = path.resolve(HERE, "../..");
const WORK = path.join(REPO, "tests/.tmp/readme-shots");
const OUT_DIR = path.join(REPO, "docs/images");

const WIDTH = 1296;
const HEIGHT = 839;
const KB = 1024;
const SCHEMES = ["dark", "light"];
const TITLE = "README-SHOTS-HARNESS";
/** The sticky notes' choice of line numbers (src/stickyLineNumbers.ts). */
const LINE_NUMBERS_KEY = "hangar-note.sticky.lineNumbers";

/**
 * The document the app runs in: the page itself, or the sticky note's frame in sticky.html. Every
 * expression below reads the app through it.
 */
const DOC = `(document.querySelector("iframe")?.contentDocument ?? document)`;

/** Clicks the first element matching `selector` whose text contains `text` (if given). */
const click = (selector, text = null) => `(() => {
  const all = [...${DOC}.querySelectorAll(${JSON.stringify(selector)})];
  const target = all.find((el) => ${JSON.stringify(text)} === null || el.textContent.includes(${JSON.stringify(text)}));
  if (!target) throw new Error("Nothing to click: " + ${JSON.stringify(`${selector} ${text ?? ""}`)});
  target.click();
  return true;
})()`;

/** True once an element matching `selector` exists whose text contains `text` (if given). */
const shows = (selector, text = null) => `(() => {
  const all = [...${DOC}.querySelectorAll(${JSON.stringify(selector)})];
  return all.some((el) => ${JSON.stringify(text)} === null || el.textContent.includes(${JSON.stringify(text)}));
})()`;

/** True once at least `count` elements match `selector`. */
const count = (selector, at) =>
  `(${DOC}.querySelectorAll(${JSON.stringify(selector)}).length >= ${at})`;

/** Takes the focus away from where a click left it, so no focus ring shows. */
const BLUR = `(() => {
  const active = ${DOC}.activeElement;
  if (active instanceof HTMLElement || active?.blur) active.blur();
  return true;
})()`;

/** Opens the note titled `title` from the list and waits for its text in the editor. */
const openNote = (title) => [
  { run: click(".note-row", title), ready: shows(".hangar-title", title) },
  { ready: shows(".note-body .cm-content", title) },
  { run: BLUR, ready: "true" },
];

/** The main window is up: the sidebar with the version, and the first list of notes. */
const HUB_BOOT = `(() => {
  const doc = ${DOC};
  return (
    doc.querySelector(".nav .brand-version") !== null &&
    doc.querySelectorAll(".note-row, .paper-card, .card").length > 0
  );
})()`;

/** The sticky note is up with its text. */
const STICKY_BOOT = `(() => {
  const doc = ${DOC};
  return doc.querySelector(".note .cm-content")?.textContent.includes("Trip to the coast") === true;
})()`;

/**
 * The scenes, in README order. `file`: the image name without scheme; `maxBytes`: the size limit
 * of one image; `page`: the harness page to load (default index.html, the main window); `look`:
 * the look the settings name (mock.ts reads it); `storage`: more localStorage entries before the
 * app starts; `boot`: what must show for the app to count as started; `steps`: what to run once
 * the app is up, each followed by what must show before the next; `keys`: keys pressed into the
 * focused element at the end (CDP key names); `hover`: the element the pointer rests on for the
 * screenshot (default: none, the pointer leaves the window); `closeUp`: the element whose left edge
 * starts a close-up, the window from there to its right edge enlarged to the full image (default:
 * the whole window). The mock reads the scene's name too (mock.ts `SCENE`).
 */
const SCENES = [
  {
    // The hero: the Hangar look with the sidebar (levels, All notes, the project folders, the
    // colors), the dense list in the "Private" level and the release checklist open beside it in
    // its color, with its progress and the orange accent on the chosen row.
    name: "overview",
    file: "hangar-note",
    maxBytes: 300 * KB,
    look: "hangar",
    steps: [{ ready: count(".note-row", 7) }, ...openNote("Release checklist")],
  },
  {
    // Hangar Drive keeps the notes on the person's server: "All notes" lists every note with the
    // quiet cloud mark, and the open note's status line says "On your server".
    name: "drive",
    file: "hangar-note-drive",
    maxBytes: 300 * KB,
    look: "hangar",
    steps: [
      { ready: count(".note-row", 7) },
      { run: click(".nav-item", "All notes"), ready: count(".note-row", 12) },
      { ready: count(".note-row-synced", 10) },
      ...openNote("Deploy steps"),
      { ready: shows(".cursor-synced", "On your server") },
    ],
  },
  {
    // A sticky note on the desktop with its line numbers on: the switch at the start of its status
    // line, the cursor in the text and the formatting bar shown while it is being written.
    name: "sticky",
    file: "hangar-note-sticky",
    maxBytes: 300 * KB,
    page: "sticky.html",
    look: "hangar",
    storage: { [LINE_NUMBERS_KEY]: "1" },
    boot: STICKY_BOOT,
    steps: [
      { ready: `(${shows(".cm-lineNumbers")} && ${shows('.footer-switch[aria-checked="true"]')})` },
      {
        run: `(() => { ${DOC}.querySelector(".note .cm-content").focus(); return true; })()`,
        ready: shows(".format-bar"),
      },
    ],
    // From the end of the text (where the cursor starts) onto the end of "Pack the rain jacket".
    keys: ["ArrowUp", "End"],
    ready: shows(".cursor-position", "Ln 4"),
  },
  {
    // The Paper look: the notes as cards on a table, each in its color with its first lines.
    name: "paper",
    file: "hangar-note-paper",
    maxBytes: 300 * KB,
    look: "paper",
    steps: [{ ready: count(".note-row, .paper-card, .card", 7) }, { run: BLUR, ready: "true" }],
  },
  {
    // The look switch at the top right of the note, close up: the note's column of the window
    // drawn larger, Hangar chosen and focused from the keyboard, the pointer resting on Paper.
    name: "look-switch",
    file: "hangar-note-look-switch",
    maxBytes: 300 * KB,
    look: "hangar",
    steps: [
      { ready: count(".note-row", 7) },
      ...openNote("API ideas"),
      {
        run: `(() => { ${DOC}.querySelector('.hangar-head .look-option[aria-checked="true"]').focus(); return true; })()`,
        ready: `(${DOC}.activeElement?.classList.contains("look-option") === true)`,
      },
    ],
    hover: { selector: '.hangar-head .look-option[data-look="paper"]', index: 0 },
    closeUp: ".hangar-editor",
  },
  {
    // The settings with the Hangar Drive section: its status sentence and when it last synced.
    name: "settings",
    file: "hangar-note-settings",
    maxBytes: 300 * KB,
    look: "hangar",
    steps: [
      { ready: count(".note-row", 7) },
      {
        run: click('.nav-foot-button[data-focus-id="settings"]'),
        ready: shows(".drive-status-text", "synced with Hangar Drive"),
      },
      {
        run: `(() => { ${DOC}.querySelector(".drive-sync").scrollIntoView({ block: "end" }); return true; })()`,
        ready: "true",
      },
      { run: BLUR, ready: "true" },
    ],
  },
  {
    // The "Project" level for a project folder chosen in the sidebar: atlas-web marked under
    // "Project folders", the level's tab named after it and its deploy steps open.
    name: "projects",
    file: "hangar-note-projects",
    maxBytes: 300 * KB,
    look: "hangar",
    steps: [
      { ready: count(".note-row", 7) },
      {
        run: click(".nav-item", "atlas-web"),
        ready: `(${shows('.nav-item[aria-current="page"]', "atlas-web")} && ${shows(".note-row", "Bug triage")})`,
      },
      ...openNote("Deploy steps"),
    ],
  },
];

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function startVite() {
  const port = await freePort();
  const server = await createServer({
    configFile: false,
    root: HERE,
    plugins: [react()],
    cacheDir: path.join(WORK, "vite-cache"),
    clearScreen: false,
    logLevel: "warn",
    server: {
      host: "127.0.0.1",
      port,
      strictPort: true,
      hmr: false,
      watch: null,
      fs: { allow: [REPO] },
    },
  });
  await server.listen();
  return { server, url: `http://127.0.0.1:${port}/` };
}

/**
 * Stops every CSS animation on a fixed frame, in the page and in the sticky note's frame: finite
 * ones (a menu opening) at their end, endless ones (the caret) halfway through their cycle.
 */
const FREEZE_ANIMATIONS = `(() => {
  const docs = [document, document.querySelector("iframe")?.contentDocument].filter(Boolean);
  for (const doc of docs) {
    for (const animation of doc.getAnimations()) {
      const timing = animation.effect?.getComputedTiming();
      const duration = typeof timing?.duration === "number" ? timing.duration : 0;
      if (timing?.iterations !== Infinity) {
        animation.finish();
        continue;
      }
      animation.pause();
      animation.currentTime = duration * 0.5;
    }
  }
  return true;
})()`;

/** The version in the sidebar header must stand whole, not cut off with an ellipsis. */
const VERSION_CUT = `(() => {
  const element = ${DOC}.querySelector(".brand-version");
  return element === null ? 0 : element.scrollWidth - element.clientWidth;
})()`;

/**
 * The part of the window from the left edge of `selector` to the window's right edge, in the
 * window's proportions and enlarged to the full image size, so a small control reads well.
 */
async function closeUp(page, selector) {
  const left = await page.evaluate(
    `(${DOC}.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect().left ?? null)`,
  );
  if (left === null) throw new Error(`No ${selector} for the close-up.`);
  const width = WIDTH - Math.round(left);
  const scale = WIDTH / width;
  return { x: WIDTH - width, y: 0, width, height: HEIGHT / scale, scale };
}

/** Presses one key into whatever has the focus (CDP key names such as "ArrowDown"). */
async function press(page, key) {
  const codes = { ArrowDown: 40, ArrowUp: 38, End: 35, Home: 36 };
  const base = { key, code: key, windowsVirtualKeyCode: codes[key] ?? 0 };
  await page.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  await sleep(80);
}

/** Loads one scene in one color scheme and returns the raw screenshot. */
async function render(page, url, scene, scheme) {
  await page.send("Emulation.setDeviceMetricsOverride", {
    width: WIDTH,
    height: HEIGHT,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await page.send("Emulation.setTimezoneOverride", { timezoneId: "UTC" }).catch(() => undefined);
  await page.send("Emulation.setLocaleOverride", { locale: "en-US" }).catch(() => undefined);
  await page.send("Emulation.setEmulatedMedia", {
    features: [
      { name: "prefers-color-scheme", value: scheme },
      { name: "prefers-reduced-motion", value: "no-preference" },
    ],
  });

  // First load only to reach the origin's storage, then start the app with the scene's choices.
  await page.goto(url);
  if ((await page.evaluate("document.title")) !== TITLE) {
    throw new Error(`${url} does not serve the screenshot harness.`);
  }
  const storage = {
    "readmeShots.scene": JSON.stringify(scene.name),
    "readmeShots.look": JSON.stringify(scene.look ?? "hangar"),
    ...scene.storage,
  };
  await page.evaluate(`(() => {
    localStorage.clear();
    for (const [key, value] of Object.entries(${JSON.stringify(storage)})) localStorage.setItem(key, value);
    return true;
  })()`);
  await page.goto(new URL(scene.page ?? "index.html", url).href);

  await waitFor(() => page.evaluate(scene.boot ?? HUB_BOOT), { what: "the started app" });
  await page.evaluate(`${DOC}.fonts.ready.then(() => true)`);
  const cut = await page.evaluate(VERSION_CUT);
  if (cut > 0) throw new Error(`The version is cut off in the sidebar header by ${cut} px.`);
  for (const [index, step] of scene.steps.entries()) {
    if (step.run) await page.evaluate(step.run);
    await waitFor(() => page.evaluate(step.ready), {
      timeout: step.timeout ?? 20_000,
      what: `step ${index + 1} of the scene ${scene.name}`,
    });
  }
  for (const key of scene.keys ?? []) await press(page, key);
  if (scene.ready) {
    await waitFor(() => page.evaluate(scene.ready), { what: `the end of the scene ${scene.name}` });
  }
  // Let the editor settle, then move the pointer away (or onto the scene's element), stop the
  // clock and freeze every animation on a fixed frame.
  await sleep(600);
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: WIDTH - 2, y: HEIGHT - 2 });
  if (scene.hover) {
    const { selector, index } = scene.hover;
    const point = await page.evaluate(`(() => {
      const target = ${DOC}.querySelectorAll(${JSON.stringify(selector)})[${index}];
      if (!target) return null;
      const box = target.getBoundingClientRect();
      return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
    })()`);
    if (point === null) throw new Error(`Nothing to point at: ${selector} #${index}`);
    await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
  }
  const frozen = `(() => {
    for (const win of [window, document.querySelector("iframe")?.contentWindow].filter(Boolean)) {
      if (win.__readmeShots) win.__readmeShots.freeze = true;
    }
    return true;
  })()`;
  await page.evaluate(frozen);
  await sleep(400);
  await page.evaluate(FREEZE_ANIMATIONS);
  await sleep(200);
  return page.screenshot(scene.closeUp ? await closeUp(page, scene.closeUp) : undefined);
}

/** Scene names from `--scene a --scene b` or `--scene a,b`; every scene without the option. */
function chosenScenes(argv) {
  const names = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--scene") names.push(...(argv[(i += 1)] ?? "").split(","));
    else if (arg.startsWith("--scene=")) names.push(...arg.slice(8).split(","));
    else throw new Error(`Unknown argument ${arg}. Usage: run.mjs [--scene <name>]...`);
  }
  if (names.length === 0) return SCENES;
  const known = SCENES.map((scene) => scene.name);
  const unknown = names.filter((name) => !known.includes(name));
  if (unknown.length > 0) {
    throw new Error(`Unknown scene ${unknown.join(", ")}. Known: ${known.join(", ")}.`);
  }
  return SCENES.filter((scene) => names.includes(scene.name));
}

function removeWork() {
  try {
    rmSync(WORK, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch (error) {
    console.warn(`Could not remove ${WORK}: ${error instanceof Error ? error.message : error}`);
  }
}

async function main() {
  const scenes = chosenScenes(process.argv.slice(2));
  const { version } = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8"));
  const browserPath = findBrowser();
  rmSync(WORK, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  mkdirSync(WORK, { recursive: true });
  mkdirSync(OUT_DIR, { recursive: true });

  let vite = null;
  let page = null;
  try {
    vite = await startVite();
    console.log(`Vite ${vite.url}, browser ${browserPath}, version ${version}`);
    page = await launchBrowser(browserPath, path.join(WORK, "profile"));
    for (const scene of scenes) {
      for (const scheme of SCHEMES) {
        const raw = await render(page, vite.url, scene, scheme).catch(async (error) => {
          // What the page showed when the scene got stuck, kept next to the work folder.
          const failed = path.join(REPO, `tests/.tmp/readme-shots-failed-${scene.name}.png`);
          await page
            .screenshot()
            .then((shot) => writeFileSync(failed, shot))
            .then(() => console.error(`The page as it stood: ${path.relative(REPO, failed)}`))
            .catch(() => undefined);
          throw error;
        });
        const optimized = optimizePng(raw);
        const { width, height } = pngSize(optimized);
        const name = `${scene.file}-${scheme}.png`;
        if (width !== WIDTH || height !== HEIGHT) {
          throw new Error(`${name}: got ${width} x ${height}, expected ${WIDTH} x ${HEIGHT}.`);
        }
        if (optimized.length > scene.maxBytes) {
          throw new Error(
            `${name}: ${optimized.length} bytes, more than the ${scene.maxBytes} allowed.`,
          );
        }
        const target = path.join(OUT_DIR, name);
        writeFileSync(target, optimized);
        console.log(
          `${path.relative(REPO, target)}: ${width} x ${height}, ${Math.round(optimized.length / KB)} KB` +
            ` (raw ${Math.round(raw.length / KB)} KB)`,
        );
      }
    }
    const problems = page.logs.filter((line) => /^(error|exception)|unmocked/i.test(line));
    if (problems.length > 0) console.warn(`Page reported:\n  ${problems.join("\n  ")}`);
  } finally {
    await page?.close().catch(() => undefined);
    await vite?.server.close().catch(() => undefined);
    removeWork();
  }
}

main().catch((error) => {
  console.error(`readme-shots: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
