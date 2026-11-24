(function () {
  'use strict';

  var dictionaries = window.WASMNEST_I18N || { zh: {}, en: {} };
  var root = document.documentElement;
  var storageKey = 'wasmnest.site.lang';
  var currentLang = root.dataset.lang === 'en' ? 'en' : 'zh';

  function t(key) {
    var lang = dictionaries[currentLang] || {};
    var fallback = dictionaries.zh || {};
    return lang[key] != null ? lang[key] : (fallback[key] != null ? fallback[key] : key);
  }

  function applyLanguage(lang, persist) {
    currentLang = lang === 'en' ? 'en' : 'zh';
    root.dataset.lang = currentLang;
    root.lang = currentLang === 'en' ? 'en' : 'zh-CN';

    document.title = t('meta.title');
    var description = document.querySelector('meta[name="description"]');
    if (description) description.setAttribute('content', t('meta.description'));

    document.querySelectorAll('[data-i18n]').forEach(function (element) {
      element.textContent = t(element.dataset.i18n);
    });

    document.querySelectorAll('[data-i18n-html]').forEach(function (element) {
      element.innerHTML = t(element.dataset.i18nHtml);
    });

    document.querySelectorAll('[data-i18n-aria-label]').forEach(function (element) {
      element.setAttribute('aria-label', t(element.dataset.i18nAriaLabel));
    });

    document.querySelectorAll('[data-lang-set]').forEach(function (button) {
      button.setAttribute('aria-pressed', String(button.dataset.langSet === currentLang));
    });

    document.querySelectorAll('.hash').forEach(function (button) {
      window.clearTimeout(button.copyTimer);
      button.classList.remove('is-copied');
      var action = button.querySelector('.hash-action');
      if (action) action.textContent = t('download.copyHash');
    });

    document.querySelectorAll('.copy-btn.is-copied').forEach(function (button) {
      button.classList.remove('is-copied');
      button.setAttribute('aria-label', t('sdk.copy'));
    });

    if (persist) {
      try { localStorage.setItem(storageKey, currentLang); } catch (error) {}
    }

    updateMenuLabel();
    root.classList.remove('i18n-pending');
  }

  applyLanguage(currentLang, false);

  document.querySelectorAll('[data-lang-set]').forEach(function (button) {
    button.addEventListener('click', function () {
      var next = button.dataset.langSet === 'en' ? 'en' : 'zh';
      if (next === currentLang) return;
      try {
        var url = new URL(window.location.href);
        if (url.searchParams.has('lang')) {
          url.searchParams.delete('lang');
          window.history.replaceState(null, '', url);
        }
      } catch (error) {}
      applyLanguage(next, true);
    });
  });

  var header = document.getElementById('siteHeader');
  var menuButton = document.getElementById('menuBtn');
  var nav = document.getElementById('primaryNav');

  function menuIsOpen() {
    return nav.classList.contains('is-open');
  }

  function updateMenuLabel() {
    if (!menuButton) return;
    menuButton.setAttribute('aria-label', t(menuIsOpen() ? 'nav.menuCloseLabel' : 'nav.menuLabel'));
  }

  function closeMenu() {
    if (!menuIsOpen()) return;
    nav.classList.remove('is-open');
    menuButton.classList.remove('is-open');
    menuButton.setAttribute('aria-expanded', 'false');
    updateMenuLabel();
  }

  if (menuButton && nav) {
    menuButton.addEventListener('click', function () {
      var open = !menuIsOpen();
      nav.classList.toggle('is-open', open);
      menuButton.classList.toggle('is-open', open);
      menuButton.setAttribute('aria-expanded', String(open));
      updateMenuLabel();
    });

    nav.querySelectorAll('a').forEach(function (link) {
      link.addEventListener('click', closeMenu);
    });

    document.addEventListener('click', function (event) {
      if (menuIsOpen() && !header.contains(event.target)) closeMenu();
    });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') closeMenu();
    });

    window.addEventListener('resize', function () {
      if (window.innerWidth > 960) closeMenu();
    }, { passive: true });
  }

  if (header) {
    var syncHeader = function () {
      header.classList.toggle('is-scrolled', window.scrollY > 10);
    };
    syncHeader();
    window.addEventListener('scroll', syncHeader, { passive: true });
  }

  var navLinks = Array.prototype.slice.call(document.querySelectorAll('.primary-nav a[href^="#"]:not(.nav-mobile-cta)'));
  var sections = navLinks.map(function (link) {
    return document.querySelector(link.getAttribute('href'));
  }).filter(Boolean);

  if ('IntersectionObserver' in window && sections.length) {
    var visibleSections = new Set();
    var sectionObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) visibleSections.add(entry.target.id);
        else visibleSections.delete(entry.target.id);
      });
      var active = sections.find(function (section) { return visibleSections.has(section.id); });
      navLinks.forEach(function (link) {
        var isActive = Boolean(active) && link.getAttribute('href') === '#' + active.id;
        if (isActive) link.setAttribute('aria-current', 'location');
        else link.removeAttribute('aria-current');
      });
    }, { rootMargin: '-45% 0px -50% 0px', threshold: 0 });
    sections.forEach(function (section) { sectionObserver.observe(section); });
  }

  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var revealTargets = document.querySelectorAll(
    '.stats, .repo-card, .bento-card, .arch-step, .arch-map, .shot, .app-card, .dl-card, .sdk-card, .code-window, .sdk-aside, .quickstart-grid > div, .faq-intro, .faq-item'
  );

  if (!reduceMotion && 'IntersectionObserver' in window) {
    revealTargets.forEach(function (element, index) {
      element.classList.add('reveal');
      element.style.setProperty('--reveal-delay', (index % 3) * 70 + 'ms');
    });

    var revealObserver = new IntersectionObserver(function (entries, observer) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-in');
        observer.unobserve(entry.target);
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });

    revealTargets.forEach(function (element) { revealObserver.observe(element); });
  }

  var filterButtons = Array.prototype.slice.call(document.querySelectorAll('.filter'));
  var appCards = Array.prototype.slice.call(document.querySelectorAll('.app-card'));

  filterButtons.forEach(function (button) {
    button.addEventListener('click', function () {
      var filter = button.dataset.filter;
      filterButtons.forEach(function (other) {
        var active = other === button;
        other.classList.toggle('is-active', active);
        other.setAttribute('aria-pressed', String(active));
      });
      appCards.forEach(function (card) {
        var show = true;
        if (filter === 'app' || filter === 'service') show = card.dataset.kind === filter;
        else if (filter === 'dual') show = (card.dataset.ends || '').indexOf('mobile') !== -1;
        card.hidden = !show;
      });
    });
  });

  var copyStatus = document.getElementById('copyStatus');

  function announce(message) {
    if (!copyStatus) return;
    copyStatus.textContent = '';
    window.setTimeout(function () { copyStatus.textContent = message; }, 20);
  }

  function writeClipboard(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).catch(function () {
        return legacyCopy(text);
      });
    }
    return legacyCopy(text);
  }

  function legacyCopy(text) {
    return new Promise(function (resolve, reject) {
      var area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      try {
        var ok = document.execCommand('copy');
        area.remove();
        ok ? resolve() : reject(new Error('copy failed'));
      } catch (error) {
        area.remove();
        reject(error);
      }
    });
  }

  function copiedLabel(button) {
    button.classList.add('is-copied');
    button.setAttribute('aria-label', t('download.copied'));
    announce(t('download.copied'));
    window.setTimeout(function () {
      button.classList.remove('is-copied');
      button.setAttribute('aria-label', t('sdk.copy'));
    }, 1800);
  }

  function copyHash(button) {
    var action = button.querySelector('.hash-action');
    button.classList.add('is-copied');
    if (action) action.textContent = t('download.copied');
    announce(t('download.copied'));
    window.clearTimeout(button.copyTimer);
    button.copyTimer = window.setTimeout(function () {
      button.classList.remove('is-copied');
      if (action) action.textContent = t('download.copyHash');
    }, 1800);
  }

  document.querySelectorAll('[data-copy], [data-copy-target]').forEach(function (button) {
    button.addEventListener('click', function () {
      var text = button.dataset.copy;
      if (!text && button.dataset.copyTarget) {
        var source = document.getElementById(button.dataset.copyTarget);
        text = source ? source.textContent : '';
      }
      if (!text) return;

      writeClipboard(text).then(function () {
        if (button.classList.contains('hash')) copyHash(button);
        else copiedLabel(button);
      }).catch(function () {
        announce(t('download.copyFailed'));
      });
    });
  });

  var faqItems = Array.prototype.slice.call(document.querySelectorAll('.faq-item'));
  faqItems.forEach(function (item) {
    item.addEventListener('toggle', function () {
      if (!item.open) return;
      faqItems.forEach(function (other) {
        if (other !== item) other.open = false;
      });
    });
  });
})();