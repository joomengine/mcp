import { browserUiDispatch } from './browser-ui.js';
import { jcbDispatch } from './jcb.js';
import { joomlaApi } from './joomla-browser.js';
import { dispatch } from './runtime.js';

/** A fixed handler chosen by the host. User arguments travel as structured data. */
export function browserHandlerSource(operation: string): string {
  const handler = operation === 'joomla.api' ? joomlaApi
    : operation.startsWith('browser_') ? browserUiDispatch
    : operation.startsWith('jcb_') || operation === 'extension_install' || operation === 'extension_enable_plugin' ? jcbDispatch : dispatch;
  const parameters = handler === joomlaApi ? 'this, args' : 'this, op, args';
  return 'async function(op, args) { return (' + handler.toString() + ')(' + parameters + '); }';
}
