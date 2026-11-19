import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  appendFileSync,
  unlinkSync,
  renameSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const skillRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repoRoot = resolve(skillRoot, "../../..");
const instancePath = resolve(skillRoot, "run/instance.json");
const languageBackupPath = resolve(skillRoot, "run/language-backup.json");
const audioBackupPath = resolve(skillRoot, "run/audio-chunk-backup.json");
const targetPath = resolve(skillRoot, "run/target.json");
const namesPath = resolve(skillRoot, "features/names.json");
const audioTarget = resolve(
  process.env.APPDATA ?? "",
  "io.github.aynls.lectavia/audio-chunk-seconds",
);
const cdpBase = "http://127.0.0.1:9222";
const workspaceUrl = "http://127.0.0.1:1420/";

const locales = new Set(["zh-CN", "en", "ja"]);

const storageAllow = new Set([
  "lectavia.language",
  "lectavia.output-directory",
  "lectavia.instruction-presets.v1",
]);

const argv = process.argv.slice(2);
const command = argv[0];

function flag(name) {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  return argv[index + 1];
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function logResult(summary) {
  const logPath = flag("--log");
  if (!logPath) return;
  const feature = flag("--feature") ?? "";
  const line = `${new Date().toISOString()}\t${feature}\t${argv.join(" ")}\t${summary}\n`;
  mkdirSync(dirname(resolve(logPath)), { recursive: true });
  appendFileSync(resolve(logPath), line, "utf8");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
}

function readInstance() {
  if (!existsSync(instancePath)) {
    fail(
      "not our instance: missing run/instance.json. Launch with scripts/launch.ps1.",
    );
  }
  return readJson(instancePath);
}

function notReady(message) {
  throw Object.assign(new Error(`not-ready: ${message}`), { exitCode: 2 });
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.next = 0;
    this.pending = new Map();
    ws.addEventListener("message", (event) => {
      void this.#onMessage(event);
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolveOpen, rejectOpen) => {
      const timer = setTimeout(
        () => rejectOpen(new Error("CDP websocket timed out")),
        5000,
      );
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolveOpen();
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        rejectOpen(new Error("CDP websocket failed"));
      });
    });
    return new Cdp(ws);
  }

  async #onMessage(event) {
    const text =
      typeof event.data === "string" ? event.data : await event.data.text();
    const message = JSON.parse(text);
    if (!message.id || !this.pending.has(message.id)) return;
    const { resolveCall, rejectCall } = this.pending.get(message.id);
    this.pending.delete(message.id);
    if (message.error) rejectCall(new Error(message.error.message));
    else resolveCall(message.result);
  }

  send(method, params = {}, timeout = 10000) {
    const id = ++this.next;
    return new Promise((resolveCall, rejectCall) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectCall(new Error(`${method} timed out`));
      }, timeout);
      this.pending.set(id, {
        resolveCall: (value) => {
          clearTimeout(timer);
          resolveCall(value);
        },
        rejectCall: (error) => {
          clearTimeout(timer);
          rejectCall(error);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.ws.close();
  }
}

function axValue(field) {
  if (!field) return "";
  if (typeof field === "string") return field;
  return String(field.value ?? "");
}

async function pageTarget() {
  let response;
  try {
    response = await fetch(`${cdpBase}/json/list`, {
      signal: AbortSignal.timeout(5000),
    });
  } catch (error) {
    notReady(error.message);
  }
  if (!response.ok) throw new Error(`CDP list returned ${response.status}`);
  const pages = await response.json();
  const matches = pages.filter(
    (page) => page.type === "page" && page.url === workspaceUrl,
  );
  if (matches.length === 0) notReady("no Lectavia workspace target");
  if (matches.length > 1) {
    fail(`expected one Lectavia page, found ${matches.length}`);
  }
  return matches[0];
}

async function withPage(run) {
  const instance = readInstance();
  const root = instance.processes.find((item) => item.pid === instance.pid);
  if (!root || !Number.isSafeInteger(root.pid) || !/^\d+$/.test(root.created)) {
    throw new Error("invalid launch process record");
  }
  const binding = command === "doctor" && argv.includes("--bind");
  const pinned = existsSync(targetPath) ? readJson(targetPath) : null;
  if (!pinned && !binding)
    throw new Error("launch has not bound a verification window");
  const page = await pageTarget();
  if (pinned && page.id !== pinned.id)
    throw new Error("verification window has changed");
  const cdp = await Cdp.connect(
    `ws://127.0.0.1:9222/devtools/page/${encodeURIComponent(page.id)}`,
  );
  try {
    const owner = JSON.parse(
      execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          resolve(skillRoot, "scripts/verify-owner.ps1"),
          "-RootPid",
          String(root.pid),
          "-RootCreated",
          root.created,
          "-RunId",
          instance.runId,
        ],
        {
          windowsHide: true,
          timeout: 30000,
          encoding: "utf8",
        },
      ),
    );
    if (
      pinned &&
      (owner.pid !== pinned.browser.pid ||
        owner.created !== pinned.browser.created)
    ) {
      throw new Error("verification browser has changed");
    }
    const facts = await pageFacts(cdp);
    if (binding && !facts.ready && !facts.brand)
      notReady("desktop document is loading");
    if (
      facts.url !== workspaceUrl ||
      !facts.desktop ||
      facts.browserNotice ||
      facts.title !== "Lectavia"
    ) {
      throw new Error("target is not the Lectavia desktop workspace");
    }
    if (!facts.brand) notReady("desktop interface is loading");
    if (!pinned)
      writeFileSync(
        targetPath,
        JSON.stringify({ id: page.id, browser: owner }),
        { flag: "wx" },
      );
    await cdp.send("Runtime.enable");
    await cdp.send("DOM.enable");
    await cdp.send("DOM.getDocument");
    await cdp.send("Accessibility.enable");
    await cdp.send("Page.enable");
    return await run(cdp, page, facts);
  } finally {
    cdp.close();
  }
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    const text =
      result.exceptionDetails.exception?.description ??
      result.exceptionDetails.text;
    throw new Error(text);
  }
  return result.result.value;
}

async function pageFacts(cdp) {
  return evaluate(
    cdp,
    `({
      url: location.href,
      ready: document.readyState === "complete",
      lang: document.documentElement.lang,
      title: document.title,
      desktop: typeof window.__TAURI_INTERNALS__ === "object",
      browserNotice: [
        "请在 Lectavia 桌面应用中处理视频。",
        "Use the Lectavia desktop app to process videos.",
        "動画の処理には Lectavia デスクトップアプリを使用してください。"
      ].some((text) => document.body?.innerText.includes(text)),
      brand: Boolean(document.querySelector("h1"))
    })`,
  );
}

async function axTree(cdp) {
  const { nodes } = await cdp.send("Accessibility.getFullAXTree");
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  return { nodes, byId };
}

function named(node) {
  return {
    role: axValue(node.role),
    name: axValue(node.name).replace(/\s+/g, " ").trim(),
    node,
  };
}

function ancestors(node, byId) {
  const chain = [];
  let current = node;
  const seen = new Set();
  while (current?.parentId && !seen.has(current.parentId)) {
    seen.add(current.parentId);
    current = byId.get(current.parentId);
    if (!current) break;
    chain.push(current);
  }
  return chain;
}

function matches(entry, { role, name, contains, within }, byId) {
  if (role && entry.role !== role) return false;
  if (name !== undefined && entry.name !== name) return false;
  if (contains !== undefined && !entry.name.includes(contains)) return false;
  if (!within) return true;
  return ancestors(entry.node, byId).some(
    (parent) => axValue(parent.name).replace(/\s+/g, " ").trim() === within,
  );
}

async function findNodes(cdp, spec) {
  const { nodes, byId } = await axTree(cdp);
  return nodes
    .filter((node) => !node.ignored)
    .map(named)
    .filter((entry) => entry.name || spec.role)
    .filter((entry) => matches(entry, spec, byId));
}

async function requireOne(cdp, spec) {
  const found = await findNodes(cdp, spec);
  if (found.length === 0) {
    const { nodes } = await axTree(cdp);
    const nearby = nodes
      .filter((node) => !node.ignored)
      .map(named)
      .filter((entry) => entry.name && (!spec.role || entry.role === spec.role))
      .slice(0, 12)
      .map((entry) => `${entry.role} ${JSON.stringify(entry.name)}`)
      .join("; ");
    throw new Error(
      `no ${spec.role ?? "node"} ${spec.contains !== undefined ? "containing" : "named"} ${JSON.stringify(spec.name ?? spec.contains)}` +
        (spec.within ? ` within ${JSON.stringify(spec.within)}` : "") +
        (nearby ? `. Nearby: ${nearby}` : ""),
    );
  }
  if (found.length > 1) {
    throw new Error(
      `found ${found.length} ${spec.role ?? "nodes"} ${spec.contains !== undefined ? "containing" : "named"} ${JSON.stringify(spec.name ?? spec.contains)}`,
    );
  }
  return found[0];
}

async function objectIdFor(cdp, node) {
  const resolved = await cdp.send("DOM.resolveNode", {
    backendNodeId: node.backendDOMNodeId,
  });
  return resolved.object.objectId;
}

async function callOn(cdp, objectId, fn, args = []) {
  const result = await cdp.send("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: fn,
    arguments: args,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text,
    );
  }
  return result.result.value;
}

function nameSpec(required = true) {
  const name = flag("--name");
  const contains = flag("--name-contains");
  if (name !== undefined && contains !== undefined)
    fail("use --name or --name-contains, not both");
  if (required && name === undefined && contains === undefined)
    fail("missing accessible name");
  return { name, contains };
}

async function doctor() {
  const instance = readInstance();
  await withPage(async (_cdp, page, facts) => {
    const version = JSON.parse(
      readFileSync(resolve(repoRoot, "package.json"), "utf8"),
    ).version;
    const report = [
      "ok",
      `pid: ${instance.pid}`,
      `url: ${page.url}`,
      `version: ${version}`,
      `lang: ${facts.lang}`,
      "desktop: true",
      "profile: shared",
      "config: shared",
      "credentials: shared",
    ];
    console.log(report.join("\n"));
    logResult("ok");
  });
}

async function lang(cdp) {
  return evaluate(cdp, "document.documentElement.lang");
}

async function readStorage(cdp, key) {
  if (!storageAllow.has(key)) fail(`storage key is not allowed: ${key}`);
  const value = await evaluate(
    cdp,
    `localStorage.getItem(${JSON.stringify(key)})`,
  );
  return value;
}

async function writeStorage(cdp, key, value) {
  if (key !== "lectavia.language") {
    fail("only lectavia.language may be written");
  }
  if (!locales.has(value)) fail(`unsupported locale ${value}`);
  if (!existsSync(languageBackupPath))
    throw new Error("back up the language before changing it");
  await evaluate(
    cdp,
    `localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)})`,
  );
}

async function removeStorage(cdp, key) {
  if (key !== "lectavia.language") {
    fail("only lectavia.language may be removed");
  }
  if (!existsSync(languageBackupPath))
    throw new Error("back up the language before changing it");
  await evaluate(cdp, `localStorage.removeItem(${JSON.stringify(key)})`);
}

function writeOut(text) {
  const out = flag("--out");
  if (!out) return;
  const path = resolve(out);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text.endsWith("\n") ? text : `${text}\n`, "utf8");
}

async function click(cdp) {
  const role = flag("--role") ?? "button";
  const { name, contains } = nameSpec();
  const within = flag("--within");
  const entry = await requireOne(cdp, { role, name, contains, within });
  const objectId = await objectIdFor(cdp, entry.node);
  const form = await callOn(
    cdp,
    objectId,
    `function () { return this.closest("form")?.getAttribute("aria-labelledby"); }`,
  );
  if (form === "audio-chunk-seconds-label" && !existsSync(audioBackupPath))
    throw new Error("back up the audio chunk setting before saving");
  if (form === "model-settings-title")
    throw new Error("model settings are outside the verification scope");
  const point = await callOn(
    cdp,
    objectId,
    `function () {
    if (this.matches(":disabled") || this.closest('[inert], [aria-disabled="true"]')) {
      throw new Error("control is disabled");
    }
    this.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    const rect = this.getBoundingClientRect();
    const x = (Math.max(0, rect.left) + Math.min(innerWidth, rect.right)) / 2;
    const y = (Math.max(0, rect.top) + Math.min(innerHeight, rect.bottom)) / 2;
    if (!this.contains(document.elementFromPoint(x, y))) throw new Error("control is hidden or covered");
    return { x, y };
  }`,
  );
  // Register before dispatch. A layout change or disabled ancestor must not produce a success log.
  const receivedClick = callOn(
    cdp,
    objectId,
    `function () {
    return new Promise((resolve) => {
      const onClick = event => {
        if (event.isTrusted) { clearTimeout(timer); resolve(true); }
      };
      const timer = setTimeout(() => { this.removeEventListener("click", onClick, true); resolve(false); }, 2000);
      this.addEventListener("click", onClick, { capture: true, once: true });
    });
  }`,
  );
  async function dispatchClick() {
    for (const type of ["mousePressed", "mouseReleased"]) {
      await cdp.send("Input.dispatchMouseEvent", {
        type,
        ...point,
        button: "left",
        clickCount: 1,
      });
    }
  }
  const [received] = await Promise.all([receivedClick, dispatchClick()]);
  if (!received) throw new Error("control did not receive the click");
  console.log(`clicked ${role} ${JSON.stringify(entry.name)}`);
  logResult(`clicked ${role} ${JSON.stringify(entry.name)}`);
}

async function findSelect(cdp, spec) {
  const combos = await findNodes(cdp, { ...spec, role: "combobox" });
  if (combos.length === 1) return combos[0];
  if (combos.length > 1) {
    throw new Error(
      `found ${combos.length} comboboxes named ${JSON.stringify(spec.name ?? spec.contains)}`,
    );
  }
  return requireOne(cdp, { ...spec, role: "popUpButton" });
}

async function select(cdp) {
  const { name, contains } = nameSpec();
  const value = flag("--value");
  if (value === undefined) fail("missing --value");
  const within = flag("--within");
  const entry = await findSelect(cdp, { name, contains, within });
  const objectId = await objectIdFor(cdp, entry.node);
  if (
    (await callOn(
      cdp,
      objectId,
      'function () { return this.id === "settings-language"; }',
    )) &&
    !existsSync(languageBackupPath)
  ) {
    throw new Error("back up the language before changing it");
  }
  const selected = await callOn(
    cdp,
    objectId,
    `function (value) {
      if (this.tagName !== "SELECT") throw new Error("not a select");
      if (this.matches(":disabled")) throw new Error("select is disabled");
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
      setter.call(this, value);
      this.dispatchEvent(new Event("change", { bubbles: true }));
      return this.value;
    }`,
    [{ value }],
  );
  if (selected !== value) {
    throw new Error(`select stayed on ${JSON.stringify(selected)}`);
  }
  console.log(`selected ${JSON.stringify(entry.name)} = ${selected}`);
  logResult(`selected ${JSON.stringify(entry.name)} = ${selected}`);
}

async function fill(cdp) {
  const { name, contains } = nameSpec();
  const value = flag("--value");
  if (value === undefined) fail("missing --value");
  const within = flag("--within");
  const entry = await requireOne(cdp, {
    role: "textbox",
    name,
    contains,
    within,
  });
  const objectId = await objectIdFor(cdp, entry.node);
  const written = await callOn(
    cdp,
    objectId,
    `function (value) {
      if (this.type === "password") throw new Error("refusing to fill a password field");
      if (this.matches(":disabled") || this.readOnly) throw new Error("field is not editable");
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(this, value);
      this.dispatchEvent(new Event("input", { bubbles: true }));
      return this.value;
    }`,
    [{ value }],
  );
  console.log(`filled ${JSON.stringify(entry.name)}`);
  logResult(`filled ${JSON.stringify(entry.name)} = ${written}`);
}

async function query(cdp) {
  const role = flag("--role");
  const { name, contains } = nameSpec();
  const within = flag("--within");
  const entry = await requireOne(cdp, { role, name, contains, within });
  const objectId = await objectIdFor(cdp, entry.node);
  const state = await callOn(
    cdp,
    objectId,
    `function () {
      const password = this.type === "password";
      return {
        role: this.getAttribute("role") || this.tagName.toLowerCase(),
        disabled: this.matches(":disabled") || Boolean(this.closest('[aria-disabled="true"]')),
        selected: this.getAttribute("aria-selected"),
        value: password ? undefined : "value" in this ? String(this.value) : undefined,
        password
      };
    }`,
  );
  const parts = [`name: ${entry.name}`];
  if (state.disabled) parts.push("disabled: true");
  else parts.push("disabled: false");
  if (state.selected !== null && state.selected !== undefined) {
    parts.push(`selected: ${state.selected}`);
  }
  if (state.password) parts.push("value: [redacted]");
  else if (state.value !== undefined) parts.push(`value: ${state.value}`);
  const text = parts.join("\n");
  console.log(text);
  writeOut(text);
  logResult(text.replaceAll("\n", " "));
  for (const property of ["disabled", "selected", "value"]) {
    const expected = flag(`--expect-${property}`);
    if (
      expected !== undefined &&
      (state.password || String(state[property]) !== expected)
    ) {
      throw new Error(
        `unexpected ${property} on ${JSON.stringify(entry.name)}`,
      );
    }
  }
}

async function waitFor(cdp) {
  const wantedLang = flag("--lang");
  const wantedText = flag("--text");
  const role = flag("--role");
  const { name, contains } = nameSpec(false);
  const timeout = Number(flag("--timeout") ?? 5000);
  const started = Date.now();
  let last = "not found";
  while (Date.now() - started < timeout) {
    if (wantedLang) {
      const current = await lang(cdp);
      if (current === wantedLang) {
        console.log(`lang: ${current}`);
        logResult(`lang: ${current}`);
        return;
      }
      last = `lang ${current}`;
    } else if (wantedText) {
      let observed;
      const within = flag("--within");
      if (role || within) {
        if (!role) throw new Error("scoped text waits require --role");
        const entries = await findNodes(cdp, { role, name, contains, within });
        if (entries.length === 1) {
          const objectId = await objectIdFor(cdp, entries[0].node);
          observed = await callOn(
            cdp,
            objectId,
            "function () { return this.innerText.trim(); }",
          );
        }
      } else if (
        await evaluate(
          cdp,
          `document.body.innerText.includes(${JSON.stringify(wantedText)})`,
        )
      ) {
        observed = wantedText;
      }
      if (observed?.includes(wantedText)) {
        writeOut(observed);
        console.log(`text: ${wantedText}`);
        logResult(`text: ${observed}`);
        return;
      }
      last = `missing ${wantedText}`;
    } else if (role && (name !== undefined || contains !== undefined)) {
      const found = await findNodes(cdp, {
        role,
        name,
        contains,
        within: flag("--within"),
      });
      if (found.length === 1) {
        console.log(`found ${role} ${JSON.stringify(found[0].name)}`);
        logResult(`found ${role} ${JSON.stringify(found[0].name)}`);
        return;
      }
      last = `found ${found.length}`;
    } else {
      fail(
        "wait needs --lang, --text, or --role with --name or --name-contains",
      );
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  throw new Error(`timed out waiting (${last})`);
}

function formatTree(nodes) {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const skip = new Set([
    "none",
    "generic",
    "InlineTextBox",
    "StaticText",
    "LineBreak",
    "image",
    "paragraph",
  ]);
  const lines = [];
  function depth(node) {
    let count = 0;
    let current = node;
    const seen = new Set();
    while (current?.parentId && !seen.has(current.parentId)) {
      seen.add(current.parentId);
      current = byId.get(current.parentId);
      count += 1;
    }
    return count;
  }
  for (const node of nodes) {
    if (node.ignored) continue;
    const entry = named(node);
    if (!entry.name || skip.has(entry.role)) continue;
    const mark = (node.properties ?? [])
      .filter(
        (property) =>
          ["selected", "disabled"].includes(property.name) &&
          property.value?.value === true,
      )
      .map((property) => ` ${property.name}`)
      .join("");
    lines.push(
      `${"  ".repeat(depth(node))}${entry.role} ${JSON.stringify(entry.name)}${mark}`,
    );
  }
  return lines.join("\n");
}

async function snapshot(cdp, page) {
  await requireWorkspaceCapture(cdp);
  const path = flag("--path");
  const facts = await pageFacts(cdp);
  const { nodes } = await axTree(cdp);
  const body = [
    `feature: ${flag("--feature") ?? ""}`,
    `url: ${page.url}`,
    `lang: ${facts.lang}`,
    "",
    formatTree(nodes),
    "",
  ].join("\n");
  if (path) {
    const file = resolve(path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, body, "utf8");
    console.log(`wrote ${file}`);
    logResult(`wrote ${file}`);
  } else {
    console.log(body);
    logResult("printed snapshot");
  }
}

async function screenshot(cdp) {
  await requireWorkspaceCapture(cdp);
  const path = flag("--path");
  if (!path) fail("missing --path");
  await cdp.send("Page.bringToFront");
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
  const file = resolve(path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, Buffer.from(data, "base64"));
  console.log(`wrote ${file}`);
  logResult(`wrote ${file}`);
}

async function requireWorkspaceCapture(cdp) {
  if (
    await evaluate(
      cdp,
      `Boolean(document.querySelector('#settings-language, input[type="password"]'))`,
    )
  ) {
    throw new Error(
      "whole-page capture is disabled in Settings; collect scoped feedback instead",
    );
  }
}

async function backupLanguage(cdp) {
  if (existsSync(languageBackupPath)) {
    throw new Error(
      "language backup already exists; restore the outstanding backup first",
    );
  }
  const current = await lang(cdp);
  const stored = await readStorage(cdp, "lectavia.language");
  mkdirSync(dirname(languageBackupPath), { recursive: true });
  writeFileSync(
    languageBackupPath,
    JSON.stringify({ lang: current, stored }, null, 2),
    { encoding: "utf8", flag: "wx" },
  );
  console.log(`backed up lang ${current}`);
  logResult(`backed up lang ${current} stored ${stored || "empty"}`);
}

async function restoreLanguage(cdp) {
  if (!existsSync(languageBackupPath)) {
    console.log("no language backup");
    logResult("no language backup");
    return;
  }
  const backup = readJson(languageBackupPath);
  if (
    !locales.has(backup.lang) ||
    (backup.stored !== null && typeof backup.stored !== "string")
  ) {
    throw new Error("invalid language backup");
  }
  if (backup.stored === null) await removeStorage(cdp, "lectavia.language");
  else
    await evaluate(
      cdp,
      `localStorage.setItem("lectavia.language", ${JSON.stringify(backup.stored)})`,
    );
  await reload(cdp);
  if (
    (await lang(cdp)) !== backup.lang ||
    (await readStorage(cdp, "lectavia.language")) !== backup.stored
  ) {
    throw new Error(
      "restored language differs from its backup; backup retained",
    );
  }
  unlinkSync(languageBackupPath);
  console.log(`restored lang ${backup.lang}`);
  logResult(`restored lang ${backup.lang}`);
}

function audioBytes() {
  try {
    return readFileSync(audioTarget).toString("base64");
  } catch {
    return null;
  }
}

function backupAudio() {
  readInstance();
  if (existsSync(audioBackupPath)) {
    throw new Error(
      "audio chunk backup already exists; restore the outstanding backup first",
    );
  }
  const bytes = audioBytes();
  mkdirSync(dirname(audioBackupPath), { recursive: true });
  const temp = `${audioBackupPath}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify({ existed: bytes !== null, bytes }));
  try {
    renameSync(temp, audioBackupPath);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
  console.log("backed up audio chunk setting");
  logResult(`backed up audio chunk existed ${bytes !== null}`);
}

function readAudioBackup() {
  if (!existsSync(audioBackupPath)) {
    throw new Error("no audio chunk backup");
  }
  const backup = readJson(audioBackupPath);
  if (
    typeof backup.existed !== "boolean" ||
    (backup.bytes !== null && typeof backup.bytes !== "string") ||
    (!backup.existed && backup.bytes !== null)
  ) {
    throw new Error(`invalid audio chunk backup. Kept ${audioBackupPath}.`);
  }
  return backup;
}

function verifyAudio(backup) {
  const actual = audioBytes();
  if ((actual !== null) !== backup.existed || actual !== backup.bytes) {
    throw new Error(
      `audio chunk setting differs from its backup. Kept ${audioBackupPath}.`,
    );
  }
  console.log("verified original audio chunk setting");
  logResult("verified original audio chunk setting");
}

function checkAudio() {
  verifyAudio(readAudioBackup());
}

function restoreAudio() {
  const backup = readAudioBackup();
  if (backup.existed) {
    const bytes = Buffer.from(backup.bytes, "base64");
    mkdirSync(dirname(audioTarget), { recursive: true });
    const temp = `${audioTarget}.${process.pid}.tmp`;
    writeFileSync(temp, bytes);
    try {
      renameSync(temp, audioTarget);
    } finally {
      if (existsSync(temp)) unlinkSync(temp);
    }
  } else if (existsSync(audioTarget)) {
    unlinkSync(audioTarget);
  }
  verifyAudio(backup);
  unlinkSync(audioBackupPath);
}

async function names(cdp) {
  const feature = argv[1]?.startsWith("--") ? undefined : argv[1];
  const data = readJson(namesPath);
  if (feature && !data[feature]) {
    fail(
      `unknown feature ${JSON.stringify(feature)}; expected one of ${Object.keys(data).join(", ")}`,
    );
  }
  const groups = feature ? ["shared", feature] : Object.keys(data);
  const current = await lang(cdp);
  const lines = [`lang: ${current}`];
  for (const group of groups) {
    for (const [key, perLocale] of Object.entries(data[group])) {
      lines.push(`${group}.${key}=${perLocale[current] ?? perLocale.en ?? ""}`);
    }
  }
  const text = lines.join("\n");
  console.log(text);
  writeOut(text);
  logResult(`printed names ${feature ?? "all"} lang ${current}`);
}

async function reload(cdp) {
  const previous = (await cdp.send("Page.getFrameTree")).frameTree.frame;
  await cdp.send("Page.reload", { loaderId: previous.loaderId });
  const started = Date.now();
  while (Date.now() - started < 15000) {
    try {
      const current = (await cdp.send("Page.getFrameTree")).frameTree.frame;
      if (
        current.id === previous.id &&
        current.loaderId &&
        current.loaderId !== previous.loaderId &&
        current.url === workspaceUrl
      ) {
        const facts = await pageFacts(cdp);
        if (
          facts.ready &&
          facts.url === workspaceUrl &&
          facts.title === "Lectavia" &&
          facts.brand &&
          facts.desktop &&
          !facts.browserNotice
        ) {
          console.log(`reloaded lang ${facts.lang}`);
          logResult(`reloaded lang ${facts.lang}`);
          return;
        }
      }
    } catch {
      // The page context is still navigating.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  throw new Error("reload did not return to the Lectavia workspace");
}

const actions = {
  async doctor() {
    await doctor();
  },
  async lang() {
    await withPage(async (cdp) => {
      const value = await lang(cdp);
      console.log(value);
      writeOut(value);
      logResult(value);
    });
  },
  async storage() {
    const action = argv[1];
    const key = argv[2];
    if (!key || key.startsWith("--")) fail("storage needs a key");
    await withPage(async (cdp) => {
      if (action === "get") {
        const value = (await readStorage(cdp, key)) ?? "";
        console.log(value);
        writeOut(value);
        logResult(`${key}=${value || "empty"}`);
      } else if (action === "set") {
        const value = argv[3];
        if (!value || value.startsWith("--")) fail("storage set needs a value");
        await writeStorage(cdp, key, value);
        console.log(`${key}=${value}`);
        logResult(`${key}=${value}`);
      } else if (action === "remove") {
        await removeStorage(cdp, key);
        console.log(`removed ${key}`);
        logResult(`removed ${key}`);
      } else {
        fail("storage action must be get, set, or remove");
      }
    });
  },
  async click() {
    await withPage(click);
  },
  async select() {
    await withPage(select);
  },
  async fill() {
    await withPage(fill);
  },
  async query() {
    await withPage(query);
  },
  async wait() {
    await withPage(waitFor);
  },
  async reload() {
    await withPage(reload);
  },
  async snapshot() {
    await withPage(snapshot);
  },
  async screenshot() {
    await withPage(screenshot);
  },
  async "backup-language"() {
    await withPage(backupLanguage);
  },
  async "restore-language"() {
    await withPage(restoreLanguage);
  },
  async "backup-audio"() {
    backupAudio();
  },
  async "check-audio"() {
    checkAudio();
  },
  async "restore-audio"() {
    restoreAudio();
  },
  async names() {
    await withPage(names);
  },
};

const action = actions[command];
if (!action) {
  fail(
    "usage: drive.js <doctor|lang|storage|click|select|fill|query|wait|reload|snapshot|screenshot|names|backup-language|restore-language|backup-audio|check-audio|restore-audio>",
  );
}

try {
  await action();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = error.exitCode ?? 1;
}
