import assert from 'node:assert/strict';

// Use the actual owner and its own JoomEngine Code and Adminer, without disclosing owner credentials.
export async function exerciseWorkspaceSurfaces(call) {
  const shell = { scope: 'playground' };
  let page = await call('browser_inspect', { ...shell, waitForSelector: '#nav-admin:enabled' });
  assert(page.controls.some((control) => control.id === 'nav-admin'));
  const shot = await call('browser_screenshot', { scope: 'site' });
  const receipt = shot.structuredContent ?? shot;
  assert.equal(receipt.mimeType, 'image/png');
  assert(receipt.size > 100 && receipt.width > 10 && receipt.height > 10);
  assert.equal((await call('artifact_release', { id: receipt.id })).released, true);

  await call('browser_click', { ...shell, selector: '#code-button' });
  await call('browser_inspect', { scope: 'code', waitForSelector: 'body', timeoutMs: 120000 });
  await call('browser_inspect', {
    ...shell,
    waitForSelector: 'button[data-i18n="code.ai"]:enabled',
    timeoutMs: 120000
  });
  await call('browser_click', { ...shell, selector: 'button[data-i18n="code.ai"]' });
  await call('browser_inspect', { ...shell, waitForSelector: 'iframe.jec-ai-frame', timeoutMs: 60000 });
  assert.equal((await call('browser_inspect', { scope: 'ai' })).isolated, true);
  await call('browser_click', { ...shell, selector: 'button[data-i18n="code.ai"]' });
  await call('browser_click', { ...shell, selector: '#code-button:enabled' });

  await call('browser_click', { ...shell, selector: '#database-button' });
  page = await call('browser_inspect', { scope: 'database', waitForSelector: 'body', timeoutMs: 120000 });
  assert.match(page.path, /__adminer\//);
  await call('browser_click', { ...shell, selector: '#database-button:enabled' });
}
