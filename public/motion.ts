export function setupMotion() {
  const header = document.querySelector<HTMLElement>('.topbar');
  if (!header) return;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let previousY = Math.max(0, window.scrollY);
  let direction = 0;
  let distance = 0;
  let pending = false;
  function updateScroll() {
    pending = false;
    // Ограничиваем координату, чтобы упругая прокрутка не меняла направление хедера.
    const maximum = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    const y = Math.min(maximum, Math.max(0, window.scrollY));
    const delta = y - previousY;
    const nextDirection = Math.sign(delta);
    if (nextDirection !== direction) distance = 0;
    distance += Math.abs(delta);
    direction = nextDirection;
    previousY = y;
    document.documentElement.classList.toggle('scroll-warm', y > 120);
    if (y < 80 || reduced.matches || header!.contains(document.activeElement)) {
      header!.classList.remove('header-hidden');
    } else if (distance >= 8) {
      header!.classList.toggle('header-hidden', delta > 0);
    }
  }
  window.addEventListener(
    'scroll',
    () => {
      if (!pending) {
        pending = true;
        requestAnimationFrame(updateScroll);
      }
    },
    { passive: true },
  );
  header.addEventListener('focusin', () => header.classList.remove('header-hidden'));
  reduced.addEventListener('change', () => {
    updateScroll();
    if (reduced.matches)
      document
        .querySelectorAll('.reveal-pending')
        .forEach((node) => node.classList.remove('reveal-pending'));
  });
  updateScroll();
  if (reduced.matches || !('IntersectionObserver' in window)) return;
  // Секции остаются доступными без JS; наблюдение прекращается после первого появления.
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.remove('reveal-pending');
        observer.unobserve(entry.target);
      }
    },
    { threshold: 0 },
  );
  document
    .querySelectorAll<HTMLElement>('.hero, .workspace, .library, .site-footer')
    .forEach((node) => {
      node.classList.add('reveal-section');
      node.classList.add('reveal-pending');
      observer.observe(node);
    });
}
