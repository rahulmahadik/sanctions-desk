/*
 * Sanctions Desk home page: the one script the site's own pages load (served from the site; nothing from outside).
 *
 * - The demo video plays in place when its thumbnail is pressed: only then is the player loaded, from
 *   youtube-nocookie.com. Without JavaScript the thumbnail stays a plain link to the video on YouTube.
 * - The back-to-top button appears once the page has been scrolled.
 * - Sections fade in as they scroll into view, unless the reader has asked for reduced motion.
 */
(() => {
  document.documentElement.classList.add("js");

  const EMBED = "https://www.youtube-nocookie.com/embed/";
  for (const link of document.querySelectorAll("a[data-video]")) {
    const id = link.getAttribute("data-video") ?? "";
    if (!/^[\w-]{11}$/.test(id)) continue;
    link.setAttribute("aria-label", "Play the demo video (3:51) here; the player loads from youtube-nocookie.com");
    link.addEventListener("click", (event) => {
      // A middle click or a modifier key keeps the link's own behaviour (the video on YouTube, in a new tab).
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      const frame = document.createElement("iframe");
      frame.src = `${EMBED}${id}?autoplay=1`;
      frame.title = "Sanctions Desk demo video";
      frame.loading = "lazy";
      frame.allow = "autoplay; encrypted-media; picture-in-picture";
      frame.allowFullscreen = true;
      frame.referrerPolicy = "strict-origin-when-cross-origin";
      link.replaceWith(frame);
      frame.focus();
    });
  }

  const toTop = document.querySelector(".to-top");
  if (toTop) {
    const update = () => toTop.classList.toggle("is-shown", window.scrollY > 600);
    window.addEventListener("scroll", update, { passive: true });
    update();
  }

  // Only sections that start below the first screen fade in, so nothing on screen flickers while the page loads.
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || !("IntersectionObserver" in window)) return;
  const seen = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("is-visible");
        seen.unobserve(entry.target);
      }
    },
    { rootMargin: "0px 0px -8% 0px" },
  );
  for (const el of document.querySelectorAll("[data-reveal]")) {
    if (el.getBoundingClientRect().top < window.innerHeight) continue;
    el.classList.add("reveal");
    seen.observe(el);
  }
})();
