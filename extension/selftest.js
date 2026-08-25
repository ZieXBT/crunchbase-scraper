/* Content script on crunchbase.com. Idle until the page asks for a self-test:
 *   window.postMessage({ type: 'CBS_SELFTEST' }, '*')
 * It relays the request to the service worker (where host permissions apply)
 * and writes the outcome to #__cbs_selftest[data-result] for inspection.
 * postMessage is used because the page and content script share a window but
 * not a JS context, and the SPA rewrites the URL so a #hash trigger is unreliable. */
window.addEventListener('message', async (ev) => {
  if (ev.source !== window || !ev.data || ev.data.type !== 'CBS_SELFTEST') return;
  let node = document.getElementById('__cbs_selftest');
  if (!node) {
    node = document.createElement('div');
    node.id = '__cbs_selftest';
    node.style.display = 'none';
    document.documentElement.appendChild(node);
  }
  node.dataset.result = 'running';
  try {
    const res = await chrome.runtime.sendMessage({ type:'selftest', url: location.href });
    node.dataset.result = JSON.stringify(res);
  } catch (e) {
    node.dataset.result = JSON.stringify({ error: String((e && e.message) || e) });
  }
});
