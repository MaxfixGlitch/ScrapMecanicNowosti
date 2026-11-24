import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { NewsPublisher, messageFor, plainText, validateFeed } from './worker.mjs';

const old = { gid: '1', date: '100', title: 'Старая новость', body: '<p>Текст</p>', translated: true };
const fresh = { ...old, gid: '2', date: '200', title: 'Новый патч' };
const env = { VK_GROUP: 'scrapmehi', VK_TOKEN: 'secret', ADMIN_SECRET: 'admin' };

class Storage {
  data = new Map();
  async get(k) { return structuredClone(this.data.get(k)); }
  async put(k, v) { this.data.set(k, structuredClone(v)); }
  async delete(k) { this.data.delete(k); }
  async transaction(fn) {
    const before = structuredClone(this.data);
    try { return await fn(this); } catch (e) { this.data = before; throw e; }
  }
}
function setup() {
  const storage = new Storage();
  const publisher = new NewsPublisher({ storage }, env);
  return { storage, publisher };
}
function api(items, options = {}) {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    if (url.includes('news.json')) return Response.json({ appid: 387990, items });
    if (url.endsWith('groups.getById')) return Response.json({ response: { groups: [{ id: 123, screen_name: 'scrapmehi' }] } });
    if (url.endsWith('wall.post')) {
      if (options.fail) throw new Error('network');
      if (options.error) return Response.json({ error: { error_code: 27, request_params: [{ value: env.VK_TOKEN }] } });
      return Response.json({ response: { post_id: 42 } });
    }
    throw new Error('Unexpected URL: ' + url);
  };
  return { fetcher, calls, posts: () => calls.filter(c => c.url.endsWith('wall.post')) };
}

test('HTML converts paragraphs and lists; long posts have a site link', () => {
  assert.equal(plainText('<p>Привет&nbsp;&amp; мир</p><ul><li>Раз</li><li>Два</li></ul><script>bad</script>'), 'Привет & мир\n\n• Раз\n• Два');
  const text = messageFor({ ...fresh, body: 'я'.repeat(20000) });
  assert.ok(text.length < 11000);
  assert.match(text, /#p-2$/);
  assert.match(text, /Полный текст/);
});

test('reject invalid, empty, duplicate and wrong-app feeds', () => {
  for (const items of [[], [{ ...old, gid: undefined }], [{ ...old, date: 'NaN' }], [old, old]]) {
    assert.throws(() => validateFeed({ appid: 387990, items }));
  }
  assert.throws(() => validateFeed({ appid: 1, items: [old] }));
});

test('first run records archive, never posts it', async () => {
  const { publisher, storage } = setup();
  const mock = api([old]);
  assert.deepEqual(await publisher.run(mock.fetcher), { initialized: true, archived: 1, posted: 0 });
  assert.equal(mock.posts().length, 0);
  assert.equal((await storage.get('item:1')).status, 'archive');
});

test('posts from group, uses stable guid, no repeats even after restart or edits', async () => {
  const { publisher, storage } = setup();
  await publisher.run(api([old]).fetcher);
  const mock = api([fresh, old]);
  assert.equal((await publisher.run(mock.fetcher)).posted, 1);
  const params = mock.posts()[0].init.body;
  assert.equal(params.get('owner_id'), '-123');
  assert.equal(params.get('from_group'), '1');
  assert.equal(params.get('guid'), 'sm-2');
  assert.equal(params.get('access_token'), 'secret');
  assert.equal(await storage.get('pending'), undefined);
  const restarted = new NewsPublisher({ storage }, env);
  const changed = api([{ ...fresh, title: 'Обновлённый патч' }, old]);
  assert.equal((await restarted.run(changed.fetcher)).posted, 0);
});

test('waits for translation, ignores newly discovered archive', async () => {
  const { publisher } = setup();
  await publisher.run(api([old]).fetcher);
  const mock = api([{ ...fresh, translated: false }, { ...old, gid: '9', date: '50' }]);
  assert.equal((await publisher.run(mock.fetcher)).posted, 0);
  assert.equal((await publisher.run(api([fresh, old]).fetcher)).posted, 1);
});

test('unknown result persists and blocks automatic retries', async () => {
  const { publisher, storage } = setup();
  await publisher.run(api([old]).fetcher);
  const mock = api([fresh, old], { fail: true });
  await assert.rejects(publisher.run(mock.fetcher));
  assert.equal((await storage.get('pending')).gid, '2');
  const restarted = new NewsPublisher({ storage }, env);
  const next = api([fresh, old]);
  await assert.rejects(restarted.run(next.fetcher), /Есть запись/);
  assert.equal(next.calls.length, 0);
});

test('VK errors do not expose token or raw request_params', async () => {
  const { publisher } = setup();
  await publisher.run(api([old]).fetcher);
  await assert.rejects(publisher.run(api([fresh], { error: true }).fetcher), error => {
    assert.match(error.message, /27/);
    assert.ok(!error.message.includes('secret'));
    return true;
  });
});

test('backlog is oldest first, max three posts per run', async () => {
  const { publisher } = setup();
  await publisher.run(api([old]).fetcher);
  const mock = api([5, 4, 3, 2].map(n => ({ ...fresh, gid: String(n), date: String(n * 100) })));
  assert.equal((await publisher.run(mock.fetcher)).posted, 3);
  assert.deepEqual(mock.posts().map(c => c.init.body.get('guid')), ['sm-2', 'sm-3', 'sm-4']);
  assert.equal((await publisher.run(mock.fetcher)).posted, 1);
});

test('resolve requires correct pending gid, records decision', async () => {
  const { publisher, storage } = setup();
  await storage.put('pending', { gid: '2' });
  const resolve = (gid, action) => publisher.fetch(new Request('https://internal/resolve', {
    method: 'POST', body: JSON.stringify({ gid, action }),
  }));
  assert.equal((await resolve('1', 'published')).status, 400);
  assert.equal((await resolve('2', 'published')).status, 200);
  assert.equal(await storage.get('pending'), undefined);
  assert.equal((await storage.get('item:2')).status, 'published');
});

test('public routes never trigger publishing; admin operations require secret and method', async () => {
  const safeEnv = { ...env, PUBLISHER: { get() { throw new Error('Must not reach DO'); } } };
  for (const path of ['/run', '/status', '/resolve']) {
    assert.equal((await worker.fetch(new Request('https://bot' + path), safeEnv)).status, 401);
  }
  assert.equal((await worker.fetch(new Request('https://bot/'), safeEnv)).status, 200);
  assert.equal((await worker.fetch(new Request('https://bot/run', { headers: { Authorization: 'Bearer admin' } }), safeEnv)).status, 405);
  assert.equal((await worker.fetch(new Request('https://bot/status', { headers: { Authorization: 'Bearer admin' } }), { ...safeEnv, ADMIN_SECRET: '' })).status, 401);
});

test('concurrent object requests are serialized', async () => {
  const { publisher } = setup();
  const order = [];
  publisher.handle = async req => {
    order.push('start' + req);
    await new Promise(resolve => setTimeout(resolve, 5));
    order.push('end' + req);
    return new Response('ok');
  };
  await Promise.all([publisher.fetch(1), publisher.fetch(2)]);
  assert.deepEqual(order, ['start1', 'end1', 'start2', 'end2']);
});
