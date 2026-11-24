import { browserUiDispatch } from './browser-ui.js';
import { jcbDispatch } from './jcb.js';
import { nativeDispatch } from './joomla-native.js';
import { joomlaApi } from './joomla-browser.js';
import { lifecycleTools, workspaceLifecycle } from './lifecycle.js';
import { dispatch } from './runtime.js';

/** A fixed handler chosen by the host. User arguments travel as structured data. */
export function browserHandlerSource(operation: string): string {
  const handler = lifecycleTools.some(tool => tool.name === operation) ? workspaceLifecycle : operation === 'joomla.api' ? joomlaApi
    : operation.startsWith('native_') ? nativeDispatch
    : operation.startsWith('browser_') ? browserUiDispatch
    : operation === 'site_console' || operation.startsWith('jcb_') || operation === 'extension_install' || operation === 'extension_enable_plugin' ? jcbDispatch : dispatch;
  const parameters = handler === joomlaApi ? 'this, args' : 'this, op, args';
  return 'async function(op, args) { const rt = this.agentCurrent?.() ?? this; return (' + handler.toString() + ')(' + parameters.replace('this', 'rt') + '); }';
}
