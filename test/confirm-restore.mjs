// Runs only in the disposable owner page for the acceptance test. Wait for
// the upcoming ZIP upload, then answer its normal replacement dialog once.
export function armRestoreConfirmation() {
  const input = document.getElementById('upload-site-file');
  if (!(input instanceof HTMLInputElement) || input.type !== 'file' || document.querySelector('dialog[open]')) {
    throw new Error('The disposable owner must be ready to import its exported site.');
  }
  const observer = new MutationObserver(() => {
    const confirm = document.querySelector('dialog[data-live-replacement][open] button[data-replace-choice="continue"]');
    if (confirm) {
      disarm();
      confirm.click();
    }
  });
  function watchUpload() {
    if (input.files?.length === 1 && input.files[0].name.endsWith('.zip')) {
      observer.observe(document.body, { childList: true, attributes: true, subtree: true, attributeFilter: ['open'] });
    }
  }
  function disarm() {
    clearTimeout(timer);
    input.removeEventListener('change', watchUpload, true);
    observer.disconnect();
  }
  const timer = setTimeout(disarm, 10 * 60_000);
  input.addEventListener('change', watchUpload, { capture: true, once: true });
}
