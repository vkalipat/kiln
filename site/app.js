const menu = document.querySelector('.menu-button');
const sidebar = document.querySelector('#sidebar');
const main = document.querySelector('main');
function closeMenu() {
  menu.setAttribute('aria-expanded', 'false');
  sidebar.classList.remove('is-open');
  main.inert = false;
  document.body.classList.remove('menu-open');
}
menu.addEventListener('click', () => {
  const open = menu.getAttribute('aria-expanded') !== 'true';
  menu.setAttribute('aria-expanded', String(open));
  sidebar.classList.toggle('is-open', open);
  main.inert = open;
  document.body.classList.toggle('menu-open', open);
});
sidebar.querySelectorAll('a').forEach(link => link.addEventListener('click', closeMenu));
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && menu.getAttribute('aria-expanded') === 'true') {
    closeMenu();
    menu.focus();
  }
});
window.matchMedia('(min-width: 761px)').addEventListener('change', event => {
  if (event.matches) closeMenu();
});

document.querySelectorAll('[data-copy]').forEach(button => {
  const initial = button.innerHTML;
  let timeout;
  button.addEventListener('click', async () => {
    const code = button.closest('.code-block').querySelector('code');
    clearTimeout(timeout);
    try {
      await navigator.clipboard.writeText(code.textContent);
      button.textContent = 'Copied ✓';
      document.querySelector('#copy-status').textContent = 'Command copied to clipboard.';
    } catch {
      const range = document.createRange();
      range.selectNodeContents(code);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      button.textContent = 'Text selected';
      document.querySelector('#copy-status').textContent = 'Clipboard unavailable. Command selected; use your copy shortcut.';
    }
    timeout = setTimeout(() => { button.innerHTML = initial; }, 2000);
  });
});

const links = document.querySelectorAll('.sidebar a[href^="#"]');
const sections = [...document.querySelectorAll('main section[id]')];
let scheduled = false;
function updateLocation() {
  const position = window.scrollY + 160;
  let active = sections[0].id;
  for (const section of sections) {
    if (section.offsetTop <= position) active = section.id;
  }
  if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 8) active = sections.at(-1).id;
  links.forEach(link => {
    if (link.getAttribute('href') === `#${active}`) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  });
  scheduled = false;
}
window.addEventListener('scroll', () => {
  if (!scheduled) { scheduled = true; requestAnimationFrame(updateLocation); }
}, { passive: true });
window.addEventListener('resize', updateLocation);
updateLocation();
