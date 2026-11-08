/* Orbit website widget: <script src="https://orbit.app/widget.js" data-orbit="your-business" async></script> */
(function () {
  var s = document.currentScript || document.querySelector('script[data-orbit]');
  if (!s) return;
  var slug = s.getAttribute('data-orbit');
  if (!/^[a-z0-9-]{1,64}$/.test(slug || '')) return;
  var base = new URL(s.src).origin;
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.setAttribute('aria-label', 'Chat with us');
  btn.textContent = '💬';
  btn.style.cssText = 'position:fixed;right:16px;bottom:16px;width:60px;height:60px;border-radius:50%;border:none;background:#3b5bdb;color:#fff;font-size:26px;box-shadow:0 4px 16px rgba(0,0,0,.25);cursor:pointer;z-index:2147483646';
  var frame = null;
  btn.onclick = function () {
    if (frame) { frame.remove(); frame = null; return; }
    frame = document.createElement('iframe');
    frame.src = base + '/' + slug + '?chat=1&embed=1';
    frame.title = 'Chat';
    frame.style.cssText = 'position:fixed;right:16px;bottom:88px;width:min(380px,calc(100vw - 32px));height:min(620px,calc(100vh - 120px));border:none;border-radius:16px;box-shadow:0 8px 32px rgba(0,0,0,.25);z-index:2147483647;background:#fff';
    document.body.appendChild(frame);
  };
  document.body.appendChild(btn);
})();
