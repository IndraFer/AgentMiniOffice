// AgentMiniOffice · MIT. Install the package at extensions/agent-mini-office/index.ts.
// The same entry also ships as a single-file compatibility download.
import { createHash, randomBytes } from "node:crypto";
import {
  linkSync,
  lstatSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type Proof = { writer: string; agent?: string; event?: string };
type ToolSource = 'builtin' | 'builtin-extension' | 'extension' | 'sdk' | 'unknown';
type Signal = { type: string; run_id?: string; data: { tool?: string; tool_source?: ToolSource; action?: string; variant?: string; ok?: boolean; kind?: string; parent_run_id?:string; title?:string; avatar_label?:string; options?:string[] } };
type ToolChoice = string | {action:string; variant:string};
type ToolRules = Partial<Record<ToolSource, Record<string,ToolChoice>>>;
// Public metadata allowlist; legacy single-file installs also use these fallback actions.
// Package installs take all action choices from actions.json, never from tool arguments.
const legacyDefaults: ToolRules = {
  builtin:{read:'read',grep:'search_content',find:'lookup_file',ls:'lookup_file',bash:'use_tools',powershell:'use_tools',edit:'write',write:'write'},
  extension:{ffgrep:'search_content',fffind:'lookup_file',update_plan:'plan',document_screenshot:'print'},
};
const object = (v:unknown): v is Record<string,unknown> => !!v && typeof v==='object' && !Array.isArray(v);
function readVariantCatalogue(mapFile:string): Record<string,unknown> {
  const file=join(dirname(mapFile),'action-v1.json');
  const stat=lstatSync(file,{throwIfNoEntry:false});
  if (!stat?.isFile() || stat.size>262144) throw Error();
  const entries:unknown=JSON.parse(readFileSync(file,'utf8'))['x-actions'];
  if (!object(entries)) throw Error();
  return entries;
}
function readRules(file:string, packaged:boolean): ToolRules {
  try {
    const stat=lstatSync(file); if (!stat.isFile() || stat.size>65536) throw Error();
    const doc:unknown=JSON.parse(readFileSync(file,'utf8'));
    if (!object(doc) || doc.version!==1 || ('$schema' in doc && typeof doc.$schema!=='string') || !object(doc.tools) || Object.keys(doc).some(k=>!['version','tools','$schema'].includes(k))) throw Error();
    const rules: ToolRules={};
    let catalog: Record<string,unknown> | undefined;
    const id=(v:unknown):v is string=>typeof v==='string' && /^[a-z][a-z0-9_]{0,47}$/.test(v);
    for(const [origin,entries] of Object.entries(doc.tools)) {
      if (!['builtin','builtin-extension','extension','sdk','unknown'].includes(origin) || !object(entries)) throw Error();
      const table:Record<string,ToolChoice>=Object.create(null);
      for (const [name,choice] of Object.entries(entries)) {
        if (!/^[A-Za-z0-9_.:-]{1,96}$/.test(name)) throw Error();
        if (id(choice)) { table[name]=choice; continue; }
        if (!object(choice) || !id(choice.action) || !id(choice.variant) || Object.keys(choice).length!==2) throw Error();
        catalog ??= readVariantCatalogue(file);
        const entry=catalog[choice.action];
        if (!object(entry) || !Array.isArray(entry.variants) || !entry.variants.some(v=>object(v) && v.id===choice.variant)) throw Error();
        table[name]={action:choice.action,variant:choice.variant};
      }
      rules[origin as ToolSource]=table;
    }
    return rules;
  } catch (err) {
    if (packaged) console.warn('AgentMiniOffice: actions.json missing or invalid; reporting unmapped tools as other.');
    else if ((err as NodeJS.ErrnoException)?.code!=='ENOENT') console.warn('AgentMiniOffice: invalid action map; using built-in defaults.');
    return {};
  }
}

// Pi extensions can override a core name. Classify the effective registration, not the name alone.
function describeTool(pi: ExtensionAPI, name: string, rules: ToolRules, packaged:boolean) {
  const info = pi.getAllTools().find(t => t.name === name)?.sourceInfo;
  const tool_source: ToolSource = !info?.source ? 'unknown' : info.source === 'builtin'
    ? (info.path === `builtin:${name}` ? 'builtin' : 'builtin-extension')
    : info.source === 'sdk' ? 'sdk' : 'extension';
  const table = legacyDefaults[tool_source];
  const known = !!table && Object.hasOwn(table,name);
  const choice = rules[tool_source]?.[name] ?? (!packaged && known ? table[name] : 'other');
  return {tool: known ? name : 'other', tool_source, ...(typeof choice==='string' ? {action:choice} : choice)};
} 
type Config = {
  enabled: boolean;
  panelUrl: string;
  token: string;
  maxRetries?: number;

};
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const secret = (kind: string) => `amo_${kind}_${randomBytes(32).toString("base64url")}`;
const validToken = (s: string) => /^amo_(join|producer)_[A-Za-z0-9_-]{43}$/.test(s);
function origin(value: string) {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    )
  )
    throw Error("Enter an HTTPS origin, or use HTTP on loopback.");
  return url.origin;
}
function projectLabel(name: string | undefined, cwd: string) {
  const clean = (s: string) =>
    Array.from(s)
      .filter((ch) => ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) !== 127)
      .join("")
      .trim();
  return (clean(name ?? "") || clean(basename(cwd)) || "Workspace")
    .slice(0, 60)
    .replace(/[\uD800-\uDBFF]$/u, "")
    .trimEnd();
}
function eventId() {
  const b = randomBytes(16);
  b.writeUIntBE(Date.now(), 0, 6);
  b[6] = (b[6] & 15) | 112;
  b[8] = (b[8] & 63) | 128;
  return b
    .toString("hex")
    .replace(/^(........)(....)(....)(....)(............)$/, "$1-$2-$3-$4-$5");
}
// Unique markers prevent two writers owning a saved session. Only reap a confirmed dead PID.
function lock(path: string) {
  const dir = dirname(path),
    prefix = `${basename(path)}.lock-`,
    mine = `${prefix}${process.pid}-${randomBytes(8).toString("hex")}`;
  writeFileSync(join(dir, mine), "", { flag: "wx", mode: 0o600 });
  const release = () => rmSync(join(dir, mine), { force: true });
  try {
    for (const peer of readdirSync(dir)) {
      if (!peer.startsWith(prefix) || peer === mine) continue;
      const pid = Number(peer.slice(prefix.length).split("-")[0]);
      if (Number.isSafeInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ESRCH") {
            rmSync(join(dir, peer), { force: true });
            continue;
          }
        }
      }
      release();
      return undefined;
    }
    return release;
  } catch (e) {
    release();
    throw e;
  }
}
function settings(root: string) {
  const path = join(root, "agent-mini-office.json");
  function checkRoot() {
    const dir = lstatSync(root);
    if (!dir.isDirectory() || dir.mode & 0o022 || dir.uid !== process.getuid?.())
      throw Error("Unsafe Pi root");
    return dir;
  }
  const dir = checkRoot();
  const legacy = join(root, "agentminioffice.json");
  const old = lstatSync(legacy, { throwIfNoEntry: false });
  if (old && !lstatSync(path, { throwIfNoEntry: false })) {
    if (!old.isFile() || old.uid !== dir.uid || old.mode & 0o077)
      throw Error("Cannot migrate a non-private legacy AgentMiniOffice configuration.");
    if (
      readdirSync(root).some((n) => n.startsWith("agentminioffice.json.") && n.includes(".lock-"))
    )
      throw Error("Close old Pi sessions before migrating the AgentMiniOffice configuration.");
    // Never overwrite settings created by another process or editor.
    try {
      linkSync(legacy, path);
    } catch (e) {
      if (
        (e as NodeJS.ErrnoException).code !== "EEXIST" &&
        !lstatSync(path, { throwIfNoEntry: false })
      )
        throw e;
    }
    if (lstatSync(path).ino === old.ino) rmSync(legacy, { force: true });
  }
  if (!lstatSync(path, { throwIfNoEntry: false })) {
    const defaults: Config = {
      enabled: false,
      panelUrl: "http://127.0.0.1:3000",
      token: "",
      maxRetries: 3,
    };
    const tmp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      writeFileSync(tmp, `${JSON.stringify(defaults, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      // Publish the complete defaults only if no other session or editor created the file first.
      try {
        linkSync(tmp, path);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
    } finally {
      rmSync(tmp, { force: true });
    }
  }
  function read(): Config {
    const dir = checkRoot();
    const st = lstatSync(path);
    if (!st.isFile() || st.mode & 0o077 || st.uid !== dir.uid)
      throw Error("Private configuration required");
    const c = JSON.parse(readFileSync(path, "utf8"));
    if (
      typeof c.enabled !== "boolean" ||
      typeof c.panelUrl !== "string" ||
      typeof c.token !== "string"
    )
      throw Error("Invalid configuration");
    return c;
  }
  async function update<T>(change: (c: Config) => T) {
    read(); // Validate the root before creating a marker.
    for (let i = 0; i < 24; i++) {
      const release = lock(path);
      if (!release) {
        await new Promise((r) => setTimeout(r, 5 + Math.random() * 20));
        continue;
      }
      const tmp = `${path}.tmp`;
      try {
        const c = read(),
          result = change(c);
        rmSync(tmp, { force: true });
        writeFileSync(tmp, JSON.stringify(c, null, 2) + "\n", {
          flag: "wx",
          mode: 0o600,
          flush: true,
        });
        renameSync(tmp, path);
        return result;
      } finally {
        try {
          rmSync(tmp, { force: true });
        } finally {
          release();
        }
      }
    }
    throw Error("Configuration is busy");
  }
  // Rewrite legacy settings once, under the same lock as menu changes. No telemetry writes this file.
  const clean = (c: Config) => ({enabled:c.enabled,panelUrl:c.panelUrl,token:c.token,maxRetries:c.maxRetries ?? 3});
  const initial=read();
  const ready = !('maxRetries' in initial) || Object.keys(initial).some(k=>!(k in clean(initial))) ? update(c=>{const values=clean(c);for(const k of Object.keys(c)) delete (c as Record<string,unknown>)[k];Object.assign(c,values);}) : Promise.resolve();
  return { read, update, ready }; 
}
class HttpError extends Error {
  constructor(
    readonly status: number,
    operation: string,
  ) {
    super(`${operation}: ${status ? `HTTP ${status}` : "network request not confirmed"}`);
  }
}
const binding = (c: Config) =>
  digest(JSON.stringify([c.enabled, c.panelUrl, c.token, c.maxRetries ?? 3]));

export default function agentMiniOffice(pi: ExtensionAPI) {
  const entry=fileURLToPath(import.meta.url), directory=dirname(entry);
  const packaged=basename(entry)==='index.ts';
  const root=dirname(packaged ? dirname(directory) : directory);
  const config=settings(root);
  const rules=readRules(packaged ? join(directory,'actions.json') : join(root,'agent-mini-office.actions.json'), packaged);
  // A process restart starts a new visit. Network retries reuse the in-memory writer.
  const session = eventId();
  let settingsKey = '', guestProducer = '', enrolled = false, waiting = false;
  let compacting = false, inboxGranted = false;
  // Private, visit-bound state. A transport retry must not submit the user message again.
  type PanelTask = {id:string; run:string; prompt:string; phase:'claim'|'sent'|'running'; renewAt:number; startBy:number; receipt:boolean; outcome?:'ack'|'fail'};
  let panelTask: PanelTask | undefined;
  const delivered = new Map<string,number>(); // Guard an expired/requeued delivery for the pickup window.
  let renewal: ReturnType<typeof setTimeout> | undefined;
  function resetInbox(){clearTimeout(renewal);inboxGranted=false;panelTask=undefined;delivered.clear();}
  // Local routing keys never leave Pi. Keep terminal observations across a temporary transport failure.
  const childRuns = new Map<string,string>(), endedChildren = new Set<string>(), lifecycle: Signal[][] = [];
  let delegation = '', visitContext: ExtensionContext | undefined;
  const borrowedTaskRuns = new Set<string>();
  function resetChildren() { borrowedTaskRuns.clear(); childRuns.clear(); endedChildren.clear(); lifecycle.length=0; delegation=''; }
  function observeChild(raw:unknown, start:boolean) {
    const ctx=visitContext;
    if (!ctx || closing || !proof.agent || !object(raw)) return;
    const owner=ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId();
    if (!owner || raw.sessionId!==owner) return;
    try {
      const conf=config.read();
      if (!conf.enabled || digest(`${origin(conf.panelUrl)}:${conf.token}`)!==settingsKey) return;
    } catch { return; } // Never disrupt a provider callback if the private settings cannot be read.
    const key=start?raw.id:raw.runId;
    if(typeof key!=='string' || !key || key.length>128) return;
    const batch:Signal[]=[];
    if(start) {
      if(raw.mode!=='single' || raw.parentWorkflowRunId || childRuns.has(key) || endedChildren.has(key)) return;
      if(childRuns.size>=32 || lifecycle.length>=32) {notice(ctx,'AgentMiniOffice: child observation capacity reached.', 'warning');return;}
      if(!delegation) {
        delegation=panelTask?.run ?? eventId();
        if(delegation!==panelTask?.run) batch.push({type:'run.started',run_id:delegation,data:{title:'Delegation'}});
      }
      if(delegation===panelTask?.run) borrowedTaskRuns.add(delegation);
      const child=eventId();childRuns.set(key,child);
      // Public role/task categories only; custom names, actual tasks and prompts remain private.
      const avatar_label=raw.agent==='scout'?'Scout':raw.agent==='researcher'?'Researcher':'Worker';
      const title='Delegated work'; // A role does not establish what the child was asked to do.
      batch.push({type:'run.started',run_id:child,data:{parent_run_id:delegation,avatar_label,title}},
        {type:'spawn.started',run_id:delegation,data:{}});
    } else {
      const child=childRuns.get(key);if(!child) return;
      const done=raw.state==='complete' || raw.state==='completed';
      if(!done && !['failed','stopped','partial','rejected'].some(state=>state===raw.state)) return;
      batch.push({type:done?'run.finished':'run.failed',run_id:child,data:{}});
      childRuns.delete(key);
      endedChildren.add(key);
      if(endedChildren.size>256) endedChildren.delete(endedChildren.values().next().value!);
      if(!childRuns.size){if(!borrowedTaskRuns.delete(delegation)) batch.push({type:'run.finished',run_id:delegation,data:{}});batch.push({type:'spawn.finished',run_id:delegation,data:{}});delegation='';}
    }
    lifecycle.push(batch); return report(ctx);
  }
  pi.events?.on('subagent:async-started',e=>observeChild(e,true));
  pi.events?.on('subagent:async-complete',e=>observeChild(e,false));
  let folder = 'Workspace', label = "",
    idle = true,
    finalText = false,
    leaseUntil = 0,
    heartbeatAt = 0,
    seq = 0,
    target = "",
    producer = "",
    reportedLabel: string | undefined;
  let proof: Proof = {writer:secret('writer')}, 
    current = "",
    paused = "",
    closing = false,
    pending = 0,
    chain = Promise.resolve(),
    timer: ReturnType<typeof setInterval> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined,
    retryBinding = "",
    retries = 0;
  function resetRetries() {
    clearTimeout(retryTimer);
    retryTimer = undefined;
    retryBinding = "";
    retries = 0;
  }
  function notice(ctx: ExtensionContext, message: string, level: "info" | "warning") {
    if (ctx.hasUI) ctx.ui.notify(message, level);
    else console.error(message);
  }
  let abort = new AbortController();
  function disconnect() {
    abort.abort();
    abort = new AbortController();
    current = "";
    heartbeatAt=0;
    reportedLabel = undefined;
    leaseUntil = 0;
  }
  async function request(
    path: string,
    token: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
  ) {
    const c = config.read();
    if (closing || !c.enabled || binding(c) !== current) throw Error("Configuration changed");
    const operation = `${method} ${path.replace(/[0-9a-f-]{36}/g, ":id")}`;
    const res = await fetch(`${target}/api/v1${path}`, {
      method,
      redirect: "error",
      credentials: "omit",
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(4000)]),
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).catch(() => {
      throw new HttpError(0, operation);
    });
    if (!res.ok) throw new HttpError(res.status, operation);
    const json:unknown = await res.json();
    if (!object(json)) throw Error('Invalid collector response');
    return json;
  }
  const open = (w: string) =>
    request("/machine/sessions", producer, {
      writer_token: w,
      visit: true,
      external_session_id: session,
      harness: "pi",
      name: folder,
      project: label,
      lifecycle: "session",
    });
  async function lease() {
    const reply = await open(proof.writer);
    if (
      typeof reply.agent_id !== 'string' || !/^[a-f0-9-]{36}$/.test(reply.agent_id) ||
      typeof reply.last_seq !== 'number' || !Number.isSafeInteger(reply.last_seq) || typeof reply.expires_at !== 'string' ||
      !Number.isFinite(Date.parse(reply.expires_at))
    )
      throw Error("Invalid lease");
    if(proof.agent && proof.agent!==reply.agent_id) {delete proof.event;resetChildren();resetInbox();} // Never replay an old visit's event on a new one.
    inboxGranted = reply.inbox === true && config.read().token.startsWith('amo_producer_');
    proof.agent = reply.agent_id;
    seq = reply.last_seq;
    leaseUntil = Date.parse(reply.expires_at);
  }
  async function connect(c: Config) {
    target = origin(c.panelUrl);
    if (!validToken(c.token)) throw Error("Invalid token");
    const key = digest(`${target}:${c.token}`);
    if(key!==settingsKey){resetInbox();resetChildren();settingsKey=key;proof={writer:secret('writer')};guestProducer=secret('producer');enrolled=false;}
    const guest=c.token.startsWith('amo_join_');
    producer=guest?guestProducer:c.token;
    if(guest && !enrolled){await request('/machine/enroll',c.token,{producer_token:producer,visit:true});enrolled=true;}
    try {await lease();} catch(e){if(guest && e instanceof HttpError && e.status===401) enrolled=false;throw e;}
  }
  async function sendEvent() {
    if (!proof.event) return;
    const batch=JSON.parse(proof.event);
    const result = await request(`/agents/${proof.agent}/events`, proof.writer, batch);
    if (
      !Array.isArray(result.rejected) || result.rejected.length !== 0 ||
      typeof result.accepted !== 'number' || typeof result.duplicate !== 'number' || result.accepted + result.duplicate !== batch.events.length ||
      typeof result.next_seq_hint !== 'number' ||
      !Number.isSafeInteger(result.next_seq_hint)
    )
      throw Error("Event rejected");
    seq = result.next_seq_hint - 1;
    delete proof.event;
  }
  function available(ctx:ExtensionContext) {
    return !closing && !waiting && !compacting && idle && ctx.isIdle() && !ctx.hasPendingMessages?.() && !delegation && binding(config.read())===current;
  }
  async function runEvent(run:string,type:Signal['type']) {
    proof.event=JSON.stringify({events:[{event_id:eventId(),seq:seq+1,type,run_id:run,data:type==='run.started'?{title:'Panel task'}:{}}]});
    await sendEvent();
  }
  // Called only on the serial HTTP chain, after any outstanding event receipt has been recovered.
  async function serviceInbox(ctx:ExtensionContext) {
    if(!inboxGranted) return;
    const base=`/agents/${proof.agent}/inbox`;
    let t=panelTask;
    if(!t){
      if(!available(ctx)) return;
      for(const [id,until] of delivered) if(Date.now()>=until) delivered.delete(id);
      const {tasks}=await request(base,proof.writer);
      const item=Array.isArray(tasks) && tasks.find(v=>object(v) && typeof v.id==='string' && !delivered.has(v.id));
      if(!item || typeof item.id!=='string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(item.id) || typeof item.title!=='string' || !available(ctx)) return;
      const prompt=`[AgentMiniOffice panel task ${item.id}]\n${item.title}\n${typeof item.brief==='string'?item.brief:''}\n\nFollow normal Pi approval rules. Only if this task was completed, put this receipt alone on the last line of your final answer:\nPANEL-TASK-DONE ${item.id}`;
      t=panelTask={id:item.id,run:eventId(),prompt,phase:'claim',renewAt:0,startBy:0,receipt:false};
      await runEvent(t.run,'run.started');
    }
    const url=`${base}/${t.id}`, owner={run_id:t.run};
    if(t.phase==='sent' && Date.now()>=t.startBy) t.outcome='fail';
    try {
      if(!t.outcome && Date.now()>=t.renewAt){
        const lease=await request(`${url}/claim`,proof.writer,owner);
        if(!object(lease.task) || lease.task.id!==t.id || lease.task.status!=='claimed' || typeof lease.lease_expires_at!=='string' || !(Date.parse(lease.lease_expires_at)>Date.now())) throw Error('Invalid task lease');
        const renewIn=Math.max(1,Math.floor((Date.parse(lease.lease_expires_at)-Date.now())/2));
        t.renewAt=Date.now()+renewIn;
        clearTimeout(renewal);
        renewal=setTimeout(()=>{if(!closing && panelTask===t) void report(ctx);},renewIn);
        renewal.unref();
        if(t.phase==='claim'){
          if(available(ctx)){
            t.phase='sent';t.startBy=Date.now()+30_000;
            delivered.set(t.id,Date.now()+15*60_000);
            try {pi.sendUserMessage(t.prompt,{expandPromptTemplates:false});} catch {t.outcome='fail';}
          }else t.outcome='fail'; // The session became busy between listing and claiming.
        }
      }
      if(!t.outcome) return;
      const body=t.outcome==='ack'?{result:'Pi reported completion for this task.'}:{reason:'Pi did not confirm completion for this task.'};
      await request(`${url}/${t.outcome}`,proof.writer,{...owner,...body});
    } catch(e){
      if(!(e instanceof HttpError) || (e.status!==404 && e.status!==409)) throw e;
      t.outcome='fail'; // No longer ours. Never send a message or finish another owner's lease.
    }
    clearTimeout(renewal);
    panelTask=undefined;
    await runEvent(t.run,t.outcome==='ack'?'run.finished':'run.failed');
  }
  function report(ctx: ExtensionContext, signal?: Signal) {
    if (closing || pending >= 16) return;
    pending++;
    chain = chain
      .then(async () => {
        if (closing) return;
        await config.ready;
        const c = config.read(),
          id = binding(c);
        if (current && current !== id) disconnect();
        if (retryBinding && retryBinding !== id) resetRetries();
        if (!c.enabled) {
          resetRetries();
          paused = "";
          return;
        }
        if (paused === id || retryTimer) return;
        const connecting = !current;
        if (connecting) {
          current = id;
          await connect(c);
        } else if (Date.now() + 60_000 >= leaseUntil) await lease();
        await sendEvent();
        while(lifecycle.length) {
          const batch=lifecycle.shift()!;
          proof.event=JSON.stringify({events:batch.map((s,i)=>({event_id:eventId(),seq:seq+i+1,...s}))});
          await sendEvent();
        }
        if (reportedLabel !== label) {
          const project = label;
          await request(
            `/machine/sessions/${proof.agent}/project`,
            proof.writer,
            { project },
            "PATCH",
          );
          reportedLabel = project;
        }
        // Tool traffic updates activity, not presence. Keep heartbeats alive even under sustained hooks.
        if (!signal || signal.data.action === 'compact_context' || signal.type.startsWith('human.') || Date.now()-heartbeatAt>=15000){
          await request(`/agents/${proof.agent}/heartbeat`,proof.writer,{seq:++seq,state:waiting?'waiting_for_human':compacting || !idle?'working':'idle'});
          heartbeatAt=Date.now();
        }
        if (signal) {
          proof.event = JSON.stringify({
            events: [{ event_id: eventId(), seq: seq + 1, ...signal }],
          });
          await sendEvent();
        }
        if (connecting) notice(ctx, inboxGranted ? 'AgentMiniOffice connected. This Trusted token accepts panel tasks.' : 'AgentMiniOffice connected. Telemetry only.', 'info');
        if (!signal || panelTask) await serviceInbox(ctx);
        resetRetries();
      })
      .catch((e) => {
        const failedBinding = current;
        disconnect();
        if (closing || !failedBinding) return;
        // A late response belongs to the settings that sent the request, not the current settings.
        let active: Config;
        try {
          active = config.read();
        } catch {
          return;
        }
        if (!active.enabled || binding(active) !== failedBinding) return;
        const limit = Number.isSafeInteger(active.maxRetries)
          ? Math.min(10, Math.max(0, active.maxRetries!))
          : 3;
        const reason = e instanceof HttpError ? e.message : "check settings or session ownership";
        if (e instanceof HttpError && retries < limit) {
          retryBinding = failedBinding;
          const delay = ++retries * 5;
          notice(
            ctx,
            `AgentMiniOffice: ${reason}. Retry ${retries}/${limit} in ${delay}s.`,
            "warning",
          );
          retryTimer = setTimeout(() => {
            retryTimer = undefined;
            return report(ctx);
          }, delay * 1000);
          retryTimer.unref();
        } else {
          paused = failedBinding;
          notice(
            ctx,
            `AgentMiniOffice stopped for this session (${reason}; ${retries} retries). Use /agent-mini-office on after correcting the problem.`,
            "warning",
          );
        }
      })
      .finally(() => {
        pending--;
      });
    return chain;
  }
  async function configure(ctx: ExtensionContext, action: string) {
    const before = config.read();
    let value = "";
    if (action === "url") {
      const input = await ctx.ui.input("Panel URL", before.panelUrl || "https://office.example");
      if (!input) return;
      value = origin(input.trim());
    }
    if (action === "token") {
      const input = await ctx.ui.input("Office key or trusted connector token", "Paste token");
      if (!input?.trim()) return;
      value = input.trim();
      if (!validToken(value)) throw Error("Invalid token");
    }
    await config.update((c) => {
      if (binding(before) !== binding(c)) throw Error("Settings changed");
      if (action === "url" && value !== c.panelUrl) {
        c.panelUrl = value;
        c.token = "";
        c.enabled = false;
      }
      if (action === "token") {
        if (!c.panelUrl) throw Error("Set panel URL first");
        c.token = value;
      }
      if (action === "off") c.enabled = false;
      if (action === "on") {
        origin(c.panelUrl);
        if (!validToken(c.token)) throw Error("Set token first");
        c.enabled = true;
      }
      c.maxRetries ??= 3;
    });
    abort.abort();
    await chain;
    resetRetries();
    disconnect();
    paused = "";
    await report(ctx);
    const latest = config.read();
    if (latest.enabled && (paused === binding(latest) || retryTimer)) return; // The failed report already notified.
    ctx.ui.notify(`AgentMiniOffice ${latest.enabled ? "on" : "off"}.`, "info");
  }
  pi.registerCommand("agent-mini-office", {
    description: "Configure office telemetry: on, off, token, or url",
    handler: async (args, ctx) => {
      const choices = { On: "on", Off: "off", "Update Token": "token", "Update Panel URL": "url" };
      let action = args.trim().toLowerCase();
      if (!action) {
        const choice = await ctx.ui.select("AgentMiniOffice", Object.keys(choices));
        if (!choice) return;
        action = choices[choice as keyof typeof choices];
      }
      if (!Object.values(choices).includes(action)) {
        ctx.ui.notify(
          "Use on, off, token, or url. Never put secrets in the command line.",
          "warning",
        );
        return;
      }
      try {
        await configure(ctx, action);
      } catch {
        ctx.ui.notify(
          "Settings not applied. Check the URL, token, private file permissions, or concurrent edits.",
          "warning",
        );
      }
    },
  });
  pi.on("session_start", async (_, ctx) => {
    await config.ready;
    visitContext=ctx;
    finalText = false;
    folder = projectLabel(undefined, ctx.cwd);
    label = projectLabel(pi.getSessionName(), ctx.cwd);
    idle = ctx.isIdle();
    timer = setInterval(() => {
      if (!pending) {
        idle=ctx.isIdle();
        void report(ctx);
      }
    }, 15_000);
    timer.unref();
    await report(ctx);
  });
  pi.on("session_info_changed", async (e, ctx) => {
    label = projectLabel(e.name, ctx.cwd);
    await report(ctx);
  });
  pi.on("agent_start", async (_, ctx) => {
    idle = false;
    finalText = false;
    if (compacting) {
      compacting=false;
      await report(ctx,{type:'note',data:{kind:'agent-started'}});
    } else await report(ctx);
  });
  pi.on('before_agent_start',e=>{
    const t=panelTask;
    if(!t || t.phase==='claim' || t.outcome) return;
    if(t.phase==='sent' && e.messageType==='user' && e.prompt===t.prompt){t.phase='running';t.prompt='';}
    else t.outcome='fail'; // Unrelated user/custom prompt must not supply a receipt.
  });
  pi.on('input', ()=>{if(panelTask?.phase==='running') panelTask.outcome='fail';});
  pi.on('agent_end', e => {
    // A loop can end before retry or continuation. Keep only metadata until final settlement.
    const last = e.messages.at(-1);
    finalText = last?.role === 'assistant' && last.stopReason === 'stop' &&
      last.content.some(block => block.type === 'text');
    const t=panelTask;
    if(t?.phase==='running'){
      const tail=last?.role==='assistant' && last.stopReason==='stop' ? last.content.filter(b=>b.type==='text').at(-1) : undefined;
      t.receipt=tail?.text.trimEnd().split('\n').at(-1)===`PANEL-TASK-DONE ${t.id}`;
    }
  });
  pi.on("agent_settled", async (e, ctx) => {
    idle = ctx.isIdle();
    if(panelTask?.phase==='running') panelTask.outcome ??= !e.aborted && panelTask.receipt ? 'ack' : 'fail';
    const completed = idle && !e.aborted && finalText;
    finalText = false;
    if (completed) await report(ctx, {type:'note', data:{kind:'final-response',action:'final_response'}});
    await report(ctx);
  });
  pi.on('tool_execution_start',(e,ctx)=>report(ctx,{type:'tool.start',data:describeTool(pi,e.toolName,rules,packaged)}));
  pi.on('tool_execution_end',(e,ctx)=>report(ctx,{type:'tool.call',data:{...describeTool(pi,e.toolName,rules,packaged),ok:!e.isError}}));
  // Observe the lifecycle, not preparation, summaries, messages or error details.
  pi.on('session_before_compact',async (_,ctx)=>{
    compacting=true;
    await report(ctx,{type:'note',data:{action:'compact_context'}});
  });
  async function endCompaction(ctx: ExtensionContext, kind:string) {
    compacting=false;
    idle=ctx.isIdle();
    await report(ctx,{type:'note',data:{kind}});
    await report(ctx);
    // On manual success Pi clears its compaction flag after this hook returns.
    if (!idle) setImmediate(() => {
      if (!closing && !compacting && !idle && ctx.isIdle()) {
        idle=true;
        void report(ctx);
      }
    });
  }
  pi.on('session_compact',(_,ctx)=>endCompaction(ctx,'context-compacted'));
  pi.on('session_compact_failed',(e,ctx)=>endCompaction(ctx,e.aborted?'context-compaction-cancelled':'context-compaction-failed'));
  pi.on('ui_prompt_start',(e,ctx)=>{
    waiting=true;
    const options=e.kind==='confirm'?['yes','no']:e.kind==='select'?['select']:e.kind==='input'||e.kind==='editor'?['input']:undefined;
    return report(ctx,{type:'human.waiting',data:{kind:e.kind,options}});
  });
  pi.on('ui_prompt_end',(_,ctx)=>{waiting=false;return report(ctx,{type:'human.resumed',data:{}});});
  pi.on("session_shutdown", async () => {
    closing = true;
    resetRetries();
    clearInterval(timer);
    clearTimeout(renewal);
    abort.abort();
    await chain;
    disconnect();
  });
}
