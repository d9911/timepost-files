// Нативный select остаётся источником значения и резервным интерфейсом без JS.
export function enhancePreferenceSelect(select: HTMLSelectElement) {
  const root = document.createElement('div');
  root.className = 'preference-dropdown';
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.id = `${select.id}-trigger`;
  trigger.className = 'preference-trigger';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  const label = document.createElement('span');
  const arrow = document.createElement('span');
  arrow.className = 'preference-arrow';
  arrow.setAttribute('aria-hidden', 'true');
  trigger.append(label, arrow);
  const panel = document.createElement('div');
  panel.id = `${select.id}-options`;
  panel.className = 'preference-options';
  panel.setAttribute('role', 'listbox');
  trigger.setAttribute('aria-controls', panel.id);
  let opened = false;
  const options = Array.from(select.options).map((option) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'preference-option';
    button.tabIndex = -1;
    button.setAttribute('role', 'option');
    button.addEventListener('click', () => {
      select.value = option.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      sync();
      close(true);
    });
    panel.append(button);
    return { option, button };
  });
  function sync() {
    const name = select.getAttribute('aria-label') ?? select.id;
    label.textContent = select.selectedOptions[0]?.textContent ?? '';
    trigger.setAttribute('aria-label', `${name}: ${label.textContent}`);
    panel.setAttribute('aria-label', name);
    for (const { option, button } of options) {
      button.textContent = option.textContent;
      button.setAttribute('aria-selected', String(option.selected));
    }
  }
  function close(restoreFocus = false) {
    opened = false;
    root.dataset.open = 'false';
    trigger.setAttribute('aria-expanded', 'false');
    panel.setAttribute('aria-hidden', 'true');
    panel.inert = true;
    if (restoreFocus) trigger.focus();
  }
  function open(index = select.selectedIndex) {
    opened = true;
    root.dataset.open = 'true';
    trigger.setAttribute('aria-expanded', 'true');
    panel.removeAttribute('aria-hidden');
    panel.inert = false;
    options[Math.max(0, index)]?.button.focus();
  }
  trigger.addEventListener('click', () => (opened ? close(true) : open()));
  root.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && opened) {
      event.preventDefault();
      close(true);
    } else if (event.key === 'Tab') close();
    else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const current = options.findIndex(({ button }) => button === document.activeElement);
      const index =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? options.length - 1
            : current < 0
              ? select.selectedIndex
              : (current + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
      open(index);
    }
  });
  document.addEventListener('pointerdown', (event) => {
    if (event.target instanceof Node && !root.contains(event.target)) close();
  });
  root.addEventListener('focusout', (event) => {
    if (event.relatedTarget instanceof Node && !root.contains(event.relatedTarget)) close();
  });
  root.append(trigger, panel);
  select.after(root);
  select.hidden = true;
  close();
  sync();
  return sync;
}
