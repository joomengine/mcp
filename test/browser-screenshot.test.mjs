import assert from 'node:assert/strict';
import test from 'node:test';
import { PNG } from 'pngjs';
import { browserInput } from '../dist/browser-input.js';

test('Chromium returns and stores only the selected pixels from a scaled, offset viewport', async () => {
  const image = new PNG({ width: 8, height: 6 });
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      image.data.set([x, y, 0, 255], 4 * (y * image.width + x));
    }
  }
  const region = { x: 11, y: 22, width: 2, height: 1, viewport: { x: 10, y: 20, width: 4, height: 3 } };
  const chunks = [];
  const invoke = async (name, args) => {
    switch (name) {
      case 'browser_region': return region;
      case 'artifact_upload_begin': return { id: 'shot' };
      case 'artifact_upload_chunk': chunks.push(Buffer.from(args.base64, 'base64')); return;
      case 'artifact_upload_finish': return { id: args.id };
      default: assert.fail(name);
    }
  };
  const request = async (method, params) => {
    assert.equal(method, 'Page.captureScreenshot');
    assert.deepEqual(params, { format: 'png', captureBeyondViewport: false });
    return { data: PNG.sync.write(image).toString('base64') };
  };
  const shot = await browserInput('browser_screenshot', { scope: 'ai' }, invoke, request);
  const bytes = Buffer.from(shot.content[0].data, 'base64');
  assert.deepEqual(Buffer.concat(chunks), bytes);
  const crop = PNG.sync.read(bytes);
  assert.deepEqual([crop.width, crop.height], [4, 2]);
  for (let y = 0; y < crop.height; y++) {
    for (let x = 0; x < crop.width; x++) {
      const offset = 4 * (y * crop.width + x);
      assert.deepEqual([...crop.data.subarray(offset, offset + 4)], [x + 2, y + 4, 0, 255]);
    }
  }
});
