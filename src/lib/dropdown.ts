let portal: HTMLElement | null = null;
let activeTrigger: HTMLElement | null = null;

function close(): void {
  if (activeTrigger) activeTrigger.setAttribute("aria-expanded", "false");
  portal?.remove();
  portal = null;
  activeTrigger = null;
}

export function closeDropdown(): void {
  close();
}

function position(trigger: HTMLElement, menu: HTMLElement): void {
  const rect = trigger.getBoundingClientRect();
  const pad = 8;
  const gap = 6;
  const preferred = Number(trigger.dataset.ddMenu || 0);
  const width = preferred > 0 ? preferred : Math.max(rect.width, 150);
  menu.style.width = `${Math.min(width, 300)}px`;
  const height = menu.offsetHeight || 0;
  let left = rect.left;
  if (left + width > window.innerWidth - pad) left = window.innerWidth - width - pad;
  left = Math.max(pad, left);
  let top = rect.bottom + gap;
  if (top + height > window.innerHeight - pad) top = rect.top - height - gap;
  top = Math.max(pad, Math.min(top, window.innerHeight - height - pad));
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
}

function choose(trigger: HTMLElement, option: HTMLElement): void {
  const value = option.dataset.value ?? "";
  trigger.dataset.value = value;
  const label = trigger.querySelector<HTMLElement>(".dd-label");
  if (label) label.innerHTML = option.innerHTML;
  trigger.dispatchEvent(
    new CustomEvent("dd-change", {
      bubbles: true,
      detail: { value },
    }),
  );
  close();
}

function open(trigger: HTMLElement): void {
  close();
  const source = trigger.closest<HTMLElement>(".dd")?.querySelector<HTMLElement>(".dd-options");
  if (!source) return;
  const current = trigger.dataset.value ?? "";
  const menu = document.createElement("div");
  menu.className = "dd-menu";
  menu.setAttribute("role", "listbox");
  source.querySelectorAll<HTMLElement>("[data-value]").forEach((option) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "dd-option";
    item.dataset.value = option.dataset.value ?? "";
    item.innerHTML = option.innerHTML;
    if (item.dataset.value === current) item.classList.add("selected");
    item.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      choose(trigger, item);
    });
    menu.appendChild(item);
  });
  portal = document.createElement("div");
  portal.className = "dd-portal";
  portal.appendChild(menu);
  document.body.appendChild(portal);
  activeTrigger = trigger;
  trigger.setAttribute("aria-expanded", "true");
  position(trigger, menu);
}

export function initDropdowns(): void {
  document.addEventListener("click", (event) => {
    const target = event.target as Element;
    const trigger = target.closest<HTMLElement>("[data-dd-trigger]");
    if (trigger) {
      event.preventDefault();
      if (activeTrigger === trigger) close();
      else open(trigger);
      return;
    }
    if (portal && portal.contains(target)) return;
    close();
  });
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Escape" || !portal) return;
      event.stopPropagation();
      close();
    },
    true,
  );
  window.addEventListener("resize", close);
  window.addEventListener("blur", close);
  window.addEventListener(
    "scroll",
    (event) => {
      if (portal && portal.contains(event.target as Node)) return;
      close();
    },
    true,
  );
}
