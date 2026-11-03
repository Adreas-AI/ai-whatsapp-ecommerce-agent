/* Demo console. Vanilla JS; every value is rendered with textContent (no innerHTML). */
(function () {
  'use strict';

  const state = { status: null, fixtures: null, turns: [], crm: null, sender: '15550100001', selectedTurn: null, busy: false };
  const $ = (id) => document.getElementById(id);

  // In live mode the API needs ADMIN_TOKEN: open the console as /#token=<ADMIN_TOKEN>.
  let token = null;
  try {
    const fromHash = new URLSearchParams(location.hash.slice(1)).get('token');
    if (fromHash) {
      sessionStorage.setItem('adminToken', fromHash);
      history.replaceState(null, '', location.pathname);
    }
    token = sessionStorage.getItem('adminToken');
  } catch {
    token = null;
  }

  function el(tag, props, children) {
    const node = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v === undefined || v === null || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'width') node.style.width = v; // CSSOM: allowed under style-src 'self'
        else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const child of [].concat(children || [])) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  async function api(path, options) {
    const headers = { 'content-type': 'application/json' };
    if (token) headers.authorization = 'Bearer ' + token;
    const res = await fetch(path, Object.assign({ headers }, options));
    if (!res.ok) throw new Error(path + ' → HTTP ' + res.status);
    return res.json();
  }

  const tag = (text, kind) => el('span', { class: 'tag ' + (kind || ''), text });

  // ---------------------------------------------------------------- header
  function renderStatus() {
    const s = state.status;
    if (!s) return;
    $('mode-banner').hidden = !s.demo_mode;
    const list = $('integrations');
    list.replaceChildren();
    const entries = [
      ['WhatsApp', s.integrations.whatsapp],
      ['OpenAI', s.integrations.openai],
      ['WooCommerce', s.integrations.woocommerce],
      ['HubSpot', s.integrations.hubspot],
      ['Orchestrator', s.orchestrator === 'n8n' ? 'n8n workflow' : 'local (mirrors n8n)'],
    ];
    for (const [name, value] of entries) {
      const live = !/mock/i.test(value);
      list.append(el('li', { title: value }, [el('span', { class: 'dot' + (live ? ' live' : '') }), el('b', { text: name }), el('span', { class: 'muted', text: shortStatus(value) })]));
    }
  }

  function shortStatus(v) {
    if (/mock/i.test(v)) return 'mock';
    if (/^live/i.test(v)) return 'live';
    return v;
  }

  // ---------------------------------------------------------------- scenarios
  function renderFixtures() {
    const f = state.fixtures;
    const sel = $('sender');
    sel.replaceChildren();
    if (!f) {
      $('scenarios').hidden = true;
      $('composer').hidden = true;
      sel.closest('label').hidden = true;
      return;
    }
    for (const c of f.customers) sel.append(el('option', { value: c.waId, text: c.name + ' · +' + c.waId }));
    sel.value = state.sender;
    const box = $('scenarios');
    box.replaceChildren();
    for (const s of f.scenarios) {
      box.append(el('button', { type: 'button', title: s.description, onclick: () => runScenario(s), text: s.title }));
    }
  }

  async function runScenario(s) {
    state.sender = s.from;
    $('sender').value = s.from;
    for (const text of s.messages) await send(text, s.from, s.name);
  }

  async function send(text, from, name) {
    if (state.busy || !text.trim()) return;
    state.busy = true;
    $('send').disabled = true;
    try {
      const out = await api('/api/demo/simulate', { method: 'POST', body: JSON.stringify({ from, name, text }) });
      state.selectedTurn = out.turn_id;
      await refresh();
      if (state.status && state.status.orchestrator === 'n8n') {
        // n8n processes asynchronously; poll briefly for the reply.
        for (let i = 0; i < 20; i++) {
          await new Promise((r) => setTimeout(r, 400));
          await refresh();
          const t = state.turns.find((x) => x.turnId === out.turn_id);
          if (t && t.status !== 'processing') break;
        }
      }
    } catch (err) {
      console.error(err);
    } finally {
      state.busy = false;
      $('send').disabled = false;
    }
  }

  // ---------------------------------------------------------------- chat
  function deliveryLabel(reply) {
    if (!reply) return null;
    if (reply.delivery.startsWith('mock_not_sent')) return tag('DEMO · mock send, not delivered', 'mock');
    if (reply.delivery.startsWith('sent')) return tag('sent', 'live');
    return tag(reply.delivery, 'blocked');
  }

  function renderChat() {
    const list = $('messages');
    list.replaceChildren();
    const display = state.status && state.status.demo_mode ? '+' + state.sender : null;
    const turns = state.turns.filter((t) => !display || t.waIdDisplay === display).slice().reverse();
    if (turns.length === 0) {
      list.append(el('li', { class: 'bubble system', text: 'No messages from this customer yet. Pick a scenario or type below.' }));
      return;
    }
    for (const t of turns) {
      const selected = t.turnId === state.selectedTurn;
      const pick = () => {
        state.selectedTurn = t.turnId;
        renderAll();
      };
      list.append(
        el('li', { class: 'bubble in' + (selected ? ' selected' : ''), onclick: pick, title: 'Show details for this turn' }, [
          t.inboundText === null ? el('em', { text: '[' + t.messageType + ' message]' }) : t.inboundText,
          el('div', { class: 'meta' }, [new Date(t.receivedAt).toLocaleTimeString(), t.classification ? tag(t.classification.intent) : null]),
        ]),
      );
      if (t.reply) {
        list.append(
          el('li', { class: 'bubble out' + (selected ? ' selected' : ''), onclick: pick }, [
            t.reply.text,
            el('div', { class: 'meta' }, [deliveryLabel(t.reply)]),
          ]),
        );
      } else if (t.status === 'processing') {
        list.append(el('li', { class: 'bubble system', text: 'processing…' }));
      } else if (t.route && t.route.route === 'none') {
        list.append(el('li', { class: 'bubble system', text: 'Bot silent: human handoff active. Message left for the agent.' }));
      }
    }
    list.scrollTop = list.scrollHeight;
  }

  // ---------------------------------------------------------------- details
  function currentTurn() {
    return state.turns.find((t) => t.turnId === state.selectedTurn) || state.turns[0] || null;
  }

  function renderIntent(t) {
    const box = $('intent');
    box.replaceChildren();
    $('turn-label').textContent = t ? t.waIdDisplay + ' · ' + new Date(t.receivedAt).toLocaleTimeString() : '';
    if (!t || !t.classification) {
      box.className = 'empty';
      box.textContent = t && t.route ? 'Not classified: ' + t.route.reason : 'Send a message to see how it is classified and routed.';
      return;
    }
    box.className = '';
    const c = t.classification;
    const src = c.source === 'openai' ? tag('OpenAI', 'live') : tag(c.source === 'mock' ? 'mock AI (rules)' : 'rule fallback', 'mock');
    box.append(
      el('div', { class: 'intent-row' }, [el('span', { class: 'intent-name', text: c.intent }), src, c.sentiment !== 'neutral' ? tag(c.sentiment) : null, c.wants_human ? tag('wants human', 'blocked') : null]),
      el('div', { class: 'muted small', text: 'confidence ' + Math.round(c.confidence * 100) + '%' }),
      el('div', { class: 'bar' }, [el('span', { width: Math.round(c.confidence * 100) + '%' })]),
      el('dl', { class: 'kv' }, [
        el('dt', { text: 'Route' }),
        el('dd', {}, [el('code', { text: t.route ? t.route.route : '-' })]),
        el('dt', { text: 'Why' }),
        el('dd', { text: t.route ? t.route.reason : '-' }),
        c.product_query ? el('dt', { text: 'Search' }) : null,
        c.product_query ? el('dd', { text: c.product_query }) : null,
      ]),
    );
    if (t.route && t.route.guardNotes.length) box.append(el('div', { class: 'notes' }, ['Server guard: ' + t.route.guardNotes.join(' · ')]));
  }

  function renderTools(t) {
    const list = $('tools');
    list.replaceChildren();
    if (!t || t.toolCalls.length === 0) {
      list.className = 'timeline empty';
      list.textContent = 'No tool calls yet.';
      return;
    }
    list.className = 'timeline';
    t.toolCalls.forEach((call, i) => {
      list.append(
        el('li', {}, [
          el('span', { class: 'step', text: String(i + 1) }),
          el('span', { class: 'tool-name', text: call.name }),
          el('span', { class: 'tool-tags' }, [call.mock ? tag('MOCK', 'mock') : tag('live', 'live'), tag(call.status, call.status), el('span', { class: 'muted small', text: call.durationMs + ' ms' })]),
          el('span', { class: 'tool-summary', text: call.summary }),
        ]),
      );
    });
  }

  function renderOrder(t) {
    const box = $('order');
    box.replaceChildren();
    const lookup = t && t.orderLookup;
    if (!lookup) {
      box.className = 'empty';
      box.textContent = 'No order lookup in this turn.';
      return;
    }
    box.className = '';
    const outcomeKind = lookup.outcome === 'verified' ? 'ok' : 'blocked';
    const o = lookup.order;
    const explain = {
      need_email: 'Ownership not proven yet. Asked for the order email; no details disclosed.',
      not_verified: 'Details did not match. Uniform refusal; nothing disclosed.',
      locked: 'Too many failed attempts. Lookups paused and escalated.',
      invalid_order_number: 'Not a valid order number.',
    };
    box.append(el('div', { class: 'intent-row' }, [tag(lookup.outcome, outcomeKind), o ? tag('verified via ' + o.verifiedBy.replace(/_/g, ' ')) : null, tag('mock WooCommerce', 'mock')]));
    if (!o) {
      box.append(el('p', { class: 'muted', text: explain[lookup.outcome] || '' }));
      return;
    }
    box.append(
      el('dl', { class: 'kv' }, [
        el('dt', { text: 'Order' }),
        el('dd', { class: 'mono', text: '#' + o.number }),
        el('dt', { text: 'Status' }),
        el('dd', { text: o.statusLabel }),
        el('dt', { text: 'Placed' }),
        el('dd', { text: (o.placedOn || '-').slice(0, 10) }),
        el('dt', { text: 'Tracking' }),
        el('dd', { text: o.tracking.length ? o.tracking.map((x) => x.provider + ' ' + x.number).join(', ') : 'none recorded' }),
        el('dt', { text: 'ETA' }),
        el('dd', { text: o.estimatedDelivery ? o.estimatedDelivery + ' (from store)' : 'not provided by store, not guessed' }),
      ]),
      el(
        'ul',
        { class: 'order-items' },
        o.items.map((i) => el('li', { text: i.quantity + '× ' + i.name })),
      ),
    );
  }

  function renderCrm(t) {
    const box = $('crm');
    box.replaceChildren();
    const crm = state.crm;
    const turnUpdates = t ? t.crmUpdates : [];
    if (!crm && turnUpdates.length === 0) {
      box.className = 'empty';
      box.textContent = 'No CRM activity yet.';
      return;
    }
    box.className = 'crm-grid';
    if (turnUpdates.length) {
      box.append(el('div', {}, [el('p', { class: 'crm-sub', text: 'This turn' }), el('ul', { class: 'crm-list' }, turnUpdates.map((u) => el('li', { text: u })))]));
    }
    if (crm) {
      box.append(
        el('div', {}, [
          el('p', { class: 'crm-sub', text: 'Tickets (' + crm.tickets.length + ')' }),
          crm.tickets.length
            ? el(
                'ul',
                { class: 'crm-list' },
                crm.tickets
                  .slice()
                  .reverse()
                  .map((k) => el('li', {}, [el('code', { text: k.id }), ' ', tag(k.priority, k.priority === 'HIGH' ? 'error' : 'blocked'), ' ', k.subject, el('div', { class: 'muted small', text: 'linked contact: ' + (k.contactId || 'none') })])),
              )
            : el('p', { class: 'muted small', text: 'No tickets. Tickets are kept separate from deals; no deals are created.' }),
        ]),
        el('div', {}, [
          el('p', { class: 'crm-sub', text: 'Contacts (' + crm.contacts.length + ')' }),
          el(
            'ul',
            { class: 'crm-list' },
            crm.contacts.map((c) => el('li', {}, [el('code', { text: c.id }), ' ', c.firstname || 'unnamed', el('div', { class: 'muted small', text: [c.phone, c.email].filter(Boolean).join(' · ') })])),
          ),
        ]),
      );
    }
  }

  function renderAll() {
    renderChat();
    const t = currentTurn();
    renderIntent(t);
    renderTools(t);
    renderOrder(t);
    renderCrm(t);
  }

  async function refresh() {
    try {
      const turns = await api('/api/turns?limit=60');
      state.turns = turns.turns;
      if (state.status && state.status.demo_mode) state.crm = await api('/api/crm');
      renderAll();
    } catch (err) {
      console.error(err);
    }
  }

  // ---------------------------------------------------------------- init
  async function init() {
    try {
      state.status = await api('/api/status');
    } catch {
      $('mode-banner').hidden = false;
      $('mode-banner').textContent = 'Could not load status. In live mode open this page as /#token=<ADMIN_TOKEN>.';
      return;
    }
    renderStatus();
    if (state.status.demo_mode) {
      try {
        state.fixtures = await api('/api/demo/fixtures');
      } catch {
        state.fixtures = null;
      }
    }
    renderFixtures();

    $('sender').addEventListener('change', (e) => {
      state.sender = e.target.value;
      state.selectedTurn = null;
      renderAll();
    });
    $('composer').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = $('text');
      const c = state.fixtures && state.fixtures.customers.find((x) => x.waId === state.sender);
      const text = input.value;
      input.value = '';
      send(text, state.sender, c ? c.name : undefined);
    });
    $('reset').hidden = !state.status.demo_mode;
    $('reset').addEventListener('click', async () => {
      await api('/api/demo/reset', { method: 'POST', body: '{}' });
      state.selectedTurn = null;
      await refresh();
    });

    await refresh();
    setInterval(() => {
      if (!document.hidden && !state.busy) refresh();
    }, 2000);
  }

  init();
})();
