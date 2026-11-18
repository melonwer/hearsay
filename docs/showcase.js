/*
 * Hearsay showcase — V2 Dynamic
 *
 * Motion stack: GSAP 3 + ScrollTrigger (pinning, scrubbing) and Lenis (inertial scroll).
 * Everything motion-related lives inside one gsap.matchMedia() context so it can be
 * torn down and rebuilt when the viewport crosses the pin breakpoint or the user turns
 * on reduced motion. Interactions (assistant switch, wording, before/after, copy) work
 * with or without the motion layer.
 */
(function () {
  'use strict';

  var root = document.documentElement;
  var PIN_QUERY = window.HEARSAY_PIN_QUERY ||
    '(min-width: 960px) and (min-height: 640px), (max-width: 959px) and (min-height: 740px)';

  var gsap = window.gsap;
  var ScrollTrigger = window.ScrollTrigger;
  var hasMotionLib = !!(gsap && ScrollTrigger);

  if (!hasMotionLib) root.classList.remove('motion', 'pin');
  else gsap.registerPlugin(ScrollTrigger);

  function $(sel, ctx) { return (ctx || document).querySelector(sel); }
  function $$(sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); }

  // ==========================================================
  // Data: one fictional scenario seen through three assistants
  // ==========================================================
  var MODELS = {
    chatgpt: {
      label: 'ChatGPT',
      color: '#10a37f',
      query: 'soc 2 type ii meeting recorder 40 person team pricing',
      intro: 'For a 40-person team needing SOC 2 Type II compliance without enterprise lock-in, two options stand out:',
      rec0name: 'Fireflies.ai',
      rec0desc: 'Business tier ($19/seat/mo) includes SOC 2 Type II, unlimited storage, and automatic CRM logging.',
      rec1name: 'Otter.ai',
      rec1desc: 'Business plan ($20/seat/mo) includes SOC 2 Type II compliance, shared team spaces, and admin controls.',
      source: 'g2.com/categories/ai-meeting-assistants',
      skip: 'Opened and read, then discarded because SOC 2 appeared only in paragraph text with no parseable tier table.',
      cited: 'Comparison grid listed Fireflies and Otter.ai side by side while omitting Notewell.'
    },
    claude: {
      label: 'Claude',
      color: '#d97757',
      query: 'best SOC 2 Type II meeting recorder for a 40 person team',
      intro: 'If SOC 2 Type II is a hard requirement for a 40-person team, these two are the safest picks:',
      rec0name: 'Otter.ai',
      rec0desc: 'Business plan ($20/seat/mo) with SOC 2 Type II, admin controls, and shared team spaces.',
      rec1name: 'Fireflies.ai',
      rec1desc: 'Business tier ($19/seat/mo) with SOC 2 Type II and automatic CRM logging.',
      source: 'g2.com/categories/ai-meeting-assistants',
      skip: 'Fetched, but seat pricing and SOC 2 details loaded inside a script widget, so the page text had nothing to quote.',
      cited: 'Category grid compared Otter.ai and Fireflies on security and price. Notewell was not listed.'
    },
    gemini: {
      label: 'Gemini',
      color: '#4285f4',
      query: 'soc 2 compliant meeting recorder team pricing comparison',
      intro: 'For a team of 40 that needs SOC 2 Type II, two recorders come up most often:',
      rec0name: 'Fireflies.ai',
      rec0desc: 'Business tier ($19/seat/mo) covers SOC 2 Type II and CRM sync.',
      rec1name: 'Otter.ai',
      rec1desc: 'Business plan ($20/seat/mo) covers SOC 2 Type II and team admin controls.',
      source: 'g2.com/categories/ai-meeting-assistants',
      skip: 'Opened, then passed over. SOC 2 was mentioned once in a paragraph, with no plan-by-plan table to cite.',
      cited: 'Side-by-side comparison of Fireflies and Otter.ai with prices and compliance. Notewell absent.'
    }
  };

  var THEME_COLORS = { light: '#ffffff', mist: '#f5f5f7', dark: '#000000' };

  var state = {
    model: 'chatgpt',
    fix: 'before',
    fixManual: false,
    phrasing: 2,
    wordingTouched: false
  };

  // ==========================================================
  // Typewriter: text revealed by a 0..1 progress value.
  // Keeps the full string on the element so an assistant switch
  // mid-type re-renders with the new text.
  // ==========================================================
  function makeTyper(el) {
    el.dataset.full = el.textContent;
    el._p = 1;
    return el;
  }
  function renderTyper(el, p) {
    if (typeof p === 'number') el._p = p;
    var full = el.dataset.full || '';
    var n = Math.round(el._p * full.length);
    el.textContent = full.slice(0, n);
    var host = el.parentElement;
    if (host) host.classList.toggle('is-typing', el._p > 0 && el._p < 1);
  }

  var buyerTyper = makeTyper($('#story-chat [data-type]'));
  var queryTyper = makeTyper($('[data-type-query]'));

  // ==========================================================
  // Segmented controls with a sliding thumb
  // ==========================================================
  function placeThumb(seg) {
    var thumb = $('.segmented-thumb', seg);
    var active = $('.seg-btn.is-active', seg);
    if (!thumb || !active) return;
    thumb.style.width = active.offsetWidth + 'px';
    thumb.style.transform = 'translateX(' + active.offsetLeft + 'px)';
  }
  function placeAllThumbs() { $$('.segmented').forEach(placeThumb); }

  $$('.segmented').forEach(function (seg) { seg.classList.add('has-thumb'); });
  placeAllThumbs();
  requestAnimationFrame(function () {
    $$('.segmented').forEach(function (seg) { seg.classList.add('thumb-ready'); });
  });
  window.addEventListener('resize', placeAllThumbs);
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(function () {
      placeAllThumbs();
      if (hasMotionLib) ScrollTrigger.refresh();
    });
  }

  // ==========================================================
  // Assistant switch (synced: story chat, receipt, fix chat)
  // ==========================================================
  function writeModelText(data) {
    $$('[data-bind]').forEach(function (el) {
      var key = el.getAttribute('data-bind');
      if (!(key in data)) return;
      if (el === queryTyper) {
        queryTyper.dataset.full = data.query;
        renderTyper(queryTyper);
      } else {
        el.textContent = data[key];
      }
    });
    root.style.setProperty('--model-color', data.color);
  }

  function setModel(model) {
    if (!MODELS[model] || model === state.model) return;
    state.model = model;
    var data = MODELS[model];

    $$('[data-model]').forEach(function (btn) {
      var on = btn.getAttribute('data-model') === model;
      btn.classList.toggle('is-active', on);
      if (btn.hasAttribute('aria-selected')) btn.setAttribute('aria-selected', String(on));
      if (btn.hasAttribute('aria-pressed')) btn.setAttribute('aria-pressed', String(on));
    });
    placeAllThumbs();

    var targets = $$('#story-chat .swap, #story-chat .assistant-name, #story-chat .chip-source code, .paper [data-bind], #fix-chat .assistant-name');

    if (!hasMotionLib || !root.classList.contains('motion')) {
      writeModelText(data);
      return;
    }

    gsap.killTweensOf(targets);
    gsap.to(targets, {
      opacity: 0,
      y: -4,
      filter: 'blur(6px)',
      duration: 0.18,
      ease: 'power2.in',
      onComplete: function () {
        writeModelText(data);
        gsap.fromTo(targets,
          { opacity: 0, y: 6, filter: 'blur(6px)' },
          { opacity: 1, y: 0, filter: 'blur(0px)', duration: 0.55, ease: 'power3.out', stagger: 0.035, clearProps: 'filter,transform' }
        );
      }
    });
  }

  $$('[data-model]').forEach(function (btn) {
    btn.addEventListener('click', function () { setModel(btn.getAttribute('data-model')); });
  });

  // Arrow-key navigation for the tablist
  var tablist = $('#story-chat [role="tablist"]');
  if (tablist) {
    tablist.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      var tabs = $$('[role="tab"]', tablist);
      var i = tabs.indexOf(document.activeElement);
      if (i < 0) return;
      var next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      next.focus();
      next.click();
      e.preventDefault();
    });
  }
  root.style.setProperty('--model-color', MODELS.chatgpt.color);

  // ==========================================================
  // Wording: three phrasings, one readout
  // ==========================================================
  var readout = $('.readout');
  var readoutNum = $('#readout-num');
  var readoutVal = { v: 0 };
  var wordingBtns = $$('.wording');

  function selectWording(idx, opts) {
    opts = opts || {};
    state.phrasing = idx;
    var rate = 0;
    wordingBtns.forEach(function (btn) {
      var on = parseInt(btn.getAttribute('data-phrasing'), 10) === idx;
      btn.classList.toggle('is-selected', on);
      btn.setAttribute('aria-checked', String(on));
      btn.tabIndex = on ? 0 : -1;
      if (on) rate = parseInt(btn.getAttribute('data-rate'), 10);
    });
    if (!readout) return;
    readout.setAttribute('data-rate', String(rate));

    if (hasMotionLib && root.classList.contains('motion')) {
      gsap.to(readoutVal, {
        v: rate,
        duration: 0.7,
        ease: 'power3.out',
        overwrite: true,
        onUpdate: function () { readoutNum.textContent = String(Math.round(readoutVal.v)); }
      });
      gsap.fromTo($$('.readout-bars i'), { scaleY: 0.55 }, { scaleY: 1, duration: 0.6, ease: 'back.out(3)', stagger: 0.04, overwrite: true });
      gsap.fromTo(readoutNum, { y: 10 }, { y: 0, duration: 0.6, ease: 'power3.out', overwrite: 'auto' });
    } else {
      readoutVal.v = rate;
      readoutNum.textContent = String(rate);
    }
    if (opts.focus) {
      var target = wordingBtns[idx];
      if (target) target.focus();
    }
  }

  wordingBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      state.wordingTouched = true;
      selectWording(parseInt(btn.getAttribute('data-phrasing'), 10));
    });
    btn.addEventListener('keydown', function (e) {
      var keys = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };
      if (!(e.key in keys)) return;
      e.preventDefault();
      state.wordingTouched = true;
      var next = (state.phrasing + keys[e.key] + wordingBtns.length) % wordingBtns.length;
      selectWording(next, { focus: true });
    });
  });
  selectWording(state.phrasing);

  // ==========================================================
  // Fix: before / after
  // ==========================================================
  var fixChat = $('#fix-chat');

  function restartClass(el, cls) {
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
  }

  function setFix(next, opts) {
    opts = opts || {};
    if (!fixChat) return;
    if (opts.manual) state.fixManual = true;
    var changed = state.fix !== next;
    state.fix = next;
    fixChat.setAttribute('data-state', next);
    $$('[data-fix]').forEach(function (btn) {
      var on = btn.getAttribute('data-fix') === next;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-pressed', String(on));
    });
    placeThumb($('.segmented', fixChat));
    if (changed && !opts.silent) {
      restartClass(fixChat, 'has-switched');
      if (next === 'after') restartClass(fixChat, 'is-celebrating');
    }
  }

  $$('[data-fix]').forEach(function (btn) {
    btn.addEventListener('click', function () { setFix(btn.getAttribute('data-fix'), { manual: true }); });
  });

  // ==========================================================
  // Film
  // ==========================================================
  var frame = $('#cinema-frame');
  if (frame) {
    var video = $('video', frame);
    var playBtn = $('.play-btn', frame);
    playBtn.addEventListener('click', function () {
      var p = video.play();
      if (p && p.catch) p.catch(function () { frame.classList.remove('is-playing'); });
      video.focus({ preventScroll: true });
    });
    video.addEventListener('play', function () { frame.classList.add('is-playing'); });
    video.addEventListener('ended', function () { frame.classList.remove('is-playing'); });
  }

  // ==========================================================
  // Copy buttons
  // ==========================================================
  var CHECK = '<svg class="check" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy') ? resolve() : reject(); } catch (err) { reject(err); }
      document.body.removeChild(ta);
    });
  }

  $$('[data-copy-target]').forEach(function (btn) {
    var label = $('.action-label', btn);
    var defaultLabel = btn.getAttribute('data-default-label');
    var timer;
    btn.addEventListener('click', function () {
      var text = document.getElementById(btn.getAttribute('data-copy-target')).textContent;
      copyText(text).then(function () {
        label.innerHTML = CHECK + 'Copied';
        restartClass(btn, 'is-copied');
      }, function () {
        label.textContent = 'Select the text to copy';
      });
      clearTimeout(timer);
      timer = setTimeout(function () {
        label.textContent = defaultLabel;
        btn.classList.remove('is-copied');
      }, 2200);
    });
  });

  // ==========================================================
  // Static mode: no animation library, or reduced motion
  // ==========================================================
  function settleStatic() {
    root.classList.remove('motion', 'pin');
    renderTyper(buyerTyper, 1);
    renderTyper(queryTyper, 1);
    $$('[data-count-to]').forEach(function (el) { el.textContent = el.getAttribute('data-count-to'); });
    if (!state.fixManual) setFix('after', { silent: true });
    var wording = $('.scene-wording');
    if (wording) wording.classList.add('is-in');
    var nav = $('.local-nav');
    if (nav) nav.classList.remove('is-tucked', 'is-dark');
    placeAllThumbs();
  }

  if (!hasMotionLib) {
    settleStatic();
    return;
  }

  // ==========================================================
  // Motion helpers
  // ==========================================================
  // Wrap each word in .w > span (for masked rise-in headings).
  function splitWords(el) {
    if (el._split) return el._split;
    var inners = [];
    var walk = function (node) {
      Array.prototype.slice.call(node.childNodes).forEach(function (child) {
        if (child.nodeType === 3) {
          var parts = child.textContent.split(/([ \n\t]+)/);
          var frag = document.createDocumentFragment();
          parts.forEach(function (part) {
            if (!part) return;
            if (/^[ \n\t]+$/.test(part)) { frag.appendChild(document.createTextNode(' ')); return; }
            var w = document.createElement('span');
            w.className = 'w';
            var inner = document.createElement('span');
            inner.textContent = part;
            w.appendChild(inner);
            frag.appendChild(w);
            inners.push(inner);
          });
          node.replaceChild(frag, child);
        } else if (child.nodeType === 1) {
          walk(child);
        }
      });
    };
    walk(el);
    el._split = inners;
    return inners;
  }

  // Wrap each word in a plain span (for scroll-scrubbed highlight text).
  function splitPlain(el) {
    if (el._plain) return el._plain;
    var words = [];
    var walk = function (node) {
      Array.prototype.slice.call(node.childNodes).forEach(function (child) {
        if (child.nodeType === 3) {
          var parts = child.textContent.split(/([ \n\t]+)/);
          var frag = document.createDocumentFragment();
          parts.forEach(function (part) {
            if (!part) return;
            if (/^[ \n\t]+$/.test(part)) { frag.appendChild(document.createTextNode(' ')); return; }
            var s = document.createElement('span');
            s.className = 'word';
            s.textContent = part;
            frag.appendChild(s);
            words.push(s);
          });
          node.replaceChild(frag, child);
        } else if (child.nodeType === 1) {
          walk(child);
        }
      });
    };
    walk(el);
    el._plain = words;
    return words;
  }

  // Split once up front so DOM never changes inside a matchMedia context.
  $$('[data-split]').forEach(splitWords);
  var scrubText = $('[data-scrub-text]');
  if (scrubText) splitPlain(scrubText);

  var nav = $('.local-nav');
  var backdrop = $('.backdrop');
  var themeMeta = $('meta[name="theme-color"]');
  var currentTheme = 'light';

  function setTheme(theme, instant) {
    if (!THEME_COLORS[theme]) return;
    if (theme === currentTheme && !instant) return;
    currentTheme = theme;
    gsap.to(backdrop, {
      backgroundColor: THEME_COLORS[theme],
      duration: instant ? 0 : 0.8,
      ease: 'power2.out',
      overwrite: true
    });
    nav.classList.toggle('is-dark', theme === 'dark');
    if (themeMeta) themeMeta.setAttribute('content', theme === 'dark' ? '#000000' : THEME_COLORS[theme]);
  }

  // Adds the chat answer sequence to a timeline, starting at t.
  // Used both by the scrubbed (pinned) and the time-played (fallback) drive modes.
  function addChatSequence(tl, t) {
    var chat = $('#story-chat');
    var buyer = $('.turn-buyer', chat);
    var meta = $('.assistant-meta', chat);
    var searching = $('.status-searching', chat);
    var done = $('.status-done', chat);
    var intro = $('.answer-intro', chat);
    var list = $('.rec-list', chat);
    var recs = $$('.rec', chat);
    var cites = $('.citations', chat);
    var source = $('.chip-source', chat);
    var omitted = $('.chip-omitted', chat);
    var typeProxy = { p: 0 };

    gsap.set([list, cites], { opacity: 1 });
    renderTyper(buyerTyper, 0);

    tl.fromTo(buyer, { opacity: 0, y: 14, scale: 0.96, transformOrigin: '100% 100%' },
      { opacity: 1, y: 0, scale: 1, duration: 0.35, ease: 'power3.out' }, t)
      .fromTo(typeProxy, { p: 0 }, {
        p: 1, duration: 1.1, ease: 'none',
        onUpdate: function () { renderTyper(buyerTyper, typeProxy.p); }
      }, t + 0.1)
      .fromTo(meta, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.35, ease: 'power3.out' }, t + 1.35)
      .fromTo(searching, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.2 }, t + 1.35)
      .fromTo(done, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.2 }, t + 2.2)
      .to(searching, { autoAlpha: 0, duration: 0.2 }, t + 2.2)
      .fromTo(intro, { opacity: 0, y: 12, filter: 'blur(6px)' },
        { opacity: 1, y: 0, filter: 'blur(0px)', duration: 0.5, ease: 'power3.out' }, t + 2.3)
      .fromTo(recs, { opacity: 0, y: 18, scale: 0.98 },
        { opacity: 1, y: 0, scale: 1, duration: 0.5, ease: 'power3.out', stagger: 0.35 }, t + 2.75)
      .fromTo(source, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.35, ease: 'power3.out' }, t + 3.6)
      .fromTo(omitted, { opacity: 0, scale: 0.6, boxShadow: '0 0 0 0 rgba(215,0,21,0.45)' },
        { opacity: 1, scale: 1, duration: 0.45, ease: 'back.out(2.6)' }, t + 4.3)
      .to(omitted, { boxShadow: '0 0 0 12px rgba(215,0,21,0)', duration: 0.6, ease: 'power2.out' }, t + 4.55);

    return t + 5.2;
  }

  // ==========================================================
  // Motion context
  // ==========================================================
  var mm = gsap.matchMedia();

  mm.add({
    pin: PIN_QUERY,
    motionOK: '(prefers-reduced-motion: no-preference)'
  }, function (ctx) {
    var c = ctx.conditions;

    if (!c.motionOK) {
      settleStatic();
      return;
    }

    root.classList.add('motion');
    root.classList.toggle('pin', !!c.pin);
    if (!state.fixManual) setFix('before', { silent: true });
    $$('[data-count-to]').forEach(function (el) { el.textContent = el.getAttribute('data-count-from'); });
    var wordingScene = $('.scene-wording');
    wordingScene.classList.remove('is-in');

    // ---------- Inertial scroll ----------
    var lenis = null;
    var tick = null;
    if (window.Lenis) {
      lenis = new window.Lenis({ lerp: 0.11, wheelMultiplier: 1, smoothWheel: true });
      lenis.on('scroll', ScrollTrigger.update);
      tick = function (time) { lenis.raf(time * 1000); };
      gsap.ticker.add(tick);
      gsap.ticker.lagSmoothing(0);
    }

    // ---------- Hero load moment ----------
    var heroCopy = $('.hero-copy');
    var heroTitle = $('.hero-title');
    var heroSub = $('.hero-subline');
    var echoes = $$('.echo');
    var cue = $('.scroll-cue');

    var intro = gsap.timeline({ defaults: { ease: 'power4.out' } });
    intro.fromTo(heroTitle, { opacity: 0, y: 60, scale: 0.94, filter: 'blur(14px)' },
      { opacity: 1, y: 0, scale: 1, filter: 'blur(0px)', duration: 1.6 }, 0.1)
      .fromTo(heroSub, { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: 1.2 }, 0.55)
      .fromTo(echoes, { opacity: 0, scale: 0.86, y: 12 },
        { opacity: function (i, el) { return el.classList.contains('echo-far') ? 0.55 : 1; }, scale: 1, y: 0, duration: 1, stagger: { each: 0.16, from: 'random' } }, 0.9)
      .fromTo(cue, { opacity: 0 }, { opacity: 1, duration: 0.8 }, 1.6)
      .fromTo($('span', cue), { y: 0, opacity: 1 }, { y: 10, opacity: 0, duration: 1.4, ease: 'power2.in', repeat: -1, repeatDelay: 0.3 }, 2);

    // ---------- Nav tuck ----------
    nav.classList.add('is-tucked');
    ScrollTrigger.create({
      start: function () { return window.innerHeight * 0.5; },
      end: 'max',
      onToggle: function (self) { nav.classList.toggle('is-tucked', !self.isActive); }
    });

    // ---------- Scene 1: conversation ----------
    var convo = $('#conversation');
    var captions = $$('.caption', convo);
    var chat = $('#story-chat');

    if (c.pin) {
      var tl1 = gsap.timeline({ defaults: { ease: 'none' } });

      tl1.to(heroCopy, { scale: 0.82, yPercent: -18, opacity: 0, filter: 'blur(10px)', duration: 1.2, ease: 'power2.in' }, 0)
        .to($('.hero-echoes'), { scale: 1.7, opacity: 0, duration: 1.3, ease: 'power1.in' }, 0)
        .to($('.hero-layer'), { autoAlpha: 0, duration: 0.25 }, 1.15)
        .fromTo(chat,
          { opacity: 0, y: function () { return window.innerHeight * 0.5; }, scale: 0.9, rotationX: 16, transformPerspective: 1400, transformOrigin: '50% 0%' },
          { opacity: 1, y: 0, scale: 1, rotationX: 0, duration: 1.4, ease: 'power3.out' }, 0.75);

      var showCaption = function (i, t) {
        if (i > 0) {
          tl1.to(captions[i - 1], { opacity: 0, y: -22, filter: 'blur(6px)', duration: 0.4, ease: 'power2.in' }, t);
        }
        tl1.fromTo(captions[i], { opacity: 0, y: 26, filter: 'blur(6px)' },
          { opacity: 1, y: 0, filter: 'blur(0px)', duration: 0.5, ease: 'power3.out' }, t + (i > 0 ? 0.3 : 0));
      };

      showCaption(0, 1.25);
      var end = addChatSequence(tl1, 1.9);
      showCaption(1, 3.3);
      showCaption(2, 5.9);
      showCaption(3, end + 0.4);
      tl1.to(chat, { scale: 0.97, opacity: 0.7, duration: 0.6 }, end + 0.6)
        .to({}, { duration: 0.8 });

      ScrollTrigger.create({
        trigger: $('.conversation-pin'),
        start: 'top top',
        end: function () { return '+=' + Math.round(window.innerHeight * 4.6); },
        pin: true,
        scrub: 0.9,
        anticipatePin: 1,
        invalidateOnRefresh: true,
        animation: tl1
      });
    } else {
      var tl1b = gsap.timeline({ paused: true });
      addChatSequence(tl1b, 0);
      tl1b.timeScale(1.8);
      ScrollTrigger.create({
        trigger: chat,
        start: 'top 88%',
        once: true,
        onEnter: function () { tl1b.play(); }
      });
    }

    // ---------- Headings: masked word rise ----------
    $$('[data-split]').forEach(function (el) {
      gsap.fromTo(el._split, { yPercent: 110, opacity: 0 }, {
        yPercent: 0,
        opacity: 1,
        duration: 1.1,
        ease: 'power4.out',
        stagger: 0.06,
        scrollTrigger: { trigger: el, start: 'top 85%', once: true }
      });
    });

    // ---------- Scene 2: receipt ----------
    var paper = $('.paper');
    var printer = $('.printer');
    var rows = {
      asked: $('.paper-asked'),
      search: $('[data-line="search"]'),
      skipped: $('[data-line="skipped"]'),
      cited: $('[data-line="cited"]'),
      foot: $('.paper-foot')
    };
    var stamp = $('.stamp');
    var marker = $('.marker');
    var railFill = $('.rstep-rail span');
    var steps = $$('.rstep');
    var queryProxy = { p: 0 };
    renderTyper(queryTyper, 0);

    var setStep = function (idx) {
      steps.forEach(function (s, i) { s.classList.toggle('is-active', i === idx); });
    };

    var tl2 = gsap.timeline({ defaults: { ease: 'none' } });
    tl2.fromTo(paper, { clipPath: 'inset(0% 0% 100% 0%)', y: -30 },
      { clipPath: 'inset(0% 0% 78% 0%)', y: -22, duration: 0.8, ease: 'power1.out' }, 0)
      .fromTo(rows.asked, { opacity: 0 }, { opacity: 1, duration: 0.3 }, 0.4)
      .to(paper, { clipPath: 'inset(0% 0% 58% 0%)', y: -16, duration: 0.8 }, 1.0)
      .fromTo(rows.search, { opacity: 0 }, { opacity: 1, duration: 0.3 }, 1.1)
      .fromTo(queryProxy, { p: 0 }, { p: 1, duration: 0.9, onUpdate: function () { renderTyper(queryTyper, queryProxy.p); } }, 1.3)
      .addLabel('step1', 2.5)
      .to(paper, { clipPath: 'inset(0% 0% 33% 0%)', y: -8, duration: 0.8 }, 2.5)
      .fromTo(rows.skipped, { opacity: 0 }, { opacity: 1, duration: 0.3 }, 2.6)
      .fromTo(stamp, { opacity: 0, scale: 2.4 }, { opacity: 0.9, scale: 1, duration: 0.3, ease: 'power4.in' }, 3.2)
      .to(printer, { keyframes: { x: [0, -5, 4, -2, 0] }, duration: 0.3, ease: 'none' }, 3.5)
      .addLabel('step2', 4.1)
      .to(paper, { clipPath: 'inset(0% 0% 0% 0%)', y: 0, duration: 1.1 }, 4.1)
      .fromTo(rows.cited, { opacity: 0 }, { opacity: 1, duration: 0.3 }, 4.2)
      .fromTo(marker, { backgroundSize: '0% 100%' }, { backgroundSize: '100% 100%', duration: 0.6, ease: 'power2.inOut' }, 4.6)
      .fromTo(rows.foot, { opacity: 0 }, { opacity: 1, duration: 0.4 }, 5.0)
      .fromTo(railFill, { scaleY: 0 }, { scaleY: 1, duration: 4.1 }, 0.9)
      .to({}, { duration: 0.9 });

    var stepAt = function (p) {
      var d = tl2.duration();
      if (p * d < tl2.labels.step1) return 0;
      if (p * d < tl2.labels.step2) return 1;
      return 2;
    };

    if (c.pin) {
      setStep(0);
      ScrollTrigger.create({
        trigger: $('.receipt-pin'),
        start: 'top top',
        end: function () { return '+=' + Math.round(window.innerHeight * 3.2); },
        pin: true,
        scrub: 0.8,
        anticipatePin: 1,
        invalidateOnRefresh: true,
        animation: tl2,
        onUpdate: function (self) { setStep(stepAt(self.progress)); }
      });
    } else {
      tl2.pause();
      tl2.timeScale(1.6);
      tl2.eventCallback('onUpdate', function () { setStep(stepAt(tl2.progress())); });
      ScrollTrigger.create({
        trigger: printer,
        start: 'top 75%',
        once: true,
        onEnter: function () { tl2.play(); }
      });
    }

    // ---------- Scene 3: wording ----------
    ScrollTrigger.create({
      trigger: wordingScene,
      start: 'top 60%',
      once: true,
      onEnter: function () {
        wordingScene.classList.add('is-in');
        if (state.wordingTouched) return;
        // One orchestrated beat: 4 → 1 → 0, the swing the copy promises.
        var seq = [0, 1, 2];
        seq.forEach(function (idx, n) {
          gsap.delayedCall(0.9 + n * 1.1, function () {
            if (!state.wordingTouched) selectWording(idx);
          });
        });
      }
    });

    // ---------- Scene 4: scrubbed statement ----------
    if (scrubText) {
      var words = scrubText._plain;
      var strike = $('.strike', scrubText);
      var strikeIdx = words.indexOf($('.word', strike));
      var tl4 = gsap.timeline({ defaults: { ease: 'none' } });
      tl4.fromTo(words, { opacity: 0.14 }, { opacity: 1, duration: 0.5, stagger: 0.12 }, 0);
      if (strike && strikeIdx > -1) {
        tl4.fromTo(strike, { '--strike': 0 }, { '--strike': 1, duration: 0.6, ease: 'power2.inOut' }, strikeIdx * 0.12 + 0.5);
      }
      ScrollTrigger.create({
        trigger: scrubText,
        start: 'top 80%',
        end: 'bottom 45%',
        scrub: 0.6,
        animation: tl4
      });
    }

    // ---------- Scene 5: fix ----------
    var pageMock = $('#page-mock');
    var tableBuilt = false;
    var chatSeen = false;
    var tryFlip = function () {
      if (tableBuilt && chatSeen && !state.fixManual) {
        gsap.delayedCall(0.5, function () { if (!state.fixManual) setFix('after'); });
      }
    };

    var tl5 = gsap.timeline({ paused: true, onComplete: function () { tableBuilt = true; tryFlip(); } });
    tl5.fromTo($$('.spec-table tr', pageMock), { opacity: 0, y: 14 },
      { opacity: 1, y: 0, duration: 0.55, ease: 'power3.out', stagger: 0.14 }, 0)
      .fromTo($('.spec-table', pageMock), { backgroundColor: 'rgba(0,113,227,0.12)' },
        { backgroundColor: 'rgba(0,113,227,0)', duration: 1.4, ease: 'power2.out' }, 0.5);

    ScrollTrigger.create({ trigger: pageMock, start: 'top 72%', once: true, onEnter: function () { tl5.play(); } });
    ScrollTrigger.create({ trigger: fixChat, start: 'top 65%', once: true, onEnter: function () { chatSeen = true; tryFlip(); } });

    gsap.fromTo([pageMock, fixChat], { opacity: 0, y: 60 }, {
      opacity: 1, y: 0, duration: 1.1, ease: 'power3.out', stagger: 0.12,
      scrollTrigger: { trigger: $('.fix-grid'), start: 'top 85%', once: true }
    });

    $$('[data-count-to]').forEach(function (el) {
      var from = parseFloat(el.getAttribute('data-count-from'));
      var to = parseFloat(el.getAttribute('data-count-to'));
      if (from === to) return;
      var obj = { v: from };
      gsap.to(obj, {
        v: to,
        duration: 1.6,
        ease: 'power2.out',
        onUpdate: function () { el.textContent = String(Math.round(obj.v)); },
        scrollTrigger: { trigger: el, start: 'top 85%', once: true }
      });
    });

    // ---------- Scene 6: film grows into place ----------
    gsap.fromTo(frame, { scale: 0.8, borderRadius: 44 }, {
      scale: 1,
      borderRadius: 24,
      ease: 'none',
      scrollTrigger: { trigger: frame, start: 'top bottom', end: 'center 55%', scrub: 0.6 }
    });

    // ---------- Scene 7: install doors ----------
    gsap.fromTo($$('.door'), { opacity: 0, y: 48 }, {
      opacity: 1, y: 0, duration: 1, ease: 'power3.out', stagger: 0.12,
      scrollTrigger: { trigger: $('.doors'), start: 'top 85%', once: true }
    });

    // ---------- Theme field (created last so pin spacing is already measured) ----------
    $$('.scene').forEach(function (scene) {
      ScrollTrigger.create({
        trigger: scene,
        start: 'top 70%',
        end: 'bottom 70%',
        onToggle: function (self) { if (self.isActive) setTheme(scene.getAttribute('data-theme')); }
      });
    });
    setTheme('light', true);

    // ---------- In-page links through Lenis ----------
    var onAnchor = function (e) {
      var a = e.target.closest('a[href^="#"]');
      if (!a || a.classList.contains('skip-link')) return;
      var id = a.getAttribute('href');
      var target = id === '#top' ? 0 : $(id);
      if (target === null) return;
      e.preventDefault();
      if (lenis) lenis.scrollTo(target, { offset: id === '#top' ? 0 : -8, duration: 1.4 });
      else if (target === 0) window.scrollTo({ top: 0, behavior: 'smooth' });
      else target.scrollIntoView({ behavior: 'smooth' });
    };
    document.addEventListener('click', onAnchor);

    ScrollTrigger.refresh();

    return function cleanup() {
      document.removeEventListener('click', onAnchor);
      if (lenis) {
        gsap.ticker.remove(tick);
        lenis.destroy();
      }
      renderTyper(buyerTyper, 1);
      renderTyper(queryTyper, 1);
      steps.forEach(function (s, i) { s.classList.toggle('is-active', i === 0); });
      nav.classList.remove('is-tucked');
    };
  });

  window.addEventListener('load', function () { ScrollTrigger.refresh(); });
})();
