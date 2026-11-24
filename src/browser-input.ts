import { createHash } from 'node:crypto';

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
  Space: [' ', 32, '\uE00D']
};

export const usesNativeInput = (name: string) =>
  ['browser_screenshot', 'browser_pointer', 'browser_keyboard', 'browser_scroll'].includes(name);

/** Render and interact in the selected tab only. A separate native protocol is needed for the editor's opaque AI iframe. */
export async function browserInput(
  name: string,
  args: Record<string, any>,
  invoke: Invoke,
  request: Request,
  firefoxContext?: string
) {
  const region = await invoke('browser_region', { ...args, focus: name === 'browser_keyboard' });
  if (name === 'browser_screenshot') {
    const box = {
      x: region.x + region.scrollX,
      y: region.y + region.scrollY,
      width: region.width,
      height: region.height
    };
    const capture = firefoxContext
      ? await request('browsingContext.captureScreenshot', {
          context: firefoxContext,
          origin: 'document',
          format: { type: 'image/png' },
          clip: { type: 'box', ...box }
        })
      : await request('Page.captureScreenshot', {
          format: 'png',
          clip: { ...box, scale: 1 },
          captureBeyondViewport: false
        });
    const bytes = Buffer.from(capture.data, 'base64');
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
          { type: 'image', mimeType: 'image/png', data: capture.data },
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
      y = region.y + args.y;
    if (firefoxContext) {
      await request('input.performActions', {
        context: firefoxContext,
        actions: [
          {
            type: 'pointer',
            id: 'je-pointer',
            parameters: { pointerType: 'mouse' },
            actions: [
              { type: 'pointerMove', origin: 'viewport', x, y },
              { type: 'pointerDown', button: 0 },
              { type: 'pointerUp', button: 0 }
            ]
          }
        ]
      });
    } else {
      await request('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await request('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    }
    return { applied: true };
  }
  if ((args.key === undefined) === (args.text === undefined)) throw new Error('Provide either one key or text.');
  if (firefoxContext) {
    const chars: string[] = args.key ? [keys[args.key]![2]] : Array.from(args.text as string);
    for (let offset = 0; offset < chars.length; offset += 100) {
      const actions = chars.slice(offset, offset + 100).flatMap((value) => [
        { type: 'keyDown', value },
        { type: 'keyUp', value }
      ]);
      await request('input.performActions', {
        context: firefoxContext,
        actions: [{ type: 'key', id: 'je-keyboard', actions }]
      });
    }
  } else if (args.key) {
    const [key, windowsVirtualKeyCode] = keys[args.key]!;
    const event = { key, code: args.key, windowsVirtualKeyCode };
    await request('Input.dispatchKeyEvent', {
      type: 'keyDown',
      ...event,
      ...(args.key === 'Enter' ? { text: '\r' } : args.key === 'Space' ? { text: ' ' } : {})
    });
    await request('Input.dispatchKeyEvent', { type: 'keyUp', ...event });
  } else await request('Input.insertText', { text: args.text });
  return { applied: true };
}
