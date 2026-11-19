// AgentMiniOffice panel.
//
// Two modes, chosen by the URL:
//   /dashboard   control room: first run, login, your office, agents, tokens
//   /<slug>      office view: rooms, agents, tasks, live over SSE
//
// Ground rules for this file:
//   - all server access goes through api(), so cookies and error handling stay in one place
//   - every string from the server becomes a text node, never markup
//   - no full page reloads for sign in, sign out, or creating things. Use toasts for feedback.

import {
  agentActivityOrder,
  BOARD_STATIONS,
  boardStation,
  eventCue,
  projectActivity,
  sceneEntities,
  stationActivity,
} from "./office-activity.js";

import { avatarPanel } from './avatar-panel.js';
import { confirmAction, workspaceAccessPage } from "./workspace-access.js";

const ROOM_LABEL = {
  lobby: "Lobby",
  barber: "Onboarding",
  desk: "Desk",
  whiteboard: "Whiteboard",
  library: "Library",
  workshop: "Workshop",
  "print-room": "Print Room",
  "phone-booth": "Phone Booth",
  meeting: "Meeting Room",
  pantry: "Pantry",
  "intern-desk": "Subagent Desk",
  away: "Away",
};

const THEME_KEY = "amo.theme";
const path = location.pathname.replace(/\/+$/, "");
const MODE = path === "" || path === "/dashboard" ? "dashboard" : "office";
const SLUG = MODE === "office" ? path.slice(1).split("/")[0] : "";
const share = new URLSearchParams(location.search).get("share") ?? "";

const officeRoot = document.getElementById("officeRoot");
const dashboardRoot = document.getElementById("dashboardRoot");
const toasts = document.getElementById("toasts");
const boot = document.getElementById("boot");

const nodes = {
  officeName: document.getElementById("officeName"),
  officeSlug: document.getElementById("officeSlug"),
  officeMeta: document.getElementById("officeMeta"),
  officeStats: document.getElementById("officeStats"),
  rooms: document.getElementById("rooms"),
  detail: document.getElementById("detail"),
  statusLine: document.getElementById("statusLine"),
};

let expandedAgentId = null;
let lockedAgentId = null;
let requestedAgentId = new URLSearchParams(location.search).get("agent");
function selectAgent(id) {
  lockedAgentId = lockedAgentId === id ? null : id;
  render();
}
let snapshot = null;
let stream = null;

const VIEW_KEY = "amo.view";
let officeView = localStorage.getItem(VIEW_KEY) === "2d" ? "2d" : "3d";
let scene = null;
let scenePromise = null;
let sceneTimer = null;

/* ------------------------------------------------------------------ utilities */

/** Tiny DOM builder. Text nodes only, so server strings can never become markup. */
function h(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function ago(iso) {
  if (!iso) return "never";
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function clock(iso) {
  if (!iso) return "-";
  return new Date(iso).toLocaleTimeString();
}

function fieldCaption(label, input) {
  return h('span', {}, label, input.required ? h('span', { class: 'required-mark', 'aria-hidden': 'true' }, ' *') : null);
}

let fieldId = 0;
function field(label, input, hint) {
  if (!input.id) input.id = `field-${++fieldId}`;
  if (hint) input.setAttribute('aria-describedby', `${input.id}-hint`);
  return h('div', { class: 'field' },
    h('label', { for: input.id }, fieldCaption(label, input)),
    input.type === 'password' ? passwordControl(input) : input,
    hint ? h('small', { id: `${input.id}-hint` }, hint) : null);
}

function passwordControl(input) {
  const toggle = h('button', { type: 'button', class: 'password-eye', 'aria-controls': input.id });
  function render() {
    const masked = input.type === 'password';
    toggle.title = masked ? 'Show password' : 'Hide password';
    toggle.setAttribute('aria-label', toggle.title);
    toggle.replaceChildren(icon(masked ? 'eyeOff' : 'eye', 18));
  }
  toggle.addEventListener('click', () => {
    input.type = input.type === 'password' ? 'text' : 'password';
    render();
  });
  render();
  return h('div', { class: 'password-control' }, input, toggle);
}

function textInput(attrs) {
  return h("input", { class: "input", type: "text", ...attrs });
}

function officeNameInput(attrs = {}) {
  return textInput({
    name: "office",
    maxlength: 32,
    placeholder: "My Office",
    required: true,
    ...attrs,
  });
}

function passwordInput(attrs) {
  return h("input", { class: "input", type: "password", ...attrs });
}

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Hand written icons, inlined as SVG. No icon font, no CDN, no dependency.
 * Strokes use currentColor, so colour comes from CSS.
 */
const ICONS = {
  eye: [['path', { d: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z' }], ['circle', { cx: 12, cy: 12, r: 3 }]],
  eyeOff: [['path', { d: 'M3 3l18 18M9 5.5a11 11 0 0 1 3-.5c6.5 0 10 7 10 7a19 19 0 0 1-3 4M6 7a20 20 0 0 0-4 5s3.5 7 10 7a12 12 0 0 0 5-1M9 10a3 3 0 0 0 4 5' }]],
  grid: [
    ["rect", { x: 3, y: 3, width: 7, height: 7, rx: 1.5 }],
    ["rect", { x: 14, y: 3, width: 7, height: 7, rx: 1.5 }],
    ["rect", { x: 3, y: 14, width: 7, height: 7, rx: 1.5 }],
    ["rect", { x: 14, y: 14, width: 7, height: 7, rx: 1.5 }],
  ],
  users: [
    ["circle", { cx: 9, cy: 8, r: 3 }],
    ["path", { d: "M3.5 19a5.5 5.5 0 0 1 11 0" }],
    ["circle", { cx: 17, cy: 9, r: 2.2 }],
    ["path", { d: "M15.5 13.6c2.6.3 4.5 2.2 4.5 5.4" }],
  ],
  terminal: [
    ["rect", { x: 3, y: 4, width: 18, height: 16, rx: 2 }],
    ["path", { d: "M7 9l3 3-3 3" }],
    ["path", { d: "M13 15h4" }],
  ],
  external: [
    ["path", { d: "M14 4h6v6" }],
    ["path", { d: "M20 4l-8 8" }],
    ["path", { d: "M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" }],
  ],
  link: [
    ["path", { d: "M10.5 13.5a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7L12 6.3" }],
    ["path", { d: "M13.5 10.5a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.5-1.5" }],
  ],
  copy: [
    ["rect", { x: 9, y: 9, width: 11, height: 11, rx: 2 }],
    ["path", { d: "M5 15V5a1 1 0 0 1 1-1h9" }],
  ],
  logout: [
    ["path", { d: "M9 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h4" }],
    ["path", { d: "M16 8l4 4-4 4" }],
    ["path", { d: "M20 12H9" }],
  ],
  moon: [["path", { d: "M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5z" }]],
  sun: [
    ["circle", { cx: 12, cy: 12, r: 4 }],
    [
      "path",
      {
        d: "M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4",
      },
    ],
  ],
  back: [["path", { d: "M15 6l-6 6 6 6" }]],
  x: [["path", { d: "M6 6l12 12M18 6L6 18" }]],
  stop: [["rect", { x: 6, y: 6, width: 12, height: 12, rx: 2 }]],
  robot: [
    ["rect", { x: 4, y: 8, width: 16, height: 11, rx: 3 }],
    ["path", { d: "M12 4v4" }],
    ["circle", { cx: 12, cy: 3, r: 1.2 }],
    ["circle", { cx: 9, cy: 13, r: 1.1 }],
    ["circle", { cx: 15, cy: 13, r: 1.1 }],
    ["path", { d: "M9.5 16.5h5" }],
  ],
  plus: [["path", { d: "M12 5v14M5 12h14" }]],
  check: [["path", { d: "M5 13l4 4L19 7" }]],
  alert: [
    ["path", { d: "M12 4l9 16H3z" }],
    ["path", { d: "M12 10v4M12 17h.01" }],
  ],
  pulse: [["path", { d: "M3 12h4l3-6 4 12 3-6h4" }]],
  inbox: [
    ["path", { d: "M4 13h4l2 3h4l2-3h4" }],
    ["rect", { x: 4, y: 5, width: 16, height: 14, rx: 2 }],
  ],
  book: [
    ["path", { d: "M5 4h6v16H6a1 1 0 0 1-1-1z" }],
    ["path", { d: "M13 4h6v15a1 1 0 0 1-1 1h-5z" }],
  ],
  wrench: [
    ["path", { d: "M14.7 6.3a4 4 0 1 0 3 3L21 6l-3-3-3.3 3.3z" }],
    ["path", { d: "M11 13l-6.5 6.5a2 2 0 0 0 3 3L14 16" }],
  ],
  printer: [
    ["path", { d: "M7 8V4h10v4" }],
    ["rect", { x: 4, y: 8, width: 16, height: 8, rx: 2 }],
    ["rect", { x: 8, y: 14, width: 8, height: 6 }],
  ],
  phone: [
    [
      "path",
      {
        d: "M6 3h3l2 5-2 1a11 11 0 0 0 5 5l1-2 5 2v3a2 2 0 0 1-2 2A16 16 0 0 1 4 5a2 2 0 0 1 2-2z",
      },
    ],
  ],
  coffee: [
    ["path", { d: "M4 8h12v5a5 5 0 0 1-10 0z" }],
    ["path", { d: "M16 9h2a2 2 0 0 1 0 4h-2" }],
    ["path", { d: "M7 3v2M11 3v2" }],
  ],
  pen: [
    ["path", { d: "M4 20l4-1 9-9-3-3-9 9z" }],
    ["path", { d: "M14 7l3 3" }],
  ],
  door: [
    ["rect", { x: 4, y: 3, width: 12, height: 18, rx: 1 }],
    ["path", { d: "M16 12h5" }],
  ],
  scissors: [
    ["circle", { cx: 6, cy: 6, r: 2.5 }],
    ["circle", { cx: 6, cy: 18, r: 2.5 }],
    ["path", { d: "M8 7.5L20 18M8 16.5L20 6" }],
  ],
};

/** One colour per room family. Colour carries meaning, it is not decoration. */
const ROOM_TONE = {
  desk: "sage",
  workshop: "sage",
  "print-room": "sage",
  library: "ocean",
  whiteboard: "ocean",
  meeting: "plum",
  "phone-booth": "plum",
  "intern-desk": "caution",
  pantry: "caution",
  standby: "caution",
  lobby: "clay",
  barber: "clay",
  away: "clay",
};

const ROOM_ICON = {
  lobby: "door",
  barber: "scissors",
  desk: "pen",
  whiteboard: "pen",
  library: "book",
  workshop: "wrench",
  "print-room": "printer",
  "phone-booth": "phone",
  meeting: "users",
  pantry: "coffee",
  standby: "coffee",
  "intern-desk": "users",
  away: "moon",
};

function icon(name, size = 16, className = "icon") {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.7");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", className);

  for (const [tag, attrs] of ICONS[name] ?? []) {
    const element = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
    svg.append(element);
  }
  return svg;
}

function brandMark() {
  return h("span", { class: "brand-mark", "aria-hidden": "true" }, icon("robot", 18));
}

/**
 * The toggle shows what you would switch to, and it is re-rendered on every theme change.
 * A stale moon icon in dark mode is worse than no icon.
 */
function syncThemeButtons() {
  const dark = document.documentElement.dataset.theme === "dark";
  const label = dark ? "Switch to light theme" : "Switch to dark theme";

  for (const button of document.querySelectorAll("[data-theme-toggle]")) {
    button.replaceChildren(icon(dark ? "sun" : "moon", 15), dark ? "Light" : "Dark");
    button.setAttribute("aria-label", label);
    button.setAttribute("title", label);
  }
}

function codeBlock(text) {
  return h("pre", { class: "code-block" }, text);
}

/* ---------------------------------------------------------------------- theme */

function preferredTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === "light" || saved === "dark") return saved;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(THEME_KEY, theme);
  syncThemeButtons();

  if (scene) {
    scene.setTheme();
    pushScene();
  }
}

for (const mark of document.querySelectorAll("[data-brand-mark]")) {
  mark.replaceChildren(icon("robot", 18));
}

applyTheme(preferredTheme());

document.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return;
  const viewButton = event.target.closest("[data-view]");
  if (viewButton) {
    setView(viewButton.dataset.view);
    return;
  }

  const toggle = event.target.closest("[data-theme-toggle]");
  if (!toggle) return;
  applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
});

/* --------------------------------------------------------------------- toasts */

const TOAST_ICON = { ok: "check", error: "alert", warn: "alert", info: "inbox" };
const TOAST_LIFE = { ok: 4200, error: 7000, warn: 6000, info: 4200 };

function toast(message, variant = "ok") {
  const kind = variant in TOAST_LIFE ? variant : "ok";
  const life = TOAST_LIFE[kind];

  const node = h(
    "div",
    { class: `toast toast-${kind}` },
    h("span", { class: "toast-icon" }, icon(TOAST_ICON[kind], 14)),
    h("p", {}, message),
    h(
      "button",
      { type: "button", "aria-label": "Dismiss", onclick: () => dismiss() },
      icon("x", 14),
    ),
  );

  // Duration is data, not design, so it is the one place a custom property is set from JS.
  node.style.setProperty("--toast-life", `${life}ms`);

  function dismiss() {
    if (!node.isConnected) return;
    node.classList.add("is-leaving");
    setTimeout(() => node.remove(), 180);
  }

  toasts.append(node);
  setTimeout(dismiss, life);
  return dismiss;
}

/* ------------------------------------------------------------------ transport */

async function api(url, options = {}) {
  const response = await fetch(url, {
    method: options.method ?? "GET",
    credentials: "same-origin",
    headers: options.body ? { "content-type": "application/json" } : {},
    body: options.body ? JSON.stringify(options.body) : undefined,
    cache: "no-store",
  });

  const data = await response.json().catch(() => null);
  return { ok: response.ok, status: response.status, data };
}

function errorMessage(result, fallback) {
  return result?.data?.error?.message ?? fallback;
}

/* ------------------------------------------------------------------ particles */

let cancelParticles = null;

/**
 * A quiet background for the sign in screen: drifting dots with hairline links.
 * Purely decorative, hidden from assistive tech, and static when motion is reduced.
 */
function startParticles(canvas) {
  const context = canvas.getContext("2d");
  if (!context) return;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const dots = [];
  let width = 0;
  let height = 0;
  let frame = 0;

  const color = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();

  function resize() {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    canvas.width = Math.max(1, Math.round(width * ratio));
    canvas.height = Math.max(1, Math.round(height * ratio));
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  function seed() {
    dots.length = 0;
    const count = Math.round(Math.min(60, Math.max(20, (width * height) / 28000)));
    for (let index = 0; index < count; index++) {
      dots.push({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * 0.16,
        vy: (Math.random() - 0.5) * 0.16,
        r: 1 + Math.random() * 1.4,
      });
    }
  }

  function draw() {
    context.clearRect(0, 0, width, height);

    for (const dot of dots) {
      dot.x += dot.vx;
      dot.y += dot.vy;
      if (dot.x < 0 || dot.x > width) dot.vx *= -1;
      if (dot.y < 0 || dot.y > height) dot.vy *= -1;
    }

    for (let a = 0; a < dots.length; a++) {
      for (let b = a + 1; b < dots.length; b++) {
        const dx = dots[a].x - dots[b].x;
        const dy = dots[a].y - dots[b].y;
        const distance = Math.hypot(dx, dy);
        if (distance > 130) continue;
        context.globalAlpha = (1 - distance / 130) * 0.22;
        context.strokeStyle = color;
        context.lineWidth = 1;
        context.beginPath();
        context.moveTo(dots[a].x, dots[a].y);
        context.lineTo(dots[b].x, dots[b].y);
        context.stroke();
      }
    }

    context.globalAlpha = 0.5;
    context.fillStyle = color;
    for (const dot of dots) {
      context.beginPath();
      context.arc(dot.x, dot.y, dot.r, 0, Math.PI * 2);
      context.fill();
    }
    context.globalAlpha = 1;

    if (!reduce) frame = requestAnimationFrame(draw);
  }

  resize();
  seed();
  draw();

  const onResize = () => {
    resize();
    seed();
    if (reduce) draw();
  };
  addEventListener("resize", onResize, { passive: true });

  cancelParticles = () => {
    cancelAnimationFrame(frame);
    removeEventListener("resize", onResize);
    cancelParticles = null;
  };
}

function authScreen({ copy, card, footer }) {
  if (cancelParticles) cancelParticles();

  const canvas = h("canvas", { "aria-hidden": "true" });
  const screen = h("div", { class: "auth" }, canvas, h("div", { class: "auth-grid" }, copy, card));

  dashboardRoot.replaceChildren(screen);
  officeRoot.hidden = true;
  dashboardRoot.hidden = false;
  boot.hidden = true;

  startParticles(canvas);
  return { screen, footer };
}

/* --------------------------------------------------------------- auth screens */

const BRAND_COPY = () =>
  h(
    "div",
    { class: "auth-copy" },
    h("div", { class: "brand" }, brandMark(), "AgentMiniOffice"),
    h("h1", { style: "margin-top:var(--s4)" }, "Watch your agents work, not just their logs."),
    h(
      "p",
      {},
      "A small self-hosted office for coding agents. Heartbeats in, a room full of desks out, with tasks your agents can pick up when they are idle.",
    ),
    h(
      "ul",
      { class: "checklist" },
      ...[
        "Presence derived from heartbeats, never self reported",
        "A closed room vocabulary, so the office keeps meaning",
        "Task inbox with leases, so dead agents cannot hold work",
        "One REST contract for every harness, shims live on the agent side",
      ].map((item) => h("li", {}, h("span", { class: "check", "aria-hidden": "true" }, "✓"), item)),
    ),
  );

function submitButton(label, iconName) {
  return h(
    "button",
    { class: "btn btn-block", type: "submit" },
    iconName ? icon(iconName, 16) : null,
    label,
  );
}

function withBusy(button, run) {
  return async (event) => {
    event.preventDefault();
    if (button.classList.contains("is-busy")) return;
    button.classList.add("is-busy");
    button.setAttribute("aria-busy", "true");
    try {
      await run();
    } finally {
      button.classList.remove("is-busy");
      button.removeAttribute("aria-busy");
    }
  };
}

async function renderSetup() {
  const name = textInput({
    name: "name",
    placeholder: "Indra",
    required: true,
    autocomplete: "name",
  });
  const email = textInput({
    name: "email",
    placeholder: "you@example.com",
    required: true,
    autocomplete: "email",
  });
  const password = passwordInput({
    name: "password",
    placeholder: "at least 10 characters",
    required: true,
    autocomplete: "new-password",
  });
  const office = officeNameInput();
  const button = submitButton("Create administrator", "plus");

  const form = h(
    "form",
    {
      class: "stack",
      onsubmit: withBusy(button, async () => {
        const result = await api("/api/v1/setup", {
          method: "POST",
          body: {
            name: name.value.trim(),
            email: email.value.trim(),
            password: password.value,
            office: office.value.trim(),
          },
        });

        if (!result.ok) {
          toast(errorMessage(result, "Could not create the administrator"), "error");
          return;
        }
        toast("Office created. You are signed in.");
        await startDashboard();
      }),
    },
    field("Your Name", name),
    field("Email", email),
    field("Password", password, "10 characters or more"),
    field("Office Name", office, "Up to 32 characters. Becomes the URL: /my-office."),
    button,
  );

  authScreen({
    copy: BRAND_COPY(),
    card: h(
      "div",
      { class: "auth-card" },
      h("h2", {}, "First run"),
      h("p", { class: "lead" }, "This form appears only while the database has no accounts."),
      form,
      h(
        "p",
        { class: "auth-foot" },
        "Start over by deleting data/minioffice.db and restarting the service.",
      ),
    ),
  });
}

async function renderLogin(config) {
  const email = textInput({
    name: "email",
    placeholder: "you@example.com",
    required: true,
    autocomplete: "username",
  });
  const password = passwordInput({
    name: "password",
    placeholder: "password",
    required: true,
    autocomplete: "current-password",
  });
  const button = submitButton("Sign in", "check");

  const form = h(
    "form",
    {
      class: "stack",
      onsubmit: withBusy(button, async () => {
        const result = await api("/api/v1/auth/login", {
          method: "POST",
          body: { email: email.value.trim(), password: password.value },
        });

        if (!result.ok) {
          toast(errorMessage(result, "Email or password is wrong"), "error");
          return;
        }
        toast(`Signed in as ${result.data.member.display_name}.`);
        await startDashboard();
      }),
    },
    field("Email", email),
    field("Password", password),
    button,
  );

  const canRegister = config?.allow_registration === true;

  authScreen({
    copy: BRAND_COPY(),
    card: h(
      "div",
      { class: "auth-card" },
      h("h2", {}, "Sign in"),
      h("p", { class: "lead" }, "Use the account created during first run."),
      form,
      h(
        "p",
        { class: "auth-foot" },
        h("a", { href: "/guides/integrations.html" }, "Public Integrations Guide"),
      ),
      canRegister
        ? h(
            "button",
            {
              class: "btn btn-quiet btn-block mt-3",
              type: "button",
              onclick: () => renderRegister(config),
            },
            "Create another office",
          )
        : h(
            "p",
            { class: "auth-foot" },
            "Registration is disabled on this instance. Ask the operator for an account.",
          ),
    ),
  });
}

async function renderRegister(config) {
  const name = textInput({ name: "name", placeholder: "your name", required: true });
  const email = textInput({ name: "email", placeholder: "you@example.com", required: true });
  const password = passwordInput({
    name: "password",
    placeholder: "at least 10 characters",
    required: true,
  });
  const office = officeNameInput();
  const button = submitButton("Create account", "plus");

  const form = h(
    "form",
    {
      class: "stack",
      onsubmit: withBusy(button, async () => {
        const result = await api("/api/v1/auth/register", {
          method: "POST",
          body: {
            name: name.value.trim(),
            email: email.value.trim(),
            password: password.value,
            office: office.value.trim(),
          },
        });

        if (!result.ok) {
          toast(errorMessage(result, "Could not create the account"), "error");
          return;
        }
        toast("Account created. You are signed in.");
        await startDashboard();
      }),
    },
    field("Your Name", name),
    field("Email", email),
    field("Password", password),
    field("Office Name", office, "Up to 32 characters."),
    button,
  );

  authScreen({
    copy: BRAND_COPY(),
    card: h(
      "div",
      { class: "auth-card" },
      h("h2", {}, "Create your office"),
      h("p", { class: "lead" }, "One account owns one office in this version."),
      form,
      h(
        "button",
        {
          class: "btn btn-quiet btn-block mt-3",
          type: "button",
          onclick: () => renderLogin(config),
        },
        "Back to sign in",
      ),
    ),
  });
}

/* ------------------------------------------------------------------ dashboard */

const dash = { me: null, office: null, section: "overview" };

// Presentation only: the server still authorizes the stored owner/admin/viewer roles.
function canOperateOffice() {
  return ["owner", "admin"].includes(dash.office?.role ?? dash.me?.member?.role);
}

function officeRoleLabel() {
  return (
    { owner: "Owner", admin: "Operator", viewer: "Viewer" }[
      dash.office?.role ?? dash.me?.member?.role
    ] ?? "Unknown Role"
  );
}

function showDashboardSection(section) {
  dash.section = section;
  renderDashboard();
  const heading = dashboardRoot.querySelector("h1");
  heading?.setAttribute("tabindex", "-1");
  heading?.focus();
}

function sectionButton(label, section, iconName = "external") {
  return h(
    "button",
    { class: "btn btn-quiet btn-sm", type: "button", onclick: () => showDashboardSection(section) },
    icon(iconName, 15),
    label,
  );
}

function tabItem(label, key, count, iconName) {
  return h(
    "button",
    {
      class: "tab",
      type: "button",
      "aria-current": dash.section === key ? "page" : null,
      "data-section": key,
      onclick: () => showDashboardSection(key),
    },
    iconName ? icon(iconName, 15) : null,
    label,
    count === undefined ? null : h("span", { class: "count" }, String(count)),
  );
}

function dashboardShell(page) {
  if (cancelParticles) cancelParticles();

  const signOut = h(
    "button",
    {
      class: "btn btn-quiet btn-sm",
      type: "button",
      onclick: async () => {
        await api("/api/v1/auth/logout", { method: "POST" });
        toast("Signed out.", "info");
        dash.me = null;
        dash.office = null;
        await startDashboard();
      },
    },
    icon("logout", 15),
    "Sign Out",
  );

  officeRoot.hidden = true;
  dashboardRoot.hidden = false;
  boot.hidden = true;

  dashboardRoot.replaceChildren(
    h(
      "div",
      { class: "app" },
      h(
        "header",
        { class: "appbar" },
        h(
          "div",
          { class: "appbar-inner" },
          h("a", { class: "brand", href: "/dashboard" }, brandMark(), "AgentMiniOffice"),
          h(
            "nav",
            { class: "tabs", "aria-label": "Control room" },
            tabItem("Overview", "overview", undefined, "grid"),
            tabItem("Agents", "agents", dash.office?.agents?.length, "users"),
            tabItem("Tasks", "tasks", undefined, "inbox"),
            tabItem("Integrations", "integrations", undefined, "terminal"),
          ),
          h(
            "div",
            { class: "appbar-end" },
            h(
              "span",
              { class: "who" },
              dash.me?.member?.display_name ?? "",
              h("span", { class: "badge role-badge" }, officeRoleLabel()),
            ),
            h(
              "button",
              { class: "btn btn-ghost btn-sm", type: "button", "data-theme-toggle": true },
              icon("moon", 15),
              "Theme",
            ),
            signOut,
          ),
        ),
      ),
      page,
    ),
  );
}

function cardHead(title, description, iconName, tone = "tone-sage") {
  return h(
    "div",
    { class: "card-head" },
    h(
      "div",
      {},
      h(
        "div",
        { class: "card-title" },
        iconName ? h("span", { class: `card-icon ${tone}` }, icon(iconName, 15)) : null,
        h("h2", {}, title),
      ),
      description ? h("p", {}, description) : null,
    ),
  );
}

function pageFoot() {
  return h(
    "footer",
    { class: "page-foot" },
    h("span", {}, `AgentMiniOffice${dash.version ? ` ${dash.version}` : ""} · self-hosted`),
    sectionButton("Integration Guide", "integrations", "terminal"),
  );
}

// UI preferences are scoped to the current office, not inferred from demo_running.
let demoDraft;
function demoPreferences(office) {
  if (demoDraft?.slug !== office.slug)
    demoDraft = { slug: office.slug, count: 6, open: office.demo_running === true };
  return demoDraft;
}

function demoCard(office) {
  const draft = demoPreferences(office);
  const running = office.demo_running === true;
  const count = h(
    "select",
    {
      class: "input",
      "aria-label": "Demo Agent Count",
      disabled: running,
      onchange: (e) => {
        draft.count = Number(e.target.value);
      },
    },
    ...[5, 6, 7, 8].map((value) =>
      h(
        "option",
        { value, selected: value === draft.count },
        `${value} Agents${value === 8 ? " · Density Test" : ""}`,
      ),
    ),
  );
  const action = h(
    "button",
    {
      class: running ? "btn btn-danger btn-sm" : "btn btn-sm",
      type: "button",
      onclick: async () => {
        if (action.disabled) return;
        action.disabled = true;
        count.disabled = true;
        try {
          const result = running
            ? await api(officeUrlFor(office, "/demo"), { method: "DELETE" })
            : await api(officeUrlFor(office, "/demo"), {
                method: "POST",
                body: { count: Number(count.value) },
              });
          if (!result.ok) {
            toast(errorMessage(result, "Could not change the demo state"), "error");
            return;
          }

          toast(
            running
              ? "Demo stopped. The demo roster has been refreshed."
              : `Demo started with ${result.data.agents} simulated agents.`,
          );
          office.demo_running = result.data.running;
          // A failed refresh must not undo a confirmed start/stop or discard the count.
          const fresh = await api("/api/v1/offices").catch(() => null);
          if (dash.office !== office) return;
          if (fresh?.ok && fresh.data.offices?.[0]?.slug === office.slug)
            dash.office = fresh.data.offices[0];
          else toast("Demo state changed. Refresh to update registration totals.", "info");
          if (dash.section === "overview") {
            const restoreFocus =
              document.activeElement === action || document.activeElement === document.body;
            renderDashboard();
            if (restoreFocus)
              dashboardRoot
                .querySelector(".demo-tools[open] button")
                ?.focus({ preventScroll: true });
          }
        } catch {
          toast("Could not confirm the demo state. Refresh before retrying.", "error");
        } finally {
          action.disabled = false;
          count.disabled = running;
        }
      },
    },
    icon(running ? "stop" : "plus", 15),
    running ? "Stop Demo" : "Start Demo",
  );

  return h(
    "section",
    { class: "demo-panel" },
    cardHead(
      "Demo Agents",
      "Simulated agents drive the real API, so the pipeline is exercised end to end.",
      "pulse",
      running ? "tone-sage" : "tone-clay",
    ),
    h(
      "div",
      { class: "row" },
      count,
      action,
      h(
        "a",
        { class: "btn btn-quiet btn-sm", href: `/${encodeURIComponent(office.slug)}` },
        icon("external", 15),
        "Watch",
      ),
    ),
    h(
      "p",
      { class: "tiny muted mt-3" },
      "Demo agents and their assigned tasks are temporary. Stop Demo or restart the collector to clear them.",
    ),
  );
}

function recentAgentsCard(office) {
  const agents = office?.agents ?? [];
  const inspector = workerInspector(office);
  return h(
    "section",
    { class: "card" },
    cardHead(
      "Office Visitors",
      "Inspect the latest report from a visiting worker.",
      "users",
      "tone-plum",
    ),
    agents.length
      ? h(
          "table",
          { class: "table roster" },
          h(
            "thead",
            {},
            h(
              "tr",
              {},
              ...["Agent Name", "Kind", "Action"].map((label) => h("th", { scope: "col" }, label)),
            ),
          ),
          h(
            "tbody",
            {},
            agents
              .slice(0, 8)
              .map((agent) =>
                h(
                  "tr",
                  {},
                  h("td", {}, agent.name),
                  h("td", {}, h("span", { class: "badge" }, harnessLabel(agent.kind))),
                  h("td", {}, inspector.button(agent)),
                ),
              ),
          ),
        )
      : h("div", { class: "empty" }, "No agents yet."),
    h(
      "div",
      { class: "dashboard-actions" },
      sectionButton(canOperateOffice() ? "Manage Agents" : "View Agents", "agents", "users"),
      sectionButton("View Task Board", "tasks", "inbox"),
    ),
  );
}

function statBlocks(office) {
  const agents = office?.agents ?? [];
  const tokens = agents.reduce((total, agent) => total + Number(agent.tokens ?? 0), 0);
  const pending = agents.reduce((total, agent) => total + Number(agent.pending_tasks ?? 0), 0);

  return h(
    "dl",
    { class: "stats" },
    ...[
      ["Office Visitors", agents.length, "users", ""],
      ["Pending Tasks", pending, "inbox", "stat-icon-warn"],
      ["Agent Credentials", tokens, "link", "stat-icon-info"],
    ].map(([label, value, iconName, tone]) =>
      h(
        "div",
        { class: "stat" },
        h("span", { class: `stat-icon ${tone}` }, icon(String(iconName), 17)),
        h("div", {}, h("dt", {}, String(label)), h("dd", {}, String(value))),
      ),
    ),
  );
}

function officeUrlFor(office, suffix = "") {
  return `/api/v1/offices/${encodeURIComponent(office.slug)}${suffix}`;
}

function revealToken(label, token, hint, badge = "Shown Once") {
  return h(
    "div",
    { class: "reveal" },
    h(
      "div",
      { class: "row spread" },
      h("strong", {}, label),
      h("span", { class: "badge badge-accent" }, badge),
    ),
    h("pre", { class: "credential-value", "data-secret": true }, token),
    hint ? h("p", { class: "small muted" }, hint) : null,
    h(
      "button",
      {
        class: "btn btn-quiet btn-sm",
        type: "button",
        onclick: async () => {
          try {
            await navigator.clipboard.writeText(token);
            toast("Copied to clipboard.");
          } catch {
            toast("Copy failed. Select the text manually.", "error");
          }
        },
      },
      "Copy",
    ),
  );
}

function sharingControls(office) {
  const label = textInput({ name: "share_label", placeholder: "Design review", maxlength: 80 });
  const duration = h(
    "select",
    { class: "input", name: "share_days" },
    ...[1, 7, 30].map((days) =>
      h("option", { value: days, selected: days === 7 }, `${days} Day${days === 1 ? "" : "s"}`),
    ),
  );
  const consent = h('input', { type: 'checkbox', name: 'share_consent', required: true });
  const status = h("p", { class: "share-status small", role: "status" });
  const revealSlot = h("div", {});
  const button = submitButton("Create Read-Only Link", "link");
  const form = h(
    "form",
    {
      class: "share-form stack",
      onsubmit: withBusy(button, async () => {
        status.textContent = "Creating link…";
        try {
          const result = await api(officeUrlFor(office, "/share"), {
            method: "POST",
            body: { label: label.value.trim() || "Office view", days: Number(duration.value) },
          });
          if (!result.ok) {
            status.textContent = errorMessage(result, "Could not create the link. Try again.");
            return;
          }
          status.textContent = result.data.expires_at
            ? `Expires ${new Date(result.data.expires_at).toLocaleString()}. Save this link before leaving the page.`
            : "This link does not expire. Save it before leaving the page.";
          revealSlot.replaceChildren(
            revealToken(
              "Read-Only Link",
              `${location.origin}/${encodeURIComponent(office.slug)}?share=${result.data.token}`,
              "Anyone with this link can read this office. Keep it out of public channels.",
            ),
          );
          form.hidden = true;
          revealSlot.setAttribute("tabindex", "-1");
          revealSlot.focus();
        } catch {
          status.textContent =
            "Could not confirm link creation. Check your connection. Retrying may create another link.";
        }
      }),
    },
    h(
      "p",
      { class: "guide-warning small" },
      "Read-only does not mean redacted. Host and project names, task/run titles, and activity may be visible. Link listing and revocation are not available in this dashboard yet.",
    ),
    field("Link Label", label),
    field("Expires After", duration),
    h(
      "label",
      { class: "consent" },
      consent,
      fieldCaption('I understand that anyone with this link can read office information.', consent),
    ),
    button,
  );
  const url = `${location.origin}/${encodeURIComponent(office.slug)}`;
  const publicLink = h('div', {class:'stack'}, h('a', {href:url}, url),
    h('button', {type:'button', class:'btn btn-quiet btn-sm', onclick:async () => {
      try { await navigator.clipboard.writeText(url); status.textContent='Office link copied.'; }
      catch { status.textContent='Copy failed. Select the office URL and copy it manually.'; }
    }}, 'Copy link'));
  const toggle = h('input', {type:'checkbox', role:'switch', 'aria-describedby':'public-view-description'});
  function displayMode() {
    toggle.checked = office.public_view;
    publicLink.hidden = !office.public_view;
    form.hidden = office.public_view;
    revealSlot.replaceChildren();
  }
  displayMode();
  toggle.addEventListener('change', async () => {
    toggle.disabled = true;
    try {
      const result = await api(officeUrlFor(office,'/public-view'), {method:'PUT',body:{enabled:toggle.checked}});
      if (!result.ok) throw Error();
      office.public_view = result.data.public_view;
      displayMode();
      status.textContent = office.public_view ? 'Public View is on.' : 'Public View is off. Existing private links still work.';
    } catch { toggle.checked=office.public_view; status.textContent='Could not confirm the change. Refresh the overview to check its status.'; }
    finally { toggle.disabled=false; }
  });
  return h('details', {class:'guide-topic'}, h('summary', {}, 'Share Office'),
    h('div', {class:'guide-topic-body'},
      office.role === 'owner' ? h('label', {class:'public-view-switch'}, 'Public View',
        toggle, h('span', {class:'switch-track', 'aria-hidden':'true'})) : null,
      h('p', {id:'public-view-description',class:'small muted'}, 'When Public View is on, anyone with the office URL can see live activity and task information without signing in. They cannot make changes. Turn it off to require a member login or private share link.'),
      publicLink, form, status, revealSlot));
}

function officeNameEditor(office) {
  const input = officeNameInput({
    name: "office_name",
    value: office.name,
    "aria-describedby": "office-name-hint",
  });
  const save = submitButton("Save Name", "check");
  const form = h(
    "form",
    {
      class: "rename-form",
      onsubmit: withBusy(save, async () => {
        try {
          const result = await api(`/api/v1/offices/${encodeURIComponent(office.slug)}`, {
            method: "PATCH",
            body: { name: input.value.trim() },
          });
          if (!result.ok)
            return toast(errorMessage(result, "Could not rename the office."), "error");
          office.name = result.data.name;
          if (dash.office === office && dash.section === "overview")
            showDashboardSection("overview");
          toast("Office name updated.");
        } catch {
          toast("Could not confirm the rename. Refresh to check the saved name.", "error");
        }
      }),
    },
    field("Office Name", input),
    save,
    h(
      "small",
      { id: "office-name-hint", class: "muted" },
      "Up to 32 characters. The office URL stays the same.",
    ),
  );
  return h(
    "details",
    { class: "guide-topic rename-office" },
    h("summary", {}, "Rename Office"),
    h("div", { class: "guide-topic-body" }, form),
  );
}

function overviewPage() {
  const office = dash.office;
  if (!office)
    return h(
      "div",
      { class: "page" },
      h("div", { class: "empty" }, "No office on this account yet."),
    );
  const refresh = h(
    "button",
    { class: "btn btn-quiet btn-sm", type: "button" },
    icon("pulse", 15),
    "Refresh",
  );
  refresh.addEventListener(
    "click",
    withBusy(refresh, async () => {
      try {
        const result = await api("/api/v1/offices");
        if (!result.ok || !result.data.offices?.[0]) {
          toast("Could not refresh the office. The current overview is unchanged.", "error");
          return;
        }
        dash.office = result.data.offices[0];
        showDashboardSection("overview");
      } catch {
        toast("Could not refresh the office. Check your connection.", "error");
      }
    }),
  );
  return h(
    "main",
    { class: "page dashboard-page" },
    h(
      "div",
      { class: "page-head" },
      h(
        "div",
        {},
        h("p", { class: "eyebrow" }, "Control Room"),
        h("h1", {}, office.name),
        h(
          "p",
          {},
          `/${office.slug} · Registration and queue totals. Open Office for live activity.`,
        ),
      ),
      h(
        "div",
        { class: "dashboard-actions" },
        refresh,
        sectionButton("View Visitors", "agents", "users"),
        h(
          "a",
          { class: "btn", href: `/${encodeURIComponent(office.slug)}` },
          icon("external", 16),
          "Open Office",
        ),
      ),
    ),
    statBlocks(office),
    h(
      "div",
      { class: "overview-grid" },
      recentAgentsCard(office),
      h(
        "section",
        { class: "card access-card" },
        cardHead(
          "Office Access",
          "Member permissions and read-only sharing.",
          "link",
          "tone-ocean",
        ),
        h(
          "div",
          { class: "row" },
          h("span", { class: "badge role-badge" }, officeRoleLabel()),
          h(
            "span",
            { class: "small muted" },
            canOperateOffice() ? "Can manage agents and tasks" : "Read-only member access",
          ),
        ),
        office.role === "owner"
          ? h(
              "div",
              { class: "workspace-entry" },
              sectionButton("Workspace Access", "workspace", "link"),
            )
          : null,
        office.role === "owner" ? officeNameEditor(office) : null,
        canOperateOffice()
          ? sharingControls(office)
          : h("p", { class: "small muted" }, "Only an Owner or Operator can create share links."),
      ),
    ),
    h(
      "div",
      { class: "overview-utilities" },
      h(
        "section",
        { class: "card onboarding-card" },
        h(
          "div",
          {},
          h(
            "h2",
            {},
            office.agents?.length ? "Connect an Integration" : "Connect Your First Agent",
          ),
          h(
            "p",
            { class: "small muted" },
            "Connect a visitor using your office key or trusted connector.",
          ),
        ),
        sectionButton("Open Integration Guide", "integrations", "terminal"),
      ),
      canOperateOffice()
        ? h(
            "details",
            {
              class: "card demo-tools",
              open: demoPreferences(office).open,
              ontoggle: (e) => {
                if (e.currentTarget.isConnected)
                  demoPreferences(office).open = e.currentTarget.open;
              },
            },
            h(
              "summary",
              {},
              "Demo Tools",
              h("span", { class: "badge" }, office.demo_running ? "Running" : "Stopped"),
              h("small", { class: "demo-description" }, "Run a simulated team in this office."),
            ),
            demoCard(office),
          )
        : null,
    ),
    pageFoot(),
  );
}

function workerInspector(office) {
  const panel = h("section", {
    class: "worker-details",
    hidden: true,
    tabindex: "-1",
    "aria-label": "Agent Details",
  });
  let version = 0,
    selected = null;
  const detailRow = h("tr", { class: "inspector-row" }, h("td", {}, panel));
  function collapse() {
    ++version;
    detailRow.remove();
    selected?.setAttribute("aria-expanded", "false");
    selected = null;
  }
  async function open(agent, trigger) {
    const same = selected === trigger;
    collapse();
    if (same) return;
    selected = trigger;
    const request = version;
    const row = trigger.closest("tr");
    detailRow.cells[0].colSpan = row.cells.length;
    row.after(detailRow);
    trigger.setAttribute("aria-expanded", "true");
    const status = h("p", { class: "small muted", role: "status" }, "Loading office snapshot…");
    const content = h("div", {});
    const close = h(
      "button",
      {
        type: "button",
        class: "btn btn-quiet btn-sm",
        "aria-label": "Close Details",
        title: "Close Details",
        onclick: () => {
          const target = selected;
          collapse();
          target?.focus();
        },
      },
      icon("x", 16),
    );
    const locate = h(
        "a",
        {
          class: "btn btn-quiet btn-sm",
          href: `/${encodeURIComponent(office.slug)}?agent=${encodeURIComponent(agent.id)}`,
        },
        icon("external", 15),
        "Locate in Office",
    );
    panel.replaceChildren(h('header',{class:'inspector-head'},
      h('div',{},h('h3',{},agent.name),status), h('div',{class:'agent-row-actions'},locate,close)),content);
    panel.hidden = false;
    panel.focus();
    try {
      const result = await api(officeUrlFor(office, "/snapshot"));
      if (request !== version || !panel.isConnected) return;
      if (!result.ok) throw new Error();
      const worker = result.data.agents.find((item) => item.id === agent.id);
      if (!worker) {
        status.textContent = "This agent is no longer in the office snapshot.";
        return;
      }
      status.textContent = `Office snapshot at ${clock(result.data.server_time)} · Agent ID: ${agent.id}`;
      const appearance = avatarPanel(h, worker, office.role === 'owner', async variation => {
        const update = await api(officeUrlFor(office, `/agents/${encodeURIComponent(worker.id)}/appearance`), {
          method: 'PUT', body: { variation },
        });
        if (!update.ok) throw Error(errorMessage(update,'Could not save appearance. Please try again.'));
      });
      content.replaceChildren(appearance, agentBody(worker, result.data.agents, true));
    } catch {
      if (request === version && panel.isConnected)
        status.textContent = "Could not load agent details. Select View Details to retry.";
    }
  }
  return {
    restore(body) {
      if (!selected) return;
      const next = body.querySelector(`[data-inspect="${CSS.escape(selected.dataset.inspect)}"]`);
      if (!next) { collapse(); return; }
      selected = next;
      next.setAttribute('aria-expanded','true');
      next.closest('tr').after(detailRow);
    },
    button: (agent) =>
      h(
        "button",
        {
          type: "button",
          class: "btn btn-quiet btn-sm",
          'data-inspect': agent.id,
          "aria-label": `View Details: ${agent.name}`,
          "aria-expanded": "false",
          onclick: (e) => open(agent, e.currentTarget),
        },
        "View Details",
      ),
  };
}

function harnessLabel(kind) {
  return kind === 'pi' ? 'Pi' : kind || 'Not reported';
}

function metadataLabel(value) {
  if (!value) return 'Not reported';
  if (value === 'sdk') return 'SDK';
  if (value === 'builtin') return 'Built-in';
  if (value === 'builtin-extension') return 'Built-in extension';
  return value[0].toUpperCase() + value.slice(1).replaceAll('_', ' ');
}

function agentRow(agent, inspector, onDelete) {
  return h(
    "tr",
    {},
    h(
      "td",
      { class: "agent-identity" },
      h("strong", {}, agent.name),
      h("code", { class: "agent-id" }, agent.id),
    ),
    h("td", {}, STATE_LABEL[agent.state] ?? 'Not reported'),
    h("td", { class: "muted" }, harnessLabel(agent.kind)),
    h("td", { class: "muted" }, agent.project ?? "Unassigned"),
    h("td", {}, agent.can_receive_tasks ? "Allowed" : "Not granted"),
    h("td", {}, String(agent.pending_tasks ?? 0)),
    h("td", {}, h('div', {class:'agent-row-actions'}, inspector.button(agent), agent.state === 'offline' && onDelete ? h('button', {
      type:'button', class:'btn btn-quiet btn-sm', 'aria-label':`Delete offline session: ${agent.name}`,
      onclick: () => onDelete(agent),
    }, 'Delete') : null)),
  );
}

function agentsPage() {
  const office = dash.office;
  if (!office) {
    return h(
      "div",
      { class: "page" },
      h("div", { class: "empty" }, "No office on this account yet."),
    );
  }

  const body = h("tbody", {});
  const inspector = workerInspector(office);
  let previous, loading = false;
  async function refresh() {
    if (loading) return;
    loading = true;
    try {
      const result = await api('/api/v1/offices');
      if (!body.isConnected) return;
      const current = result.ok && result.data.offices.find(o => o.slug === office.slug);
      if (!current) { status.textContent = 'Could not refresh visitors.'; return; }
      dash.office = current;
      fillRows(current.agents, current.role);
      status.textContent = `Updated ${clock(new Date().toISOString())}`;
    } catch { status.textContent = 'Could not refresh visitors.'; }
    finally { loading = false; }
  }
  async function remove(agent) {
    if (!await confirmAction(h,table,'Delete offline session?', `Deleting “${agent.name}” removes its tasks and activity. If this is the connector’s last session, its credential will also be revoked. This cannot be undone.`, 'Delete session')) return;
    try {
      const result = await api(officeUrlFor(office, `/agents/${encodeURIComponent(agent.id)}`), {method:'DELETE'});
      if (result.ok) toast('Offline session deleted.');
      else toast(errorMessage(result,'Could not delete the session.'),'error');
    } catch { toast('Could not delete the session.','error'); }
    await refresh();
  }
  const status = h('small',{class:'muted'},'Refreshing visitors…');
  function fillRows(list, role) {
    const key = JSON.stringify([role,list]);
    if (key === previous) return;
    previous = key;
    body.replaceChildren(
      ...(list.length
        ? list.map((agent) => agentRow(agent, inspector, role === 'owner' ? remove : null))
        : [
            h(
              "tr",
              {},
              h(
                "td",
                { colspan: 7, class: "muted" },
                "No visitors yet. Connect through Workspace Access.",
              ),
            ),
          ]),
    );
    inspector.restore(body);
  }
  fillRows(office.agents ?? [], office.role);
  void refresh();
  tasksPoll = setInterval(() => { if (!document.hidden) void refresh(); }, 5000);

  const table = h(
    "div",
    { class: "table-wrap" },
    h(
      "table",
      { class: "table" },
      h(
        "thead",
        {},
        h(
          "tr",
          {},
          ...["Name / Agent ID", "Status", "Harness", "Project", "Task Inbox", "Pending Tasks", "Actions"].map((label) =>
            h("th", {}, label),
          ),
        ),
      ),
      body,
    ),
  );

  return h(
    "div",
    { class: "page" },
    h(
      "div",
      { class: "page-head" },
      h(
        "div",
        {},
        h("h1", {}, "Agents"),
        h(
          "p",
          {},
          "Current visitors appear here after connecting through Workspace Access.",
        ),
      ),
      sectionButton("About Credentials", "integrations", "link"),
    ),
    h(
      "div",
      { class: "stack" },
      h(
        "section",
        { class: "card" },
        cardHead(
          "Office Visitors",
          "Offline sessions can be removed by the office Owner.",
          "users",
          "tone-plum",
        ),
        table,
        status,
      ),
    ),
    pageFoot(),
  );
}

function integrationsPage() {
  const list = (...items) =>
    h(
      "ul",
      { class: "guide-list" },
      items.map((text) => h("li", {}, text)),
    );
  const topic = (title, ...content) =>
    h(
      "details",
      { class: "guide-topic" },
      h("summary", {}, title),
      h("div", { class: "guide-topic-body" }, ...content),
    );
  const facts = (rows) =>
    h(
      "dl",
      { class: "guide-facts" },
      rows.map(([label, detail]) => h("div", {}, h("dt", {}, label), h("dd", {}, detail))),
    );
  return h(
    "main",
    { class: "page dashboard-page integration-page" },
    h(
      "div",
      { class: "page-head" },
      h(
        "div",
        {},
        h("p", { class: "eyebrow" }, "Connect Your Tools"),
        h("h1", {}, "Integrations"),
        h(
          "p",
          {},
          "Connect real agents through REST. Understand credentials, lifecycle, and what is available today.",
        ),
      ),
      sectionButton("View Visitors", "agents", "users"),
    ),
    h(
      "section",
      { class: "card integration-doc-card" },
      h(
        "div",
        {},
        h("h2", {}, "Integration documentation"),
        h(
          "p",
          {},
          "Install the Pi or Hermes connector, give another engine the public guide, or build a REST sender. Read the examples here before downloading them.",
        ),
      ),
      h('nav', {class:'integration-doc-links', 'aria-label':'Integration paths'},
        ...[['','Public Integrations Guide'],['#pi','Install for Pi'],['#hermes','Install for Hermes'],['#handoff','Instructions for another engine'],['#headers','Build a connector']]
          .map(([anchor,label]) => h('a',{class:'btn btn-quiet',href:`/guides/integrations.html${anchor}`},label))),
    ),
    h("section", { class: "card guide-public" },
      h("h2", {}, "Send an Office Action"),
      h("p", {}, "After opening a visit and sending heartbeat 1, POST this shape to /api/v1/agents/{agent_id}/events with the visit writer. Generate a new UUIDv7 per observation; keep the original ID and sequence on retry."),
      codeBlock(JSON.stringify({ events: [{ event_id: "019e0000-0001-7000-8000-000000000001", seq: 2, type: "note", data: { action: "lookup_file" } }] }, null, 2)),
      h("div", { class: "dashboard-actions" },
        h("a", { href: "/guides/integrations.html#actions" }, "Read the action reference"),
        h("a", { download: "observed-action.json", href: "/downloads/examples/observed-action.json" }, "Download example (JSON)"),
        h("a", { download: "action-v1.json", href: "/schemas/action-v1.json" }, "Download action schema (JSON)")),
    ),
    h(
      "section",
      { class: "card credential-guide" },
      cardHead("Workspace Access", "An office key admits visitors while Open. A trusted connector can join while Closed.", "link", "tone-ocean"),
      h("p", {}, "Owners manage keys under Overview → Office Access. Only a trusted connector with inbox permission can pull visitor tasks."),
    ),
    h(
      "section",
      { class: "card" },
      cardHead(
        "Choose the Right Integration",
        "A skill explains behavior; an adapter sends telemetry.",
        "terminal",
        "tone-sage",
      ),
      h(
        "div",
        { class: "integration-options" },
        ...[
          [
            "REST Adapter",
            "Available Protocol",
            "For daemons, scripts, or any harness with HTTP access. Your adapter owns heartbeats, event sequencing and reconnects. The collector does not run your agent.",
          ],
          [
            "Extension / Plugin",
            "Build Against Harness Hooks",
            "For a coding harness such as Pi or OpenCode. Subscribe to its real session, run and tool events, then forward metadata through REST. The Public Integrations Guide includes a downloadable Pi session extension.",
          ],
          [
            "Agent Skill",
            "Optional Instructions",
            "A skill can instruct an authorized sender to run curl for an observed action. The skill itself provides no background heartbeat, writer credential or execution hook.",
          ],
        ].map(([title, state, text]) =>
          h(
            "article",
            { class: "integration-option" },
            h("h3", {}, title),
            h("span", { class: "badge" }, state),
            h("p", { class: "small muted" }, text),
          ),
        ),
      ),
    ),
    h(
      "section",
      { class: "card guide-chapters", "aria-label": "Integration setup and reference" },
      h("h2", {}, "Setup & Reference"),
      topic(
        "1. Join and Send a First Heartbeat",
        list("Open a visit through the machine session API. Use its writer token and agent ID for heartbeat and event requests.", "The sample Pi extension handles this in memory. No manual agent registration is required."),
      ),
      topic(
        "2. Session Agents, Daemons and Users",
        facts([
          [
            "Session Agent",
            "Represents one distinct harness session. Without an active run it waits; it does not pretend to work. Do not share one agent ID/token across concurrent sessions.",
          ],
          [
            "Daemon / Standby",
            "A persistent worker or service. Standby requires an explicit idle heartbeat and no active run, claimed task, or reported error. Silence is not an idle declaration.",
          ],
          [
            "Unspecified",
            "Lifecycle has not been declared. The office does not guess it from the harness name or animate ambient standby.",
          ],
          [
            "Human Account",
            "Owner, Operator or Viewer access is separate from agent lifecycle. This release uses one office per account; multi-office membership is not implemented.",
          ],
          [
            "Automatic Session Identity",
            "An admitted connector can open independent session identities using the machine API. Use a separate writer for each session. No manual registration is required.",
          ],
        ]),
      ),
      topic(
        "3. What an Extension or Plugin Must Implement",
        list(
          "Read the official lifecycle hooks of the target harness. A harness kind label does not mean its plugin is installed or supported automatically.",
          "Keep an identity/configuration store, a serialized sequence generator, an HTTP sender with a bounded queue, and lifecycle/tool-event mapping. Heartbeats and events share one increasing sequence per identity.",
          "With default presence thresholds, send heartbeats every 10–15 seconds. Adapt to the deployment configuration. Do not make the LLM responsible for this timer.",
          "Report run.started, real tool.call events, human.waiting / human.resumed, and explicit run.finished or run.failed outcomes. A spawn signal alone must not invent a child identity.",
          "Use UUIDv7 event/run IDs. Keep the sequence and retryable event IDs for this visit so retries are idempotent; do not generate a new event ID for each retry. Serialize retries and heartbeats to avoid sequence races.",
          "Bound queues and report dropped telemetry. Coalesce replaceable heartbeats; do not silently discard run-ending events. Close runs on a normal exit when possible. A crash/disconnect does not mean success, and presence expiry does not automatically finish runs.",
          "Forward metadata only: safe labels, status and timing. Never send prompts, conversations, file contents, credentials, or raw tool output.",
        ),
      ),
      topic(
        "4. Human Interaction and the Task Board",
        facts([
          [
            "Available Today",
            "An Owner or Operator creates tasks for a connected visitor and can cancel pending tasks. Viewers can read the board. Only workers granted inbox access can pull their assigned tasks.",
          ],
          [
            "Execution Is Opt-In",
            "An adapter polls when ready, claims a task with a run ID, respects its lease, and reports ack or fail. A task appearing on the board does not make a harness execute it automatically or bypass its permission prompts.",
          ],
          [
            "Waiting for Human",
            "The agent can report that it is waiting, which changes its label and pose. There is no reply, chat, approve/reject or resume-control channel in the dashboard yet. Respond in the original harness; its adapter reports human.resumed.",
          ],
          [
            "Limits",
            `The current pending-task cap is ${dash.office?.inbox_limit ?? 5} per agent. Worker capacity and other per-office rules are not configurable here yet.`,
          ],
        ]),
      ),
      topic(
        "5. Current REST Endpoints",
        codeBlock(
          "POST /api/v1/agents/:id/heartbeat\nPOST /api/v1/agents/:id/events\nGET  /api/v1/agents/:id/inbox\nPOST /api/v1/agents/:id/inbox/:task/claim\nPOST /api/v1/agents/:id/inbox/:task/ack\nPOST /api/v1/agents/:id/inbox/:task/fail",
        ),
        h(
          "p",
          { class: "small muted" },
          "Send Authorization: Bearer <agent-token>. Event batches use { events: [...] }. Claim, ack and fail use run_id; only the current unexpired lease holder can finish a task. The default lease is 60 seconds; use the server's returned lease expiry.",
        ),
        h(
          "p",
          { class: "small muted" },
          "Repository reference: docs/CONTRACT.md. Its Machine Admission and Sessions section covers installation enrollment, expiring writers, reconnect and producer revocation.",
        ),
      ),
      topic(
        "6. Troubleshooting and Access Boundaries",
        facts([
          [
            "401 Unauthorized",
            "Check the base URL, token type and matching agent ID. A member cookie or share link is not an agent credential. Do not paste your token into a support report.",
          ],
          [
            "409 / Invalid Sequence",
            "Check for a second emitter and check the last confirmed sequence for this visit. Inspect rejected event entries and next_seq_hint; HTTP 200 alone does not mean every event was accepted.",
          ],
          [
            "Task Rejected",
            "Check task ownership, run ID, current status, and lease expiry. Do not report success if execution or acknowledgement failed.",
          ],
          [
            "403 Forbidden",
            "The current member role cannot perform that operation, or the resource belongs to another office. Operator is the display name for the existing admin role; permissions have not changed.",
          ],
          [
            "Share Links",
            "Read-only links are a separate credential. They currently expose office metadata, are not a redacted guest projection, and do not provide dashboard access. Expiry/revocation of already-open streams still needs hardening.",
          ],
        ]),
      ),
    ),
    pageFoot(),
  );
}

let tasksPoll = null;

function stopTasksPoll() {
  if (tasksPoll) {
    clearInterval(tasksPoll);
    tasksPoll = null;
  }
}

const KANBAN_COLUMNS = [
  { key: "pending", label: "Todo", tone: "tone-caution" },
  { key: "claimed", label: "Doing", tone: "tone-sage" },
  { key: "done", label: "Done · Last 72 hours", tone: "tone-ocean" },
];

const taskDate = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
function taskTime(label, iso) {
  return iso ? h('span', {}, `${label} `, h('time', { datetime: iso, title: new Date(iso).toLocaleString() }, taskDate.format(new Date(iso)))) : null;
}

function taskText(label, text, key, expanded) {
  if (!text) return null;
  if (text.length <= 110 && !text.includes('\n')) return h('p', {class:'task-copy'}, h('strong',{},`${label}: `),text);
  return h('details', {class:'task-detail', 'data-detail':key, open: expanded.has(key)},
    h('summary',{},label, h('span',{class:'task-preview'},text)),
    h('p',{class:'task-copy'},text));
}

function kanbanCard(task, onCancel, expanded) {
  const tone =
    task.status === "failed"
      ? "tone-clay"
      : task.status === "claimed"
        ? "tone-sage"
        : "tone-caution";

  return h(
    "li",
    { class: `kanban-card ${tone}` },
    h("span", { class: "kanban-title" }, task.title),
    h(
      "span",
      { class: "kanban-meta" },
      h("span", {}, task.agent_name),
      task.agent_simulator ? h("span", { class: "badge badge-demo" }, "Demo") : null,
      Number(task.priority) > 0 ? h("span", { class: "badge" }, `P${task.priority}`) : null,
      task.status === "claimed" && task.lease_expires_at
        ? h("span", { class: "status status-claimed" }, leaseLabel(task))
        : null,
      task.status === "failed" ? h("span", { class: "status status-failed" }, "Failed") : null,
      task.status === "acked" ? h("span", { class: "status status-acked" }, "Acked") : null,
    ),
    taskText('Brief',task.brief,`${task.id}-brief`,expanded),
    task.finished_at ? taskText(task.status==='failed' ? 'Reason' : 'Result', task.result || 'No details reported.', `${task.id}-outcome`,expanded) : null,
    h('div',{class:'task-times tiny muted'},taskTime('Created',task.created_at),
      taskTime(task.status==='failed' ? 'Failed' : 'Completed',task.finished_at)),
    task.status === "pending" && canOperateOffice()
      ? h(
          "span",
          { class: "kanban-actions" },
          h(
            "button",
            {
              class: "btn btn-danger btn-sm",
              type: "button",
              onclick: () => onCancel(task.id),
            },
            icon("x", 13),
            "Cancel",
          ),
        )
      : null,
  );
}

function tasksPage() {
  const office = dash.office;
  if (!office) {
    return h(
      "div",
      { class: "page" },
      h("div", { class: "empty" }, "No office on this account yet."),
    );
  }

  stopTasksPoll();

  const agents = (office.agents ?? []).filter(a=>a.can_receive_tasks);
  const board = h("div", { class: "kanban" });
  const status = h("span", { class: "tiny muted" }, "Loading tasks…");

  let lastPayload;
  const draw = (tasks) => {
    const payload=JSON.stringify(tasks);
    status.textContent = `${tasks.length} task${tasks.length === 1 ? "" : "s"} · refreshed ${clock(new Date().toISOString())}`;
    if (payload===lastPayload && !tasks.some(task=>task.status==='claimed')) return;
    lastPayload=payload;
    const expanded=new Set([...board.querySelectorAll('details[open]')].map(el=>el.dataset.detail));
    const focused=document.activeElement?.closest('details')?.dataset.detail;
    const groups = {
      pending: tasks.filter((task) => task.status === "pending"),
      claimed: tasks.filter((task) => task.status === "claimed"),
      done: tasks.filter((task) => task.status === "acked" || task.status === "failed"),
    };

    board.replaceChildren(
      ...KANBAN_COLUMNS.map((column) =>
        h(
          "section",
          { class: `kanban-col ${column.tone}` },
          h(
            "div",
            { class: "kanban-head" },
            h("span", {}, column.label),
            h("span", {}, String(groups[column.key].length)),
          ),
          groups[column.key].length
            ? h(
                "ul",
                { class: "kanban-list" },
                ...groups[column.key].map((task) => kanbanCard(task, cancel, expanded)),
              )
            : h("p", { class: "tiny muted" }, "Nothing here."),
        ),
      ),
    );

    if (focused) board.querySelector(`[data-detail="${CSS.escape(focused)}"] summary`)?.focus({preventScroll:true});
  };

  const load = async () => {
    const result = await api(officeUrlFor(office, "/tasks"));
    if (!result.ok) {
      status.textContent = errorMessage(result, "Could not load tasks");
      return;
    }
    draw(result.data.tasks ?? []);
  };

  const cancel = async (taskId) => {
    const result = await api(officeUrlFor(office, `/tasks/${taskId}/cancel`), { method: "POST" });
    if (!result.ok) {
      toast(errorMessage(result, "Could not cancel the task"), "error");
      return;
    }
    toast("Task cancelled.");
    await load();
  };

  const agentSelect = h(
    "select",
    { class: "input", name: "agent_id", required: true },
    ...agents.map((agent) => h("option", { value: agent.id }, agent.name)),
  );
  const title = textInput({
    name: "title",
    placeholder: "Refactor auth middleware",
    required: true,
  });
  const brief = textInput({ name: "brief", placeholder: "one line of context" });
  const priority = h(
    "select",
    { class: "input", name: "priority" },
    ...[0, 1, 2, 3, 4, 5].map((level) => h("option", { value: String(level) }, `P${level}`)),
  );
  const button = submitButton("Add Task", "plus");

  const form = h(
    "form",
    {
      class: "stack",
      onsubmit: withBusy(button, async () => {
        const result = await api(officeUrlFor(office, "/tasks"), {
          method: "POST",
          body: {
            agent_id: agentSelect.value,
            title: title.value.trim(),
            brief: brief.value.trim() || null,
            priority: Number(priority.value),
          },
        });

        if (!result.ok) {
          toast(errorMessage(result, "Could not add the task"), "error");
          return;
        }
        toast("Task added.");
        title.value = "";
        brief.value = "";
        await load();
      }),
    },
    field("Agent", agentSelect),
    field("Title", title),
    field("Brief", brief, "Optional, one line"),
    field("Priority", priority),
    button,
  );

  void load();
  tasksPoll = setInterval(() => {
    if (!document.hidden) void load();
  }, 5000);

  return h(
    "div",
    { class: "page" },
    h(
      "div",
      { class: "page-head" },
      h(
        "div",
        {},
        h("h1", {}, "Tasks"),
        h("p", {}, "You hand out work. An agent claims it with a lease, then acks or fails."),
      ),
      status,
    ),
    h(
      "div",
      { class: "split" },
      h(
        "section",
        { class: "card" },
        cardHead("Board", "Todo, Doing, and finished work.", "inbox", "tone-ocean"),
        board,
        !agents.length && h(
              "div",
              { class: "empty" },
              icon("users", 20),
              h("span", {}, "Connect an inbox-enabled trusted visitor first."),
            ),
      ),
      h(
        "section",
        { class: "card" },
        cardHead("Add a Task", "Five pending tasks per agent, no more.", "plus", "tone-sage"),
        canOperateOffice()
          ? agents.length
            ? form
            : h("p", { class: "small muted" }, "No agents to assign to yet.")
          : h(
              "p",
              { class: "small muted" },
              "Viewer access is read-only. An Owner or Operator can assign tasks.",
            ),
      ),
    ),
    pageFoot(),
  );
}

function renderDashboard() {
  stopTasksPoll();

  const page =
    dash.section === "workspace" && dash.office?.role === "owner"
      ? workspaceAccessPage(dash.office, {
          h,
          api,
          officeUrlFor,
          sectionButton,
          cardHead,
          revealToken,
          errorMessage,
        })
      : dash.section === "agents"
        ? agentsPage()
        : dash.section === "integrations"
          ? integrationsPage()
          : dash.section === "tasks"
            ? tasksPage()
            : overviewPage();
  dashboardShell(page);
}

async function loadOffice() {
  const result = await api("/api/v1/offices");
  dash.office = result.ok ? (result.data.offices[0] ?? null) : null;
}

async function startDashboard() {
  const config = await api("/api/v1/config").catch(() => ({ ok: false, data: null }));
  dash.version = config.ok && typeof config.data?.version === "string" ? config.data.version : "";
  if (config.ok && config.data?.needs_setup) {
    await renderSetup();
    return;
  }

  const me = await api("/api/v1/auth/me").catch(() => ({ ok: false }));
  if (!me.ok) {
    await renderLogin(config.ok ? config.data : null);
    return;
  }

  dash.me = me.data;
  await loadOffice();
  dash.section = "overview";
  renderDashboard();
}

/* ---------------------------------------------------------------- office view */

function stat(label, value, iconName, tone = "") {
  return h(
    "div",
    { class: "stat" },
    h("span", { class: `stat-icon ${tone}` }, icon(iconName, 17)),
    h("div", {}, h("dt", {}, label), h("dd", {}, String(value))),
  );
}

function renderStats(counters) {
  const value = counters ?? { agents_online: 0, runs_active: 0, tasks_pending: 0 };
  nodes.officeStats.replaceChildren(
    stat("Online", value.agents_online, "pulse"),
    stat("Active Runs", value.runs_active, "terminal", "stat-icon-info"),
    stat("Pending Tasks", value.tasks_pending, "inbox", "stat-icon-warn"),
  );
}

function agentChip(agent) {
  const presence = agent.presence ?? {};
  const activityLabel = eventCue(agent)?.label ?? stationActivity(agent).label;
  const isSelected = agent.id === expandedAgentId;
  return h(
    "li",
    {},
    h(
      "button",
      {
        type: "button",
        class: "chip",
        "aria-current": isSelected ? "true" : null,
        title: presence.task ?? agent.name,
        onclick: () => selectAgent(agent.id),
      },
      h("span", { class: `dot dot-${presence.state ?? "lobby"}`, "aria-hidden": "true" }),
      h("span", { class: "chip-name" }, agent.name),
      agent.simulator ? h("span", { class: "badge badge-demo" }, "Demo") : null,
      h("span", { class: "chip-action" }, activityLabel),
      presence.task && presence.task !== activityLabel
        ? h("span", { class: "chip-task" }, presence.task)
        : null,
    ),
  );
}

function renderRooms(agents) {
  const byRoom = new Map(BOARD_STATIONS.map(({ room }) => [room, []]));
  for (const agent of agents) byRoom.get(boardStation(agent)).push(agent);

  nodes.rooms.replaceChildren(
    ...BOARD_STATIONS.map(({ room, label }) => {
      const occupants = byRoom.get(room);
      return h(
        "section",
        {
          "data-room": room,
          class: `room tone-${ROOM_TONE[room] ?? "sage"} ${
            occupants.length ? "room-occupied" : "room-empty"
          }`,
        },
        h(
          "div",
          { class: "room-head" },
          icon(ROOM_ICON[room] ?? "grid", 15, "icon room-icon"),
          h("h2", {}, label),
          h("span", { class: "room-count" }, occupants.length ? String(occupants.length) : "–"),
        ),
        occupants.length
          ? h("ul", { class: "occupants" }, occupants.map(agentChip))
          : h("p", { class: "tiny muted" }, "Empty"),
      );
    }),
  );
}

const STATE_LABEL = {
  online: "Reporting",
  stale: "No signal",
  offline: "Offline",
  lobby: "Never reported",
};

/** Deterministic colour per agent, so the same agent has the same colour everywhere. */
function identityHue(id) {
  let hash = 0;
  for (let index = 0; index < id.length; index++) {
    hash = (hash * 31 + id.charCodeAt(index)) % 360;
  }
  return hash;
}

function identityTile(agent) {
  const hash = identityHue(agent.id);

  const parts = String(agent.name ?? "?")
    .split(/[-_\s]+/)
    .filter(Boolean);
  const initials = ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? parts[0]?.[1] ?? "")).toUpperCase();

  return h(
    "span",
    { class: "identity", style: `--id-hue:${hash}`, "aria-hidden": "true" },
    initials,
  );
}

function leaseLabel(task) {
  if (task.status !== "claimed" || !task.lease_expires_at) return task.status;
  const ms = Date.parse(task.lease_expires_at) - Date.now();
  if (!Number.isFinite(ms)) return task.status;
  return `${task.status} · ${Math.max(0, Math.round(ms / 1000))}s`;
}

function agentBody(agent, peers = snapshot?.agents ?? [], inspector = false) {
  const presence = agent.presence ?? {};
  const runs = agent.runs ?? [];
  const tasks = agent.tasks ?? [];

  const signal = agent.signal;
  const identity = [
    ["Harness", harnessLabel(agent.kind)],
    ["Lifecycle", metadataLabel(agent.lifecycle)],
    ["Project", agent.project ?? "Unassigned"],
    ["Room", ROOM_LABEL[presence.room] ?? presence.room ?? "-"],
  ];
  const activity = [
    ["Presence", STATE_LABEL[presence.state ?? "lobby"] ?? presence.state ?? "-"],
    ["Activity", presence.activity || stationActivity(agent).label],
    ...(signal?.action ? [[signal.action_origin === 'default' ? "Default Action" : "Reported Action", metadataLabel(signal.action)]] : []),
    ...(signal?.tool_source ? [["Reported Tool Source", metadataLabel(signal.tool_source)]] : []),
    ["Reported State", metadataLabel(presence.heartbeat_state)],
    ...(presence.task ? [["Current Task", presence.task]] : []),
  ];
  const timing = [
    ["Last Seen", ago(presence.last_seen_at)],
    ["Online Since", clock(presence.online_since)],
    [
      "Latest Event",
      signal
        ? `${signal.type}${signal.detail ? ` (${signal.detail})` : ""} · ${ago(signal.at)}`
        : "No event yet",
    ],
  ];

  const facts = rows => h('dl',{class:'facts'},rows.flatMap(([key,value])=>[h('dt',{},key),h('dd',{},String(value))]));
  return h(
    'div', {class: inspector ? 'inspector-content' : 'acc-body'},
    inspector ? h('div',{class:'inspector-groups'},
      [['Session',identity],['Activity',activity],['Timing',timing]].map(([heading,rows])=>
        h('section',{},h('h4',{},heading),facts(rows)))) : facts([...identity,...activity,...timing]),
    inspector && !runs.length && !tasks.length ? h('p',{class:'inspector-workload small muted'},'No active runs or tasks.') : h("div", { class: "stack" },
    h("h3", {}, `Active Runs (${runs.length})`),
    runs.length
      ? h(
          "ul",
          { class: "list active-runs" },
          ...runs.map((run) =>
            h(
              "li",
              {},
              h("span", { class: "title" }, run.title ?? "(untitled)"),
              h("span", { class: "run-meta" },
                run.parent_run_id ? h("span", { class: "badge" }, "Subagent") : null,
                h("span", { class: "tiny muted" }, ago(run.started_at))),
              run.parent_run_id
                ? h(
                    "span",
                    { class: "run-parent tiny muted" },
                    `Parent: ${peers.find((item) => item.id === run.parent_agent_id)?.name ?? "Known Run"}`,
                  )
                : null,
            ),
          ),
        )
      : h("p", { class: "small muted" }, "Standing by."),
    h("h3", {}, `Tasks (${tasks.length})`),
    tasks.length
      ? h(
          "ul",
          { class: "list" },
          ...tasks.map((task) =>
            h(
              "li",
              {},
              h("span", { class: "title" }, task.title),
              h("span", { class: `status status-${task.status}` }, leaseLabel(task)),
            ),
          ),
        )
      : h("p", { class: "small muted" }, "No tasks yet.")),
  );
}

function accordionItem(agent, open) {
  const presence = agent.presence ?? {};
  return h(
    "li",
    { class: open ? "acc-item acc-open" : "acc-item" },
    h(
      "button",
      {
        class: "acc-head",
        type: "button",
        "aria-expanded": open ? "true" : "false",
        "data-agent-id": agent.id,
        onclick: () => selectAgent(agent.id),
      },
      identityTile(agent),
      h(
        "span",
        { class: "acc-main" },
        h("span", { class: "acc-name" }, agent.name),
        h(
          "span",
          { class: "acc-meta" },
          h("span", { class: `dot dot-${presence.state ?? "lobby"}`, "aria-hidden": "true" }),
          h(
            "span",
            {},
            `${STATE_LABEL[presence.state ?? "lobby"]} · ${ROOM_LABEL[presence.room] ?? presence.room ?? "-"}`,
          ),
        ),
      ),
      agent.simulator ? h("span", { class: "badge badge-demo" }, "Demo") : null,
    ),
    open ? agentBody(agent) : null,
  );
}

function renderPanel(agents) {
  const focusedAgent = nodes.detail.contains(document.activeElement)
    ? document.activeElement.dataset.agentId
    : null;
  const focusedAuto = document.activeElement?.hasAttribute("data-auto-selection");
  const hiddenChildren = sceneEntities(agents).reduce(
    (count, actor) => count + (actor.hiddenChildRuns ?? 0),
    0,
  );
  if (agents.length === 0) {
    lockedAgentId = null;
    expandedAgentId = null;
    nodes.detail.classList.add("panel-empty");
    nodes.detail.replaceChildren(
      icon("users", 24, "icon muted"),
      h("h2", {}, "No agents yet"),
      h("p", { class: "small muted" }, "Connect a visitor using Workspace Access, or start the demo."),
    );
    return;
  }

  const sorted = agentActivityOrder(agents);
  if (!sorted.some((agent) => agent.id === lockedAgentId)) lockedAgentId = null;
  expandedAgentId = lockedAgentId ?? sorted[0].id;

  nodes.detail.classList.remove("panel-empty");
  nodes.detail.replaceChildren(
    h(
      "div",
      { class: "row spread" },
      h("h2", {}, `Agents (${sorted.length})`),
      h(
        "button",
        {
          type: "button",
          class: "btn btn-quiet btn-sm",
          "data-auto-selection": "",
          "aria-pressed": String(!lockedAgentId),
          onclick: () => {
            lockedAgentId = null;
            render();
          },
        },
        lockedAgentId ? "Locked · Resume Auto" : "Auto",
      ),
    ),
    h(
      "p",
      { class: "tiny muted" },
      lockedAgentId
        ? "Selection locked. Select it again to resume auto-follow."
        : "Following active work by priority, then latest signal.",
    ),
    ...(hiddenChildren
      ? [
          h(
            "p",
            { class: "tiny muted" },
            `+${hiddenChildren} active child runs not drawn. All remain listed under their owners.`,
          ),
        ]
      : []),
    h(
      "ul",
      { class: "accordion" },
      ...sorted.map((agent) => accordionItem(agent, agent.id === expandedAgentId)),
    ),
  );
  if (focusedAuto)
    nodes.detail.querySelector("[data-auto-selection]")?.focus({ preventScroll: true });
  else if (focusedAgent)
    [...nodes.detail.querySelectorAll("[data-agent-id]")]
      .find((button) => button.dataset.agentId === focusedAgent)
      ?.focus({ preventScroll: true });
}

function renderProjects(agents) {
  const list = document.getElementById("projectActivity");
  if (!list) return;
  const focused = list.contains(document.activeElement)
    ? document.activeElement.dataset.project
    : null;
  const projects = projectActivity(agents);
  list.replaceChildren(
    ...projects.map((project) => {
      const button = h(
        "button",
        {
          type: "button",
          class: "project-card",
          "data-project": project.key,
          title: "Select the project's priority reporting agent",
          onclick: () => selectAgent(project.agentId),
        },
        h(
          "span",
          { class: "row spread" },
          h("strong", { class: "project-name", title: project.name }, project.name),
          h(
            "span",
            { class: "badge" },
            project.priority === null ? "No Open Task" : `Priority ${project.priority}`,
          ),
        ),
        h("span", { class: "project-summary", title: project.summary }, project.summary),
        h(
          "span",
          { class: "project-reporters" },
          project.reporters.map((reporter) =>
            h("span", {}, `${reporter.name} · ${reporter.activity}`),
          ),
        ),
        project.agents > project.reporters.length
          ? h(
              "span",
              { class: "tiny muted" },
              `+${project.agents - project.reporters.length} More Agents`,
            )
          : null,
        h(
          "span",
          { class: "project-event tiny muted", "data-event-id": project.latestEvent?.id ?? "" },
          project.latestEvent
            ? `Latest: ${project.latestEvent.agentName} · ${project.latestEvent.type}${project.latestEvent.detail ? ` · ${project.latestEvent.detail}` : ""} · ${ago(project.latestEvent.at)}`
            : "No Recorded Events",
        ),
        h(
          "span",
          { class: "tiny muted" },
          `${project.agents} agent${project.agents === 1 ? "" : "s"} · ${project.openTasks} open tasks`,
        ),
        h("span", { class: "sr-only" }, "Select reporting agent."),
        project.attention ? h("span", { class: "tiny icon-warn" }, "Error in Latest Report") : null,
      );
      return h("li", {}, button);
    }),
  );
  if (!projects.length)
    list.append(h("li", { class: "small muted" }, "Projects appear when agents register."));
  if (focused !== null)
    [...list.querySelectorAll("button")]
      .find((button) => button.dataset.project === focused)
      ?.focus({ preventScroll: true });
}

function render() {
  if (!snapshot) return;
  const agents = snapshot.agents ?? [];
  if (requestedAgentId) {
    if (agents.some((agent) => agent.id === requestedAgentId)) lockedAgentId = requestedAgentId;
    else toast("The requested agent is not in this office. Showing automatic selection.", "info");
    requestedAgentId = null;
  }

  nodes.officeName.textContent = snapshot.org?.name || "Office";
  nodes.officeSlug.textContent = `/${SLUG}`;
  nodes.officeMeta.textContent = `${agents.length} agent${agents.length === 1 ? "" : "s"}`;
  document.title = `${snapshot.org?.name || "Office"} · AgentMiniOffice`;

  renderStats(snapshot.counters);
  renderPanel(agents);
  renderRooms(agents.filter(a=>a.presence?.state!=='offline'));
  renderProjects(agents);

  if (officeView === "3d") pushScene();
}

function sceneAgents() {
  return sceneEntities(snapshot?.agents ?? []).map((agent) => ({
    ...agent,
    identityHue: identityHue(agent.id),
  }));
}

/** The 3D module is fetched only when somebody asks for it. */
async function ensureScene() {
  if (scene) return scene;
  if (!scenePromise) {
    scenePromise = import("./scene3d.js")
      .then((module) => {
        scene = module.createOfficeScene({
          container: document.getElementById("stageView"),
          onSelect: selectAgent,
        });
        return scene;
      })
      .catch((error) => {
        scenePromise = null;
        throw error;
      });
  }
  return scenePromise;
}

function setView(view) {
  officeView = view === "3d" ? "3d" : "2d";
  localStorage.setItem(VIEW_KEY, officeView);
  syncView();
}

function syncView() {
  const board = nodes.rooms;
  const stage = document.getElementById("stageView");
  const is3d = officeView === "3d";

  if (board) board.hidden = is3d;
  if (stage) stage.hidden = !is3d;

  for (const button of document.querySelectorAll("[data-view]")) {
    const active = button.dataset.view === (is3d ? "3d" : "2d");
    button.setAttribute("aria-pressed", active ? "true" : "false");
  }

  scene?.setActive(is3d);
  if (!is3d) return;

  ensureScene()
    .then(() => {
      // The user can switch back while the lazy module is still loading.
      scene.setActive(officeView === "3d");
      if (officeView !== "3d") return;
      pushScene();
    })
    .catch((error) => {
      toast(`3D view could not load: ${error.message}`, "error");
      setView("2d");
    });
}

/** Reconcile actors without rebuilding furniture; include content-only telemetry changes. */
function pushScene() {
  if (!scene) return;
  if(sceneTimer !== null) return; // Coalesce on the leading window; busy SSE traffic must not starve avatars.
  sceneTimer = setTimeout(() => {
    sceneTimer=null;
    const list = sceneAgents();
    if (!scene) return;
    scene.update(list, snapshot?.org?.name);
    scene.select(expandedAgentId);
  }, 180);
}

function officeApi(suffix) {
  return `/api/v1/offices/${encodeURIComponent(SLUG)}${suffix}`;
}

function showOfficeNotice(title, message, extra) {
  boot.hidden = false;
  boot.replaceChildren(
    h(
      "div",
      { class: "auth-card on-top" },
      h("h2", {}, title),
      h("p", { class: "lead" }, message),
      extra ?? null,
      h("a", { class: "btn btn-block", href: "/dashboard" }, "Go to control room"),
    ),
  );
}

function hideNotice() {
  boot.hidden = true;
}

async function loadSnapshot() {
  const query = share ? `?share=${encodeURIComponent(share)}` : "";
  const result = await api(officeApi(`/snapshot${query}`));

  if (result.status === 401) {
    showOfficeNotice(
      "This office is private",
      "Sign in on the control room, or open it with a read-only share link.",
      h(
        "p",
        { class: "tiny muted" },
        "Signed in already? Then this link belongs to another account.",
      ),
    );
    connectionStatus('down','Not authorized');
    return false;
  }

  if (result.status === 404) {
    showOfficeNotice("No office with that name", `Nothing lives at /${SLUG}.`);
    connectionStatus('down','Not found');
    return false;
  }

  if (!result.ok) throw new Error(`snapshot returned ${result.status}`);

  snapshot = result.data;
  hideNotice();
  render();
  return true;
}

let refetchTimer = null;

function refetchSoon() {
  clearTimeout(refetchTimer);
  refetchTimer = setTimeout(() => {
    loadSnapshot().catch(() => {
      connectionStatus('down','Collector unreachable');
    });
  }, 250);
}

function applyPresence(patch) {
  if (!snapshot) return false;
  const agent = snapshot.agents.find((entry) => entry.id === patch.agent_id);
  if (!agent) return false;
  agent.presence = { ...agent.presence, ...patch };
  render();
  return true;
}

function connectionStatus(state, message) {
  nodes.statusLine.dataset.state = state;
  nodes.statusLine.textContent = message;
}

function openStream() {
  if (!window.EventSource) {
    connectionStatus('down','Live updates unavailable');
    return;
  }

  const query = share ? `?share=${encodeURIComponent(share)}` : "";
  stream?.close();
  stream = new EventSource(officeApi(`/stream${query}`));

  stream.addEventListener('access-revoked', () => {
    stream?.close();
    // Discard the previous office DOM and recheck access (including any current login).
    location.reload();
  });
  stream.addEventListener("snapshot", (event) => {
    snapshot = JSON.parse(event.data);
    hideNotice();
    render();
    connectionStatus('live',`Live · updated ${clock(snapshot.server_time)}`);
  });

  stream.addEventListener("presence", (event) => {
    if (!applyPresence(JSON.parse(event.data))) refetchSoon();
  });

  stream.addEventListener("counters", (event) => {
    if (!snapshot) return;
    const counters = JSON.parse(event.data);
    snapshot.counters = {
      agents_online: counters.agents_online,
      runs_active: counters.runs_active,
      tasks_pending: counters.tasks_pending,
    };
    renderStats(snapshot.counters);
  });

  stream.addEventListener("signal", (event) => {
    const patch = JSON.parse(event.data);
    const agent = snapshot?.agents?.find((entry) => entry.id === patch.agent_id);
    if (!agent) {
      refetchSoon();
      return;
    }
    agent.signal = patch.signal;
    render();
  });

  stream.addEventListener("roster", refetchSoon);
  stream.addEventListener("project", refetchSoon);
  stream.addEventListener("run", refetchSoon);
  stream.addEventListener("task", refetchSoon);

  stream.addEventListener("open", () => {
    connectionStatus('live','Live · connected');
  });

  stream.addEventListener("error", () => {
    stream?.readyState === EventSource.CLOSED ? connectionStatus('down','Disconnected') : connectionStatus('retry','Reconnecting');
  });
}

let officeMember = false;

/**
 * A share link visitor has no account, so a "back to control room" button would lead
 * nowhere. Only show it to a signed in member of this office.
 */
async function resolveOfficeNav() {
  const slot = document.getElementById("officeNav");
  if (!slot) return;

  const me = await api("/api/v1/auth/me").catch(() => ({ ok: false }));
  officeMember = Boolean(me.ok && me.data?.office?.slug === SLUG);

  if (!officeMember) {
    slot.replaceChildren();
    return;
  }
  slot.replaceChildren(
    h(
      "a",
      { class: "btn btn-quiet btn-sm", href: "/dashboard" },
      icon("back", 15),
      "Back to Control Room",
    ),
  );
}

async function startOffice() {
  officeRoot.hidden = false;
  dashboardRoot.hidden = true;
  boot.hidden = true;

  connectionStatus('connecting','Connecting');
  void resolveOfficeNav();
  syncView();

  try {
    const ok = await loadSnapshot();
    if (ok) openStream();
  } catch {
    connectionStatus('down','Collector unreachable');
  }
}

/* ---------------------------------------------------------------------- boot */

document.addEventListener("visibilitychange", () => {
  if (MODE !== "office") return;
  if (document.hidden) {
    stream?.close();
    stream = null;
  } else {
    startOffice();
  }
});

window.addEventListener("pagehide", (event) => {
  clearTimeout(sceneTimer);
  stream?.close();
  if (event.persisted) scene?.setActive(false);
  else scene?.dispose();
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted && MODE === "office") startOffice();
});

if (MODE === "dashboard") startDashboard();
else startOffice();
