(function () {
  'use strict';

  // =========================================
  // State
  // =========================================
  var state = {
    model: 'chatgpt',
    forensicOpen: true,
    fixState: 'after',
    phrasing: 2
  };

  // =========================================
  // Act I: Title letter-by-letter reveal
  // =========================================
  var titleEl = document.getElementById('hero-title');
  if (titleEl) {
    var word = 'Hearsay';
    var html = '';
    for (var i = 0; i < word.length; i++) {
      html += '<span class="letter" style="--delay:' + (i * 50) + 'ms">' + word[i] + '</span>';
    }
    titleEl.innerHTML = html;
  }

  // =========================================
  // Scroll cue: hide on first scroll
  // =========================================
  var scrollCue = document.querySelector('.scroll-cue');
  if (scrollCue) {
    var cueHidden = false;
    function hideCue() {
      if (!cueHidden && window.scrollY > 50) {
        cueHidden = true;
        scrollCue.classList.add('is-hidden');
        window.removeEventListener('scroll', hideCue);
      }
    }
    window.addEventListener('scroll', hideCue, { passive: true });
  }

  // =========================================
  // IntersectionObserver: scroll reveals
  // =========================================
  var prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function setupScrollReveals() {
    var revealTargets = document.querySelectorAll(
      '.reveal-on-scroll, .buyer-bubble-anim, .stagger-children, .omitted-chip-anim'
    );

    if (prefersReducedMotion) {
      // Instant display for reduced motion
      revealTargets.forEach(function (el) {
        el.classList.add('is-visible');
      });
      return;
    }

    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);

          // Trigger rec-highlight animation when fix chat becomes visible
          if (entry.target.classList.contains('fix-chat-window')) {
            var highlightEl = entry.target.querySelector('.rec-highlight-anim');
            if (highlightEl && state.fixState === 'after') {
              setTimeout(function () {
                highlightEl.classList.add('is-highlighted');
              }, 400);
            }
          }
        }
      });
    }, {
      threshold: 0.15,
      rootMargin: '0px 0px -40px 0px'
    });

    revealTargets.forEach(function (el) {
      observer.observe(el);
    });
  }

  setupScrollReveals();

  // =========================================
  // Model tabs (synced across chat + forensic)
  // =========================================
  document.querySelectorAll('[data-model]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      state.model = btn.getAttribute('data-model');
      document.querySelectorAll('[data-model]').forEach(function (b) {
        var isActive = b.getAttribute('data-model') === state.model;
        b.classList.toggle('is-active', isActive);
        if (b.hasAttribute('aria-selected')) {
          b.setAttribute('aria-selected', isActive);
        }
      });
      updateChatModel();
    });
  });

  function updateChatModel() {
    var labelEl = document.getElementById('chat-model-label');
    if (labelEl) {
      labelEl.textContent = state.model.charAt(0).toUpperCase() + state.model.slice(1);
    }
  }

  // =========================================
  // Forensic drawer: animated expand/collapse
  // =========================================
  var forensicToggle = document.getElementById('forensic-toggle-btn');
  var drawerWrap = document.getElementById('forensic-drawer-wrap');

  if (forensicToggle && drawerWrap) {
    forensicToggle.addEventListener('click', function () {
      state.forensicOpen = !state.forensicOpen;
      drawerWrap.classList.toggle('is-collapsed', !state.forensicOpen);
      forensicToggle.setAttribute('aria-expanded', state.forensicOpen);
    });
  }

  // =========================================
  // Phrasing options
  // =========================================
  document.querySelectorAll('.phrasing-option').forEach(function (opt) {
    opt.addEventListener('click', function () {
      var idx = parseInt(opt.getAttribute('data-phrasing'), 10);
      state.phrasing = idx;
      document.querySelectorAll('.phrasing-option').forEach(function (o) {
        var oIdx = parseInt(o.getAttribute('data-phrasing'), 10);
        o.classList.toggle('is-selected', oIdx === idx);
        o.setAttribute('aria-checked', oIdx === idx);
      });
    });
  });

  // =========================================
  // Before/After fix toggle with cross-fade
  // =========================================
  var fixProseEl = document.getElementById('fix-answer-prose');
  var fixCitationsEl = document.getElementById('fix-citations');
  var fixSearchSub = document.getElementById('fix-search-sub');
  var fixCaption = document.getElementById('fix-state-caption');
  var highlightAnim = document.querySelector('.rec-highlight-anim');

  var fixContent = {
    before: {
      prose: '<p>For a 40-person team needing SOC 2 Type II compliance without enterprise lock-in, two options stand out:</p>' +
        '<ul class="rec-list stagger-children is-visible">' +
        '<li><strong>Fireflies.ai</strong> — Business tier ($19/seat/mo) includes SOC 2 Type II, unlimited storage, and automatic CRM logging.</li>' +
        '<li><strong>Otter.ai</strong> — Business plan ($20/seat/mo) includes SOC 2 Type II compliance, shared team spaces, and admin controls.</li>' +
        '</ul>',
      citations: '<span class="cite-chip">Source: <code>g2.com/categories/ai-meeting-assistants</code></span>' +
        '<span class="omitted-chip">Notewell (your company) was left out</span>',
      sub: 'Searched the web',
      caption: 'SOC 2 mentioned only in prose on <code>notewell.io/pricing</code>'
    },
    after: {
      prose: '<p>For a 40-person team needing self-serve SOC 2 Type II compliance and predictable seat pricing, three tools fit well:</p>' +
        '<ul class="rec-list stagger-children is-visible">' +
        '<li class="rec-highlight rec-highlight-anim is-highlighted"><strong>Notewell</strong> — Team plan ($22/seat/mo) includes SOC 2 Type II, SAML SSO, and zero-retention controls for 40-seat teams.</li>' +
        '<li><strong>Fireflies.ai</strong> — Business tier ($19/seat/mo) includes SOC 2 Type II and CRM call logging.</li>' +
        '<li><strong>Otter.ai</strong> — Business plan ($20/seat/mo) offers SOC 2 Type II and shared workspaces.</li>' +
        '</ul>',
      citations: '<span class="cite-chip cite-chip-cobalt">Cited: <code>notewell.io/pricing</code></span>' +
        '<span class="cite-chip">Cited: <code>g2.com/categories/ai-meeting-assistants</code></span>',
      sub: 'Cited notewell.io/pricing directly',
      caption: 'SOC 2 tier table live on <code>notewell.io/pricing</code>'
    }
  };

  function applyFixState(fixState) {
    var data = fixContent[fixState];
    if (!data || !fixProseEl) return;

    // Cross-fade: opacity out, swap, opacity in
    fixProseEl.style.opacity = '0';
    if (fixCitationsEl) fixCitationsEl.style.opacity = '0';

    setTimeout(function () {
      fixProseEl.innerHTML = data.prose;
      if (fixCitationsEl) fixCitationsEl.innerHTML = data.citations;
      if (fixSearchSub) fixSearchSub.textContent = data.sub;
      if (fixCaption) fixCaption.innerHTML = data.caption;

      fixProseEl.style.opacity = '1';
      if (fixCitationsEl) fixCitationsEl.style.opacity = '1';
    }, 200);
  }

  // Add transition to fix elements
  if (fixProseEl) fixProseEl.style.transition = 'opacity 200ms ease';
  if (fixCitationsEl) fixCitationsEl.style.transition = 'opacity 200ms ease';

  document.querySelectorAll('[data-fix]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      state.fixState = btn.getAttribute('data-fix');
      document.querySelectorAll('[data-fix]').forEach(function (b) {
        var isActive = b.getAttribute('data-fix') === state.fixState;
        b.classList.toggle('is-active', isActive);
        b.setAttribute('aria-pressed', isActive);
      });
      applyFixState(state.fixState);
    });
  });

  // =========================================
  // Copy buttons
  // =========================================
  document.querySelectorAll('[data-copy-target]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var targetId = btn.getAttribute('data-copy-target');
      var text = document.getElementById(targetId).textContent;
      navigator.clipboard.writeText(text).then(function () {
        var label = btn.getAttribute('data-default-label') || btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(function () { btn.textContent = label; }, 2000);
      });
    });
  });

})();
