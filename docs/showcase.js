(function () {
  'use strict';

  // Simple state management for demo interactivity
  var state = {
    model: 'chatgpt',
    forensicOpen: true,
    fixState: 'after',
    phrasing: 2
  };

  function updateChat() {
    var assistantTurn = document.getElementById('live-assistant-turn');
    if (assistantTurn) {
      assistantTurn.querySelector('#chat-model-label').textContent = 
        state.model.charAt(0).toUpperCase() + state.model.slice(1);
    }
  }

  // Event Listeners
  document.querySelectorAll('[data-model]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      state.model = btn.getAttribute('data-model');
      document.querySelectorAll('[data-model]').forEach(function(b) {
        b.classList.toggle('is-active', b.getAttribute('data-model') === state.model);
      });
      updateChat();
    });
  });

  document.getElementById('forensic-toggle-btn').addEventListener('click', function() {
    state.forensicOpen = !state.forensicOpen;
    document.getElementById('forensic-drawer').style.display = state.forensicOpen ? 'block' : 'none';
    this.setAttribute('aria-expanded', state.forensicOpen);
  });

  document.querySelectorAll('.phrasing-option').forEach(function(opt, idx) {
    opt.addEventListener('click', function() {
      state.phrasing = idx;
      document.querySelectorAll('.phrasing-option').forEach(function(o, i) {
        o.classList.toggle('is-selected', i === idx);
        o.setAttribute('aria-checked', i === idx);
      });
    });
  });

  document.querySelectorAll('[data-fix]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      state.fixState = btn.getAttribute('data-fix');
      document.querySelectorAll('[data-fix]').forEach(function(b) {
        b.classList.toggle('is-active', b.getAttribute('data-fix') === state.fixState);
        b.setAttribute('aria-pressed', b.getAttribute('data-fix') === state.fixState);
      });
      // In a real app, update content here.
    });
  });

  document.querySelectorAll('[data-copy-target]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var targetId = btn.getAttribute('data-copy-target');
      var text = document.getElementById(targetId).textContent;
      navigator.clipboard.writeText(text);
      var originalLabel = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(function() { btn.textContent = originalLabel; }, 2000);
    });
  });

})();
