// Shared local mock of the opencode v2 server for unit tests.
//
// It models only the routes unibridge is allowed to use (`/api/...`). Tests
// configure model metadata, assistant replies, and event streams; the mock
// records every request body so assertions can inspect the exact wire shape.
import http from 'node:http';

export function v2Model(id, overrides = {}) {
  return {
    id,
    modelID: id,
    providerID: 'opencode',
    name: id,
    compatibility: null,
    capabilities: { tools: true, input: ['text'], output: ['text'] },
    variants: [],
    status: 'active',
    enabled: true,
    limit: { context: 200000, output: 32000 },
    ...overrides,
  };
}

export function v2Assistant({ text = 'ok', reasoning = '', finish = 'stop', tokens, error, tools = [] } = {}) {
  const content = [];
  if (reasoning) content.push({ type: 'reasoning', text: reasoning });
  for (const tool of tools) content.push({ type: 'tool', id: `tool_${tool}`, name: tool, state: { status: 'error' } });
  if (text) content.push({ type: 'text', text });
  return {
    id: 'msg_mock_assistant',
    type: 'assistant',
    content,
    finish: error ? 'error' : finish,
    ...(error ? { error } : {}),
    tokens: tokens ?? { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
  };
}

export function v2TextEvents({
  text = 'ok',
  reasoning = '',
  usage = { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
  finish = 'stop',
} = {}) {
  const events = [];
  events.push({ type: 'server.connected', data: {} });
  if (reasoning) {
    events.push({ type: 'session.reasoning.started', data: { sessionID: '{session}', assistantMessageID: 'msg_mock_assistant', ordinal: 0 } });
    events.push({ type: 'session.reasoning.delta', data: { sessionID: '{session}', assistantMessageID: 'msg_mock_assistant', ordinal: 0, delta: reasoning } });
    events.push({ type: 'session.reasoning.ended', data: { sessionID: '{session}', assistantMessageID: 'msg_mock_assistant', ordinal: 0, text: reasoning } });
  }
  if (text) {
    events.push({ type: 'session.text.started', data: { sessionID: '{session}', assistantMessageID: 'msg_mock_assistant', ordinal: 0 } });
    // Split the reply the way a real stream arrives: several deltas.
    for (let i = 0; i < text.length; i += 5) {
      events.push({ type: 'session.text.delta', data: { sessionID: '{session}', assistantMessageID: 'msg_mock_assistant', ordinal: 0, delta: text.slice(i, i + 5) } });
    }
    events.push({ type: 'session.text.ended', data: { sessionID: '{session}', assistantMessageID: 'msg_mock_assistant', ordinal: 0, text } });
  }
  events.push({ type: 'session.step.ended', data: { sessionID: '{session}', assistantMessageID: 'msg_mock_assistant', finish, rawFinish: finish, tokens: usage } });
  events.push({ type: 'session.usage.updated', data: { sessionID: '{session}', tokens: usage } });
  events.push({ type: 'session.execution.succeeded', data: { sessionID: '{session}' } });
  return events;
}

export async function createV2Mock(options = {}) {
  const opts = {
    models: options.models,
    modelStatus: options.modelStatus ?? 200,
    sessionStatus: options.sessionStatus ?? 200,
    promptStatus: options.promptStatus ?? 200,
    messageStatus: options.messageStatus ?? 200,
    eventStatus: options.eventStatus ?? 200,
    waitStatus: options.waitStatus ?? 204,
    permissionStatus: options.permissionStatus ?? 200,
    sessionDelayMs: options.sessionDelayMs ?? 0,
    assistant: options.assistant,
    events: options.events,
    permissions: options.permissions,
    watcher: options.watcher ?? null,
  };

  const state = {
    modelCalls: 0,
    sessionCalls: 0,
    sessionBodies: [],
    sessionIDs: [],
    promptBodies: [],
    promptSessions: [],
    messageCalls: 0,
    messageQueries: [],
    eventConnections: 0,
    permissionLists: 0,
    permissionReplies: [],
    waitCalls: 0,
    deleted: [],
    syntheticBodies: [],
    seen: [],
  };

  const sessions = new Map(); // id -> {promptSeen: bool, permissions: []}

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const path = url.pathname;
      state.seen.push({ method: req.method, path, query: url.search, body: body || null });

      const json = (status, value) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(value));
      };

      if (req.method === 'GET' && path === '/api/model') {
        state.modelCalls++;
        if (opts.modelStatus !== 200) return json(opts.modelStatus, { error: 'model error' });
        const data = typeof opts.models === 'function' ? opts.models(state.modelCalls) : (opts.models ?? [v2Model('alpha')]);
        return json(200, { location: { directory: '/' }, data });
      }

      if (req.method === 'POST' && path === '/api/session') {
        state.sessionCalls++;
        let parsed = null;
        try { parsed = JSON.parse(body); } catch { parsed = null; }
        state.sessionBodies.push(parsed);
        if (opts.sessionStatus !== 200) return json(opts.sessionStatus, { error: 'session error' });
        const id = `ses_mock_${state.sessionCalls}`;
        state.sessionIDs.push(id);
        sessions.set(id, { promptSeen: false, permissions: [] });
        const reply = () => json(200, { data: { id, model: parsed?.model ?? null } });
        if (opts.sessionDelayMs > 0) setTimeout(reply, opts.sessionDelayMs);
        else reply();
        return;
      }

      const sessionMatch = path.match(/^\/api\/session\/([^/]+)(\/.*)?$/);
      if (sessionMatch) {
        const sessionID = decodeURIComponent(sessionMatch[1]);
        const rest = sessionMatch[2] ?? '';
        const session = sessions.get(sessionID) ?? { promptSeen: false, permissions: opts.permissions ?? [] };
        sessions.set(sessionID, session);

        if (req.method === 'POST' && rest === '/prompt') {
          let parsed = null;
          try { parsed = JSON.parse(body); } catch { parsed = null; }
          state.promptBodies.push(parsed);
          state.promptSessions.push(sessionID);
          session.promptSeen = true;
          if (opts.promptStatus !== 200) return json(opts.promptStatus, { error: 'prompt error' });
          return json(200, { data: { id: 'msg_mock_user', sessionID, type: 'user', payload: { text: parsed?.text } } });
        }

        if (req.method === 'POST' && rest === '/synthetic') {
          let parsed = null;
          try { parsed = JSON.parse(body); } catch { parsed = null; }
          state.syntheticBodies.push(parsed);
          return json(200, { data: { id: 'msg_mock_synthetic', sessionID, type: 'synthetic', payload: parsed } });
        }

        if (req.method === 'GET' && rest === '/message') {
          state.messageCalls++;
          state.messageQueries.push(url.search);
          if (opts.messageStatus !== 200) return json(opts.messageStatus, { error: 'message error' });
          if (!session.promptSeen) return json(200, { data: [], cursor: { previous: null, next: null } });
          const assistant = typeof opts.assistant === 'function'
            ? opts.assistant(sessionID, state.promptBodies[state.promptBodies.length - 1])
            : opts.assistant;
          const list = Array.isArray(assistant) ? assistant : [assistant ?? v2Assistant()];
          return json(200, { data: list, cursor: { previous: null, next: null } });
        }

        if (req.method === 'GET' && rest === '/permission') {
          state.permissionLists++;
          if (opts.permissionStatus !== 200) return json(opts.permissionStatus, { error: 'permission error' });
          return json(200, { data: session.permissions });
        }

        const replyMatch = rest.match(/^\/permission\/([^/]+)\/reply$/);
        if (req.method === 'POST' && replyMatch) {
          let parsed = null;
          try { parsed = JSON.parse(body); } catch { parsed = null; }
          state.permissionReplies.push({ sessionID, permissionID: decodeURIComponent(replyMatch[1]), body: parsed });
          session.permissions = session.permissions.filter(p => p.id !== decodeURIComponent(replyMatch[1]));
          return json(204, {});
        }

        if (req.method === 'DELETE' && rest === '') {
          state.deleted.push(sessionID);
          return json(204, {});
        }

        return json(404, { error: 'not found' });
      }

      if (req.method === 'POST' && path === '/api/experimental/session') {
        return json(404, { error: 'not found' });
      }
      const waitMatch = path.match(/^\/api\/experimental\/session\/([^/]+)\/wait$/);
      if (req.method === 'POST' && waitMatch) {
        state.waitCalls++;
        if (opts.waitStatus !== 204) return json(opts.waitStatus, { error: 'wait error' });
        res.writeHead(204);
        return res.end();
      }

      if (req.method === 'GET' && path === '/api/event') {
        state.eventConnections++;
        if (opts.eventStatus !== 200) return json(opts.eventStatus, { error: 'event error' });
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write(': heartbeat\n\n');
        const sessionID = state.sessionIDs[state.sessionIDs.length - 1] ?? 'ses_mock';
        let events = typeof opts.events === 'function'
          ? opts.events(sessionID)
          : opts.events;
        if (!events) events = v2TextEvents();
        for (const event of events) {
          const resolved = JSON.parse(JSON.stringify(event).replaceAll('{session}', sessionID));
          res.write(`data: ${JSON.stringify(resolved)}\n\n`);
        }
        return res.end();
      }

      return json(404, { error: `unhandled ${req.method} ${path}` });
    });
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  return {
    server,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    state,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}
