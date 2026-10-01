/* Aplica o tema antes da página aparecer (evita "piscar" claro→escuro).
   Sem escolha salva, segue o tema do sistema operacional. */
(function () {
  try {
    var saved = localStorage.getItem('crono_theme');
    var dark = saved ? saved === 'dark'
      : !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    if (dark) document.documentElement.classList.add('dark-theme');
  } catch (e) { /* sem localStorage: tema claro */ }
})();
