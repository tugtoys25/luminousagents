/* Sticky header behaviour: mobile menu, Sign in / Register choosers, scrolled state. */
(function () {
  var root = document.documentElement;
  root.classList.add('js');
  function init() {
    var header = document.getElementById('site-header');
    var toggle = document.querySelector('.menu-toggle');
    var panel = document.getElementById('site-menu');
    var menus = Array.prototype.slice.call(document.querySelectorAll('.auth-menu'));
    if (!header || !toggle || !panel) return;

    function setMenu(open) {
      root.classList.toggle('menu-open', open);
      toggle.setAttribute('aria-expanded', String(open));
      toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    }
    function closeAuth(except) {
      menus.forEach(function (menu) {
        if (menu === except) return;
        menu.classList.remove('open');
        var trigger = menu.querySelector('.auth-trigger');
        if (trigger) trigger.setAttribute('aria-expanded', 'false');
      });
    }

    toggle.addEventListener('click', function () {
      setMenu(!root.classList.contains('menu-open'));
    });
    panel.addEventListener('click', function (event) {
      if (event.target.closest && event.target.closest('a')) setMenu(false);
    });
    menus.forEach(function (menu) {
      var trigger = menu.querySelector('.auth-trigger');
      if (!trigger) return;
      trigger.addEventListener('click', function (event) {
        event.stopPropagation();
        var open = !menu.classList.contains('open');
        closeAuth(menu);
        menu.classList.toggle('open', open);
        trigger.setAttribute('aria-expanded', String(open));
      });
    });
    document.addEventListener('click', function (event) {
      if (!event.target.closest || !event.target.closest('.auth-menu')) closeAuth();
    });
    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape') return;
      setMenu(false);
      closeAuth();
    });
    var desktop = window.matchMedia('(min-width: 1021px)');
    var onChange = function (event) {
      if (event.matches) setMenu(false);
    };
    if (desktop.addEventListener) desktop.addEventListener('change', onChange);
    else if (desktop.addListener) desktop.addListener(onChange);

    function onScroll() {
      header.classList.toggle('is-scrolled', window.scrollY > 6);
    }
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
