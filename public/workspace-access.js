// Shared dashboard confirmation: text-only content, Cancel focused, Escape never confirms.
export function confirmAction(h, host, title, message, label) {
  const cancel = h('button', { type:'button', class:'btn btn-quiet', autofocus:true, onclick:()=>dialog.close() }, 'Cancel');
  const dialog = h('dialog', {
    class:'workspace-dialog card', 'aria-labelledby':'confirm-title', 'aria-describedby':'confirm-message',
  }, h('h2',{id:'confirm-title'},title), h('p',{id:'confirm-message'},message),
    h('div',{class:'dashboard-actions'},cancel,
      h('button',{type:'button', class:'btn btn-danger confirm-action', onclick:()=>dialog.close('confirmed')},label)));
  host.append(dialog);
  return new Promise(resolve=>{
    dialog.addEventListener('close',()=>{
      dialog.remove();
      resolve(dialog.returnValue==='confirmed' && host.isConnected);
    },{once:true});
    dialog.showModal();
  });
}

// Owner-only machine controls. State, including a one-time reveal, belongs to this page instance.
export function workspaceAccessPage(
  office,
  { h, api, officeUrlFor, sectionButton, cardHead, revealToken, errorMessage },
) {
  const endpoint = (suffix) => officeUrlFor(office, `/machine${suffix}`);
  const status = h("p", { class: "workspace-status small", role: "status" });
  const group = h("fieldset", {
    class: "workspace-controls",
    disabled: true,
    "aria-label": "Machine access controls",
  });
  const secret = h("div", { class: "workspace-secret" });
  const button = (label, fn, danger = false) =>
    h(
      "button",
      { type: "button", class: `btn btn-sm ${danger ? "btn-danger" : "btn-quiet"}`, onclick: fn },
      label,
    );
  const refresh = button("Refresh Access", () => load(true));
  const inbox = h("input", { type: "checkbox", name: "connector_inbox" });
  const modeBadge = h("span", { class: "badge", "data-mode": true }, "Unknown");
  const modeButton = button("Change Admission", changeMode);
  const keyButton = button("Issue Key", issueKey);
  const viewButton = button("View Office Key", viewKey);
  const trustedButton = button("Issue Trusted Credential", issueTrusted);
  const list = h("ul", { class: "workspace-list" });
  let mode = null,
    producers = [],
    busy = false,
    ready = false;
  function controls() {
    group.disabled = busy || !ready;
    refresh.disabled = busy;
    viewButton.disabled = keyButton.disabled = secret.childElementCount > 0;
    trustedButton.disabled = secret.childElementCount > 0;
  }
  function drawMode() {
    modeBadge.textContent = mode === "open" ? "Open" : "Closed";
    modeButton.textContent = mode === "open" ? "Close Admission" : "Open Admission";
    modeButton.classList.toggle("btn-danger", mode === "open");
  }
  function drawList() {
    list.replaceChildren(
      ...producers.map((p) =>
        h(
          "li",
          { "data-connector": p.kind },
          h(
            "div",
            {},
            h("strong", {}, p.kind === "trusted" ? "Trusted Connector" : "General Connector"),
            h(
              "span",
              { class: "small muted" },
              p.inbox ? "Telemetry + Assigned Inbox" : "Telemetry Only",
            ),
            h("code", {}, p.id),
          ),
          button("Revoke Connector", () => revoke(p), true),
        ),
      ),
    );
    if (!producers.length)
      list.append(h("li", { class: "small muted" }, "No non-revoked connectors."));
  }
  function reveal(label, raw, hint, trigger, badge) {
    secret.replaceChildren(
      revealToken(label, raw, hint, badge),
      button("Hide Credential", () => {
        secret.replaceChildren();
        controls();
        trigger.focus();
      }),
    );
    secret.focus();
  }
  // Await operations serially. A timeout may mean the mutation committed: no automatic write retries.
  async function run(action) {
    if (busy) return;
    busy = true;
    controls();
    try {
      await action();
    } catch {
      if (page.isConnected) {
        ready = false;
        status.textContent =
          "Could not confirm the result. Refresh Access before taking another action.";
      }
    } finally {
      busy = false;
      controls();
    }
  }
  function failed(result) {
    ready = false;
    if ([401, 403].includes(result.status)) {
      secret.replaceChildren();
      list.replaceChildren();
      modeBadge.textContent = "Unavailable";
    }
    status.textContent = `${errorMessage(result, "Request failed")}. Refresh Access before retrying.`;
  }
  async function load(manual = false) {
    await run(async () => {
      status.textContent = "Loading workspace access…";
      const [policy, connections] = await Promise.all([
        api(endpoint("/admission")),
        api(endpoint("/producers")),
      ]);
      if (!page.isConnected) return;
      if (!policy.ok || !connections.ok) {
        failed(!policy.ok ? policy : connections);
        return;
      }
      if (
        !["open", "closed"].includes(policy.data?.mode) ||
        !Array.isArray(connections.data?.producers)
      )
        throw new Error("Invalid response");
      if (secret.dataset.kind === "key") secret.replaceChildren();
      keyButton.textContent = policy.data.has_join_key ? "Rotate Key" : "Issue Key";
      mode = policy.data.mode;
      producers = connections.data.producers;
      ready = true;
      drawMode();
      drawList();
      status.textContent = manual ? "Workspace access is up to date." : "";
    });
  }
  async function write(suffix, options, success) {
    if (!ready) return;
    await run(async () => {
      const result = await api(endpoint(suffix), options);
      if (!page.isConnected) return;
      if (!result.ok) {
        failed(result);
        return;
      }
      success(result.data);
    });
  }
  const confirm = (title, message, label) => confirmAction(h, page, title, message, label);
  async function changeMode() {
    const next = mode === "open" ? "closed" : "open";
    if (
      next === "closed" &&
      !(await confirm(
        "Close Machine Admission?",
        "New installations cannot enroll with the office key while Closed. The key and existing connections are unchanged.",
        "Close Admission",
      ))
    )
      return;
    void write("/admission", { method: "PUT", body: { mode: next } }, (data) => {
      mode = data.mode;
      drawMode();
      status.textContent = `Machine admission is now ${next}.`;
    });
  }
  function revealKey(data, trigger) {
    secret.dataset.kind = "key";
    reveal(
      "Office Join Key",
      data.token,
      "Use this key to enroll connectors while Open. Only rotation changes it.",
      trigger,
      "Owner Only",
    );
  }
  async function viewKey() {
    await run(async () => {
      const result = await api(endpoint("/join-key"));
      if (!page.isConnected) return;
      if ([404, 409].includes(result.status)) {
        status.textContent = errorMessage(result, "Key unavailable");
      } else if (!result.ok) failed(result);
      else {
        revealKey(result.data, viewButton);
        status.textContent = "Office key revealed.";
      }
    });
  }
  async function issueKey() {
    if (
      !(await confirm(
        "Issue a New Join Key?",
        "Any existing key will stop admitting new installations. Already enrolled connectors keep access.",
        "Issue Join Key",
      ))
    )
      return;
    void write("/join-key", { method: "POST" }, (data) => {
      keyButton.textContent = "Rotate Key";
      revealKey(data, keyButton);
      status.textContent = "New join key issued. Any previous join key is no longer valid.";
    });
  }
  async function issueTrusted() {
    const grant = inbox.checked;
    if (
      grant &&
      !(await confirm(
        "Grant Assigned Inbox Access?",
        "This connector will be able to pull and complete tasks assigned to its workers.",
        "Grant and Issue",
      ))
    )
      return;
    void write("/trusted", { method: "POST", body: { inbox: grant } }, (data) => {
      inbox.checked = false;
      producers.push({ id: data.producer_id, kind: "trusted", inbox: grant });
      drawList();
      secret.dataset.kind = data.producer_id;
      reveal(
        "Trusted Connector Credential",
        data.token,
        `Connector ID: ${data.producer_id}. Save the credential privately before leaving.`,
        trustedButton,
      );
      status.textContent = "Trusted connector created.";
    });
  }
  async function revoke(p) {
    if (
      !(await confirm(
        "Revoke Connector?",
        `Revoking connector ${p.id} permanently deletes its sessions, tasks and activity. Its writers can no longer report. Other connectors and the office key are unaffected.`,
        "Revoke Connector",
      ))
    )
      return;
    void write(`/producers/${encodeURIComponent(p.id)}`, { method: "DELETE" }, () => {
      producers = producers.filter((item) => item.id !== p.id);
      if (secret.dataset.kind === p.id) secret.replaceChildren();
      drawList();
      status.textContent = "Connector revoked. Its next report will be denied.";
      status.focus();
    });
  }
  secret.tabIndex = -1;
  status.tabIndex = -1;
  group.append(
    h(
      "div",
      { class: "overview-utilities" },
      h(
        "section",
        { class: "card" },
        cardHead(
          "General Admission",
          "Open accepts the office key for new installations. Closed pauses enrollment, not connected workers.",
          "link",
          "tone-ocean",
        ),
        h(
          "div",
          { class: "dashboard-actions mode-actions" },
          h("span", { class: "row" }, "Current Mode:", modeBadge),
          h(
            "div",
            { class: "dashboard-actions admission-buttons" },
            modeButton,
            viewButton,
            keyButton,
          ),
        ),
      ),
      h(
        "section",
        { class: "card" },
        cardHead(
          "Trusted Connectors",
          "Issue a dedicated credential in either mode. Telemetry only by default.",
          "users",
          "tone-plum",
        ),
        h("label", { class: "row" }, inbox, "Allow Assigned Task Inbox"),
        trustedButton,
      ),
    ),
    h(
      "section",
      { class: "card" },
      cardHead(
        "Registered Connectors",
        "General and Trusted connectors stay registered while they have sessions. Removing the last session revokes the connector. Revoking it here deletes all its sessions.",
        "terminal",
        "tone-sage",
      ),
      list,
    ),
  );
  const page = h(
    "main",
    { class: "page dashboard-page workspace-page" },
    h(
      "div",
      { class: "page-head" },
      h(
        "div",
        {},
        h("p", { class: "eyebrow" }, office.name),
        h("h1", {}, "Workspace Access"),
        h(
          "p",
          {},
          "Machine admission and credentials. Human membership and shared viewing do not change.",
        ),
      ),
      h(
        "div",
        { class: "dashboard-actions" },
        sectionButton("Back to Overview", "overview", "grid"),
        refresh,
      ),
    ),
    status,
    secret,
    group,
  );
  // dashboardShell mounts synchronously before either read resolves.
  void load();
  return page;
}
