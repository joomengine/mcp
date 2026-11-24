export interface DialogResponse {
  type: 'alert' | 'confirm' | 'prompt';
  message: string;
  accept: boolean;
  text?: string;
}

export function actionDialogs(operation: string, args: Record<string, unknown>): DialogResponse[] | undefined {
  return ['browser_click', 'browser_keyboard', 'browser_pointer'].includes(operation)
    ? ((args.dialogResponses as DialogResponse[]) ?? [])
    : undefined;
}

type Dialog = { type: string; message: string; finish(accept: boolean, text?: string): Promise<void> };
type Listener = (dialog: Dialog) => void;
type Subscribe = (onDialog: Listener) => Promise<() => Promise<void>>;

/** Handle only dialogs raised during this action. The caller identifies each accepted prompt by its text and type. */
export async function withBrowserDialogs<T>(
  responses: DialogResponse[] | undefined,
  subscribe: Subscribe,
  invoke: () => Promise<T>
) {
  if (!responses) return invoke();
  const handled: Array<{ type: string; message: string; accepted: boolean }> = [];
  const pending: Promise<void>[] = [];
  let unexpected: string | undefined;
  const unsubscribe = await subscribe((dialog) => {
    const expected = responses[handled.length];
    const matches = expected?.message === dialog.message && expected.type === dialog.type;
    const accept = !!(matches && expected.accept);
    handled.push({ type: dialog.type, message: dialog.message, accepted: accept });
    if (!matches) unexpected = 'Unexpected ' + dialog.type + ' dialog was dismissed: ' + dialog.message;
    const done = dialog.finish(accept, accept ? expected?.text : undefined);
    done.catch(() => {});
    pending.push(done);
  });
  try {
    const result = await invoke();
    await Promise.all(pending);
    if (unexpected) throw new Error(unexpected);
    return responses.length || handled.length ? { result, dialogs: handled } : result;
  } finally {
    await unsubscribe();
  }
}

type Request = (method: string, params: Record<string, unknown>) => Promise<any>;
type SubscribeEvent = (name: string, handler: (params: any) => void) => () => void;

export function debuggerDialogs(request: Request, subscribe: SubscribeEvent, firefoxContext?: string): Subscribe {
  return async (notify) => {
    const method = firefoxContext ? 'browsingContext.userPromptOpened' : 'Page.javascriptDialogOpening';
    if (!firefoxContext) await request('Page.enable', {});
    const remove = subscribe(method, (event) => {
      notify({
        type: event.type,
        message: event.message,
        async finish(accept, text) {
          if (firefoxContext)
            await request('browsingContext.handleUserPrompt', {
              context: event.context,
              accept,
              ...(text === undefined ? {} : { userText: text })
            });
          else
            await request('Page.handleJavaScriptDialog', {
              accept,
              ...(text === undefined ? {} : { promptText: text })
            });
        }
      });
    });
    const registration = firefoxContext
      ? await request('session.subscribe', { events: [method], contexts: [firefoxContext] }).catch((error) => {
          remove();
          throw error;
        })
      : null;
    return async () => {
      remove();
      if (registration) await request('session.unsubscribe', { subscriptions: [registration.subscription] });
    };
  };
}
