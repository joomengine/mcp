import { createHash } from 'node:crypto';
import { PNG } from 'pngjs';

type Request = (method: string, params: Record<string, unknown>) => Promise<any>;
type Invoke = (name: string, args: Record<string, any>) => Promise<any>;
const keys: Record<string, [string, number, string]> = {
  Enter: ['Enter', 13, '\uE007'],
  Tab: ['Tab', 9, '\uE004'],
  Escape: ['Escape', 27, '\uE00C'],
  Backspace: ['Backspace', 8, '\uE003'],
  Delete: ['Delete', 46, '\uE017'],
  ArrowDown: ['ArrowDown', 40, '\uE015'],
  ArrowUp: ['ArrowUp', 38, '\uE013'],
  ArrowLeft: ['ArrowLeft', 37, '\uE012'],
  ArrowRight: ['ArrowRight', 39, '\uE014'],
  Home: ['Home', 36, '\uE011'],
  End: ['End', 35, '\uE010'],
  PageUp: ['PageUp', 33, '\uE00E'],
  PageDown: ['PageDown', 34, '\uE00F'],
  Insert: ['Insert', 45, '\uE016'],
  Space: [' ', 32, '\uE00D']
};

export const usesNativeInput = (name: string) =>
  ['browser_screenshot', 'browser_pointer', 'browser_keyboard', 'browser_scroll'].includes(name);

type Box = { x: number; y: number; width: number; height: number };

// A clipped Chromium capture temporarily resizes the selected tab. Crop its visible
// viewport in Node so subsequent native input uses the original compositor geometry.
async function captureChromiumRegion(request: Request, region: Box & { viewport: Box }) {
  const { data } = await request('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const bytes = Buffer.from(data, 'base64');
  const view = region.viewport;
  if (region.x === view.x && region.y === view.y && region.width === view.width && region.height === view.height)
    return bytes;
  const image = PNG.sync.read(bytes);
  const scaleX = image.width / view.width;
  const scaleY = image.height / view.height;
  const left = Math.round((region.x - view.x) * scaleX);
  const top = Math.round((region.y - view.y) * scaleY);
  const right = Math.round((region.x + region.width - view.x) * scaleX);
  const bottom = Math.round((region.y + region.height - view.y) * scaleY);
  if (!(left >= 0 && top >= 0 && right <= image.width && bottom <= image.height && right > left && bottom > top))
    throw new Error('The selected surface is outside the captured viewport.');
  const cropped = new PNG({ width: right - left, height: bottom - top });
  PNG.bitblt(image, cropped, left, top, cropped.width, cropped.height, 0, 0);
  return PNG.sync.write(cropped);
}

/** Render and interact in the selected tab only. A separate native protocol is needed for the editor's opaque AI iframe. */
export async function browserInput(
  name: string,
  args: Record<string, any>,
  invoke: Invoke,
  request: Request,
  firefoxContext?: string
) {
  const region = await invoke('browser_region', {
    ...args, focus: name === 'browser_keyboard', captureViewport: name === 'browser_screenshot' && !firefoxContext
  });
  if (name === 'browser_screenshot') {
    const box = {
      x: region.x + region.scrollX,
      y: region.y + region.scrollY,
      width: region.width,
      height: region.height
    };
    const bytes = firefoxContext
      ? Buffer.from((await request('browsingContext.captureScreenshot', {
          context: firefoxContext,
          origin: 'document',
          format: { type: 'image/png' },
          clip: { type: 'box', ...box }
        })).data, 'base64')
      : await captureChromiumRegion(request, region);
    if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
      throw new Error('The browser did not return a PNG screenshot.');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const { id } = await invoke('artifact_upload_begin', {
      filename: 'playground-' + (args.scope || 'site') + '.png',
      kind: 'file',
      size: bytes.length
    });
    try {
      for (let offset = 0; offset < bytes.length; offset += 262144) {
        await invoke('artifact_upload_chunk', {
          id,
          offset,
          base64: bytes.subarray(offset, offset + 262144).toString('base64')
        });
      }
      const stored = await invoke('artifact_upload_finish', { id, sha256 });
      const receipt = {
        ...stored,
        mimeType: 'image/png',
        width: region.width,
        height: region.height,
        pixelWidth: bytes.readUInt32BE(16),
        pixelHeight: bytes.readUInt32BE(20)
      };
      return {
        structuredContent: receipt,
        content: [
          { type: 'image', mimeType: 'image/png', data: bytes.toString('base64') },
          { type: 'text', text: JSON.stringify(receipt) }
        ]
      };
    } catch (error) {
      await invoke('artifact_release', { id }).catch(() => {});
      throw error;
    }
  }
  if (name === 'browser_scroll') {
    const x = region.x + args.x,
      y = region.y + args.y,
      deltaX = args.deltaX ?? 0,
      deltaY = args.deltaY;
    if (firefoxContext)
      await request('input.performActions', {
        context: firefoxContext,
        actions: [
          {
            type: 'wheel',
            id: 'je-wheel',
            actions: [{ type: 'scroll', origin: 'viewport', x, y, deltaX, deltaY }]
          }
        ]
      });
    else await request('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY });
    return { applied: true };
  }
  if (name === 'browser_pointer') {
    const x = region.x + args.x,
      y = region.y + args.y,
      action = args.action ?? 'click';
    let end: { x: number; y: number } | undefined;
    if (action === 'drag') {
      if (!Number.isInteger(args.toX) || !Number.isInteger(args.toY))
        throw new Error('A drag requires toX and toY.');
      const hit = await invoke('browser_region', { ...args, x: args.toX, y: args.toY });
      end = { x: hit.x + args.toX, y: hit.y + args.toY };
    }
    const clicks = action === 'doubleClick' ? 2 : 1;
    if (firefoxContext) {
      const actions: Array<Record<string, unknown>> = [{ type: 'pointerMove', origin: 'viewport', x, y }];
      if (action !== 'hover')
        for (let i = 0; i < clicks; i++) {
          actions.push({ type: 'pointerDown', button: 0 });
          if (end) actions.push({ type: 'pointerMove', origin: 'viewport', ...end, duration: 220 });
          actions.push({ type: 'pointerUp', button: 0 });
        }
      await request('input.performActions', {
        context: firefoxContext,
        actions: [{ type: 'pointer', id: 'je-pointer', parameters: { pointerType: 'mouse' }, actions }]
      });
    } else {
      await request('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      if (action !== 'hover')
        for (let clickCount = 1; clickCount <= clicks; clickCount++) {
          await request('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount });
          try {
            if (end)
              for (let step = 1; step <= 8; step++) {
                await request('Input.dispatchMouseEvent', {
                  type: 'mouseMoved',
                  button: 'left',
                  buttons: 1,
                  x: x + ((end.x - x) * step) / 8,
                  y: y + ((end.y - y) * step) / 8
                });
              }
          } finally {
            await request('Input.dispatchMouseEvent', {
              type: 'mouseReleased',
              ...(end ?? { x, y }),
              button: 'left',
              clickCount
            });
          }
        }
    }
    return { applied: true };
  }
  if ((args.key === undefined) === (args.text === undefined)) throw new Error('Provide either one key or text.');
  const modifiers = (args.modifiers ?? []) as string[];
  if (args.text && modifiers.length) throw new Error('Use modifiers with a named key.');
  const flags: Record<string, [number, string, number]> = {
    Alt: [1, '\uE00A', 18],
    Control: [2, '\uE009', 17],
    Meta: [4, '\uE03D', 91],
    Shift: [8, '\uE008', 16]
  };
  let selected: [string, number, string] | undefined;
  if (args.key) {
    const value = String(args.key),
      fn = /^F([1-9]|1[0-2])$/.exec(value);
    selected =
      keys[value] ?? (fn ? [value, 111 + Number(fn[1]), String.fromCharCode(0xe030 + Number(fn[1]))] : undefined);
    if (!selected && /^[A-Za-z0-9]$/.test(value)) selected = [value, value.toUpperCase().charCodeAt(0), value];
    if (!selected || modifiers.some((m) => !flags[m])) throw new Error('Unsupported keyboard key or modifier.');
  }
  if (firefoxContext) {
    const chars: string[] = selected ? [selected[2]] : Array.from(args.text as string);
    for (let offset = 0; offset < chars.length; offset += 100) {
      const actions = [
        ...modifiers.map((m) => ({ type: 'keyDown', value: flags[m]![1] })),
        ...chars.slice(offset, offset + 100).flatMap((value) => [
          { type: 'keyDown', value },
          { type: 'keyUp', value }
        ]),
        ...[...modifiers].reverse().map((m) => ({ type: 'keyUp', value: flags[m]![1] }))
      ];
      await request('input.performActions', {
        context: firefoxContext,
        actions: [{ type: 'key', id: 'je-keyboard', actions }]
      });
    }
  } else if (selected) {
    const [key, windowsVirtualKeyCode] = selected;
    const code = /^[0-9]$/.test(key)
      ? 'Digit' + key
      : /^[A-Za-z]$/.test(key)
        ? 'Key' + key.toUpperCase()
        : args.key;
    const mask = modifiers.reduce((sum, m) => sum | flags[m]![0], 0);
    const event = { key, code, windowsVirtualKeyCode, modifiers: mask };
    const value = key === 'Enter' ? '\r' : key.length === 1 ? key : '';
    await request('Input.dispatchKeyEvent', {
      type: 'keyDown',
      ...event,
      ...(value && !(mask & 7) ? { text: value } : {})
    });
    await request('Input.dispatchKeyEvent', { type: 'keyUp', ...event });
  } else await request('Input.insertText', { text: args.text });
  return { applied: true };
}
