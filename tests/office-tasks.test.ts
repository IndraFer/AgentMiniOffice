import {randomBytes} from 'node:crypto';
import {expirePending,PICKUP_TTL_MS} from '../src/lib/tasks';
import { describe, expect, test } from "bun:test";
import { hashPassword } from "../src/lib/passwords";
import { uuidv7 } from "../src/lib/uuid";
import { createOffice } from "./helpers";

const PASSWORD = "correct-horse-battery";

interface Board {
  tasks: {
    id: string;
    title: string;
    status: string;
    agent_id: string;
    agent_name: string;
    priority: number;
  }[];
}

async function setup(options: Parameters<typeof createOffice>[0] = {}) {
  const office = await createOffice(options);
  office.db
    .prepare(
      `INSERT INTO members (id, org_id, email, display_name, role, password_hash, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    )
    .run(
      uuidv7(),
      office.orgId,
      "owner@example.com",
      "Owner",
      "owner",
      hashPassword(PASSWORD),
      new Date().toISOString(),
    );

  const login = await office.app.request("/api/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "owner@example.com", password: PASSWORD }),
  });
  expect(login.status).toBe(200);
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

  const post=(path:string,data:unknown,token='')=>office.app.request(`/api/v1${path}`,{method:'POST',headers:{cookie,'content-type':'application/json',authorization:`Bearer ${token}`},body:JSON.stringify(data)});
  const producer=await (await post('/offices/test-office/machine/trusted',{inbox:true})).json() as {token:string};
  const writers=new Map<string,string>();
  const agent = async (name: string) => {
    const writer='amo_writer_'+randomBytes(32).toString('base64url');
    const res=await post('/machine/sessions',{harness:'pi',name,visit:true,external_session_id:uuidv7(),writer_token:writer},producer.token);
    expect(res.status).toBe(201);
    const {agent_id:id}=await res.json() as {agent_id:string};writers.set(id,writer);
    expect((await post(`/agents/${id}/heartbeat`,{seq:1,state:'idle'},writer)).status).toBe(200);return id;
  };

  const first = await agent("pi-one");
  const second = await agent("pi-two");

  const addTask = (agentId: string, title: string, priority = 0) =>
    office.app.request("/api/v1/offices/test-office/tasks", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ agent_id: agentId, title, priority }),
    });

  const board = async () => {
    const res = await office.app.request("/api/v1/offices/test-office/tasks", {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    return (await res.json()) as Board;
  };

  return { office, cookie, first, second, addTask, board,post,writers };
}

describe("office tasks", () => {
  test("requires a session", async () => {
    const office = await createOffice();
    const res = await office.app.request("/api/v1/offices/test-office/tasks", { method: "POST" });
    expect(res.status).toBe(401);
  });

  test("creates a task and lists it with its agent", async () => {
    const { addTask, board, first } = await setup();
    const created = await addTask(first, "refactor auth", 2);
    expect(created.status).toBe(201);

    const body = await board();
    expect(body.tasks).toHaveLength(1);
    expect(body.tasks[0]?.title).toBe("refactor auth");
    expect(body.tasks[0]?.status).toBe("pending");
    expect(body.tasks[0]?.agent_name).toBe("pi-one");
    expect(body.tasks[0]?.priority).toBe(2);
  });

  test("refuses a sixth pending task for one agent", async () => {
    const { addTask, first } = await setup();
    for (let index = 0; index < 5; index++) {
      expect((await addTask(first, `task ${index}`)).status).toBe(201);
    }
    expect((await addTask(first, "one too many")).status).toBe(409);
  });

  test("rejects an agent from another office", async () => {
    const { office, cookie, addTask } = await setup();
    const other = await createOffice();

    const res = await office.app.request("/api/v1/offices/test-office/tasks", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ agent_id: other.agentId, title: "cross office" }),
    });
    expect(res.status).toBe(422);

    // and it did not create anything
    expect(
      (await office.app.request("/api/v1/offices/test-office/tasks", { headers: { cookie } }))
        .status,
    ).toBe(200);
    expect((await addTask(other.agentId, "x")).status).toBe(422);
  });

  test("cancel removes a pending task from the board and the inbox", async () => {
    const { office, cookie, addTask, board, first } = await setup();
    const created = (await (await addTask(first, "cancel me")).json()) as { task: { id: string } };

    const res = await office.app.request(
      `/api/v1/offices/test-office/tasks/${created.task.id}/cancel`,
      { method: "POST", headers: { cookie } },
    );
    expect(res.status).toBe(200);

    expect((await board()).tasks).toHaveLength(0);

    const inbox = await office.app.request(`/api/v1/agents/${first}/inbox`, {
      headers: { authorization: `Bearer ${office.agentToken}` },
    });
    expect(inbox.status).toBe(401);
  });

  test("reassign moves a pending task to another agent", async () => {
    const { office, cookie, addTask, board, first, second } = await setup();
    const created = (await (await addTask(first, "move me")).json()) as { task: { id: string } };

    const res = await office.app.request(
      `/api/v1/offices/test-office/tasks/${created.task.id}/assign`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ agent_id: second }),
      },
    );
    expect(res.status).toBe(200);

    const body = await board();
    expect(body.tasks[0]?.agent_id).toBe(second);
    expect(body.tasks[0]?.agent_name).toBe("pi-two");
  });

  test('only an accepted heartbeat cleans expired sessions in its office, including unmarked ones',async()=>{
    const {office,first,second,addTask,board}=await setup();
    await addTask(first,'expired');
    expect(expirePending(office.db,Date.now()+14*60_000)).toHaveLength(0);
    expect(PICKUP_TTL_MS).toBe(15*60_000);
    expect(expirePending(office.db,Date.now()+PICKUP_TTL_MS+50)).toHaveLength(1);
    await addTask(first,'abandoned');await addTask(second,'keep');
    office.db.prepare('DELETE FROM visit_labels WHERE agent_id=?').run(first);
    office.store.heartbeat(first,office.orgId,{seq:2},Date.now()-32*60000);
    const other=uuidv7(), stranger=uuidv7(), old=new Date(0).toISOString();
    office.db.prepare('INSERT INTO organizations(id,name,slug,created_at) VALUES(?,?,?,?)').run(other,'Elsewhere','elsewhere',old);
    office.db.prepare('INSERT INTO agents(id,org_id,name,kind,created_at) VALUES(?,?,?,?,?)').run(stranger,other,'Old','pi',old);
    await office.heartbeat({seq:0});expect((await board()).tasks).toHaveLength(2);
    expect((await office.heartbeat({seq:1})).status).toBe(200);
    expect((await board()).tasks.map(t=>t.title)).toEqual(['keep']);expect(office.store.view(first)).toBeNull();
    expect(office.db.prepare('SELECT id FROM agents WHERE id=?').get(stranger)).toBeTruthy();
    expect(office.db.prepare('SELECT id FROM machine_producers').all()).toHaveLength(1);
  });
  test('retention starts at Offline, uses both configured durations, and does not cascade into another worker’s child',async()=>{
    const {office,first,second,post,writers}=await setup({retentionMinutes:2,dedicatedRetentionMinutes:4});
    const now=Date.now(); const id=office.agentId;
    const parent=await office.startRun(1), child=uuidv7();
    office.db.prepare("INSERT INTO runs(id,org_id,agent_id,parent_run_id,state,started_at) VALUES(?,?,?,?,'active',?)").run(child,office.orgId,second,parent,new Date(now).toISOString());
    const beat=(seq:number)=>post(`/agents/${second}/heartbeat`,{seq},writers.get(second));
    office.store.heartbeat(first,office.orgId,{seq:2},now-90000-110000);
    office.store.heartbeat(id,office.orgId,{seq:2},now-90000-150000);
    expect((await beat(2)).status).toBe(200);
    const roster=async()=>((await (await office.snapshot()).json()) as {agents:{id:string}[]}).agents.map(a=>a.id);
    expect(await roster()).toContain(first);expect(await roster()).toContain(id);
    office.store.heartbeat(first,office.orgId,{seq:3},now-90000-121000);
    await beat(3);expect(await roster()).not.toContain(first);expect(await roster()).toContain(id);
    office.store.heartbeat(id,office.orgId,{seq:3},now-90000-241000);
    await beat(4);expect(await roster()).not.toContain(id);
    expect(office.db.prepare('SELECT parent_run_id FROM runs WHERE id=?').get(child)).toEqual({parent_run_id:null});
    expect((await office.heartbeat({seq:4})).status).toBe(200);expect(await roster()).toContain(id);
    office.store.load(office.db); // simulate restart before the next scheduled flush
    expect((await office.heartbeat({seq:4})).status).toBe(409);
    expect(office.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
  test('removing one session preserves a shared connector; deleting the last through retention revokes it',async()=>{
    const {office,cookie,first,second,post,writers}=await setup();
    const active=async()=>((await (await office.app.request('/api/v1/offices/test-office/machine/producers',{headers:{cookie}})).json()) as {producers:unknown[]}).producers.length;
    expect(await active()).toBe(1);
    office.store.heartbeat(first,office.orgId,{seq:2},Date.now()-91000);
    expect((await office.app.request(`/api/v1/offices/test-office/agents/${first}`,{method:'DELETE',headers:{cookie}})).status).toBe(204);
    expect(await active()).toBe(1);expect((await post(`/agents/${second}/heartbeat`,{seq:2},writers.get(second))).status).toBe(200);
    office.store.heartbeat(second,office.orgId,{seq:3},Date.now()-32*60000);
    expect((await office.heartbeat({seq:1})).status).toBe(200);expect(await active()).toBe(0);
    expect(office.db.prepare('SELECT revoked_at FROM machine_producers WHERE revoked_at IS NOT NULL').get()).toBeTruthy();
  });
  test('owner can delete offline activity, not online workers; only a valid fresh dedicated heartbeat restores it',async()=>{
    const {office,cookie}=await setup(); const id=office.agentId;
    const drop=(credential:string)=>office.app.request(`/api/v1/offices/test-office/agents/${id}`,{method:'DELETE',headers:{cookie:credential}});
    await office.heartbeat({seq:1});expect((await drop(cookie)).status).toBe(409);
    office.store.heartbeat(id,office.orgId,{seq:2},Date.now()-91000);office.addTask('old work');
    expect((await drop('')).status).toBe(401);expect((await drop(cookie)).status).toBe(204);
    const visible=async()=>((await (await office.snapshot()).json()) as {agents:{id:string}[]}).agents.some(a=>a.id===id);
    expect(await visible()).toBe(false);expect((await office.inbox()).status).toBe(401);
    expect((await office.heartbeat({seq:2})).status).toBe(409);expect(await visible()).toBe(false);
    expect((await office.heartbeat({seq:3})).status).toBe(200);expect(await visible()).toBe(true);
    expect(office.db.prepare('SELECT id FROM tasks WHERE agent_id=?').get(id)).toBeFalsy();
    office.store.heartbeat(id,office.orgId,{seq:4},Date.now()-91000);expect((await drop(cookie)).status).toBe(204);
    office.db.prepare('UPDATE agent_tokens SET revoked_at=CURRENT_TIMESTAMP WHERE agent_id=?').run(id);
    expect((await office.heartbeat({seq:5})).status).toBe(401);expect(await visible()).toBe(false);
  });
  test("a claimed task cannot be reassigned or cancelled twice", async () => {
    const { office, cookie, addTask, first, second,post,writers } = await setup();
    const created = (await (await addTask(first, "hold me")).json()) as {
      task: { id: string };
    };

    // Drive a claim through the real agent API.
    const runId = uuidv7();
    await post(`/agents/${first}/events`,{events:[
      {
        event_id: uuidv7(),
        seq: 2,
        type: "run.started",
        run_id: runId,
        data: { title: "work" },
      },
    ]},writers.get(first));
    const claim=await post(`/agents/${first}/inbox/${created.task.id}/claim`,{run_id:runId},writers.get(first));
    expect(claim.status).toBe(200);

    const reassign = await office.app.request(
      `/api/v1/offices/test-office/tasks/${created.task.id}/assign`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ agent_id: second }),
      },
    );
    expect(reassign.status).toBe(409);
  });
});
