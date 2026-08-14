# Product

## Register

product

## Users

Small groups of friends (1-8 people) who want a fast browser FPS match with zero install. They arrive over a shared room code or quick play, usually on desktop with mouse and keyboard, and expect to be in a match within a minute. Bots fill empty slots, so a single player can always get a full match.

## Product Purpose

RIFTLANE is an 8-player capture-the-flag arena shooter that runs entirely in the browser: an original IP inspired by Husky Raid. Two teams of four grapple and repulsor-jump between platforms, steal the enemy flag, and capture at their own base. Success is a match that starts fast, stays at 60fps, feels fair (server-authoritative, client-predicted), and reads clearly in the heat of a fight.

## Brand Personality

Competitive, legible, kinetic. The UI voice is a terminal-flavored military HUD: monospace labels, short uppercase callouts, team colors carrying meaning (Cobalt vs Ember). Menus stay quiet and functional; intensity is reserved for in-match feedback (kill banners, damage vignettes).

## Anti-references

- Free-to-play lobby bloat: battle passes, currency badges, notification dots.
- Neon "cyber" clutter: glitch effects, scanlines everywhere, unreadable sci-fi fonts.
- Generic SaaS styling in the menus: cards with icon + heading + blurb grids, gradient text.

## Design Principles

- Readability beats spectacle: nothing in the HUD may obscure threats, the flag, or the crosshair.
- Meaning through team color: cobalt and ember are reserved for team identity; state colors (ok/warn/danger) are reserved for status.
- Every effect earns its frame budget: 60fps under full 8-player load is a shipping requirement, not a target.
- Menus are functional, matches are loud: escalate visual intensity only inside a match.

## Accessibility & Inclusion

- WCAG AA contrast for all menu text; HUD text carries shadows/backing plates over the 3D scene.
- Keyboard focus visible on every interactive menu element.
- `prefers-reduced-motion` honored: no scale/spin animation in menus or HUD banners.
- Screen-reader announcements for connection status and server errors (status bar is a polite live region).
