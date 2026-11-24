// Exercise plugin-supplied compiler controls using the same serialized handler as a real workspace.
import assert from 'node:assert/strict';
import { chromium, firefox } from 'playwright';
import { browserHandlerSource } from '../dist/browser-router.js';

const browser = await (process.argv[2] === 'firefox' ? firefox : chromium).launch();
try {
  const page = await browser.newPage();
  const token = '0123456789abcdef0123456789abcdef';
  const form = `<form id="adminForm" action="index.php">
    <select name="component_id" id="component_id"><option value="7">Test component</option></select>
    <select name="joomla_version" id="joomla_version"><option value="6">6</option></select>
    <input type="hidden" name="${token}" value="1"><input type="hidden" name="task" value="">
    <input type="hidden" name="features[]" value="default">
    <label><input type="checkbox" name="features[]" value="trace" checked>Trace</label>
    <label><input type="checkbox" name="features[]" value="debug">Debug</label>
    <select multiple name="targets[]"><option selected>a</option><option>b</option><option disabled>c</option></select>
    <input name="plugin[mode]" value="initial"><input name="protected_field" readonly value="fixed">
  </form>`;
  const submissions = [];
  await page.route('https://compiler.test/**', async route => {
    const request = route.request();
    if (request.method() === 'POST') submissions.push(new URLSearchParams(request.postData()));
    await route.fulfill({ status: 200, contentType: 'text/html', body: request.method() === 'POST' ? '' : form });
  });
  await page.goto('https://compiler.test/');
  await page.evaluate(source => {
    const site = new URL('/__site/test/', location.origin);
    const runtime = { baseUrl: site.href, configuration: {joomlaVersion:'6.0.0'}, request: (route, init) => fetch(new URL(route, site), init) };
    window.callCompiler = Function('return (' + source + ')')().bind(runtime);
  }, browserHandlerSource('jcb_compile'));
  const call = (op, args) => page.evaluate(([op, args]) => window.callCompiler(op, args), [op, args]);
  const catalogue = await call('jcb_list_components', {});
  const fields = new Map(catalogue.compilerOptions.map(entry => [entry.name, entry]));
  assert.deepEqual(fields.get('features[]').value, ['trace']);
  assert.deepEqual(fields.get('targets[]').choices.map(choice => choice.value), ['a', 'b']);
  assert.equal(fields.get('plugin[mode]').value, 'initial');
  assert(!fields.has(token) && !fields.has('protected_field') && !fields.has('component_id') && !fields.has('task'));
  const compile = options => call('jcb_compile', { componentId:7, joomlaMajor:6, options });
  await assert.rejects(compile({'targets[]':['c']}), /Choose a supported compiler field/);
  await assert.rejects(compile({protected_field:'write'}), /Choose a supported compiler field/);
  await assert.rejects(compile({'plugin[mode]':['invalid']}), /Choose a supported compiler field/);
  assert.equal(submissions.length, 0);
  // The fixture returns an empty compile result after accepting the form. Assert what Joomla received.
  await assert.rejects(compile({'features[]':[], 'targets[]':['b','a'], 'plugin[mode]':'custom'}), /did not report a successful compile/);
  assert.equal(submissions.length, 1);
  assert.deepEqual(submissions[0].getAll('features[]'), ['default']);
  assert.deepEqual(submissions[0].getAll('targets[]'), ['b','a']);
  assert.equal(submissions[0].get('plugin[mode]'), 'custom');
  assert.equal(submissions[0].get('task'), 'compiler.compiler');
  assert.equal(submissions[0].get(token), '1');
} finally { await browser.close(); }
