// theme.js – apply theme, store preference, expose setTheme()
(function() {
  // The only values master.css defines styles for — anything else falls
  // back to the default so a typo can't leave the page with no theme vars.
  const KNOWN_THEMES = [
    'green', 'red', 'blue', 'amber', 'synthwave',
    'mono', 'miku', 'dark-academia', 'cherryblossom',
    'cyberdeck',
  ];

  // 1. Read stored preference, default to 'green'
  let stored = localStorage.getItem('theme');
  if (!stored || !KNOWN_THEMES.includes(stored)) stored = 'green';

  // 2. Apply immediately (before body renders)
  document.documentElement.setAttribute('data-theme', stored);

  // 3. Expose a global function for the switcher
  window.setTheme = function(themeName) {
    if (!themeName || !KNOWN_THEMES.includes(themeName)) return;
    document.documentElement.setAttribute('data-theme', themeName);
    localStorage.setItem('theme', themeName);
    // Also update the dropdown/buttons so they reflect the change
    updateSwitcherUI(themeName);
  };

  // 4. Helper to sync the UI with the current theme (called after DOM ready)
  function updateSwitcherUI(theme) {
    const select = document.getElementById('themeSelect');
    if (select) select.value = theme;
    const btns = document.querySelectorAll('.theme-btn');
    btns.forEach(btn => btn.classList.toggle('active', btn.dataset.theme === theme));
  }

  // 5. When DOM is ready, sync UI controls
  document.addEventListener('DOMContentLoaded', function() {
    const current = document.documentElement.getAttribute('data-theme') || 'green';
    updateSwitcherUI(current);
  });
})();
