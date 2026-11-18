// Build from the origin only: never copy a query, fragment, share key or session URL.
const guide = new URL('/guides/integrations.html', location.origin);
document.getElementById('guide-url').textContent = guide.href;
const button = document.getElementById('copy-brief');
const brief = document.getElementById('agent-brief');
button.hidden = false;
button.addEventListener('click', async () => {
  const status = document.getElementById('copy-status');
  try {
    await navigator.clipboard.writeText(brief.textContent);
    status.textContent = 'Instructions copied.';
  } catch {
    const range = document.createRange();
    range.selectNodeContents(brief);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    status.textContent = 'Instructions selected. Use your device’s Copy command.';
  }
});
