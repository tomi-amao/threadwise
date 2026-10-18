/**
 * Whether the assistant panel is open, and how wide. Stored in a cookie, like the theme
 * (`lib/theme.ts`), so the server renders the page already making room for an open panel;
 * from localStorage the page would jump sideways after it loads.
 */

export const ASSISTANT_COOKIE = 'tw-assistant';
export const PANEL_MIN_WIDTH = 340;
export const PANEL_MAX_WIDTH = 720;
export const PANEL_DEFAULT_WIDTH = 420;

/**
 * The panel docks beside the page (the page makes room) only where the page keeps the width
 * it is designed for: the full sidebar (256px) + 1024px + the default panel. Narrower, it
 * overlays the page. Pages lay out by viewport breakpoints, so pushing them narrower than
 * that squeezes desktop layouts into a tablet-sized box (KPI figures cut to "£…").
 * Mirrored as the `min-[1700px]:` classes in AppLayout and AssistantPanel.
 */
export const DOCK_MIN_VIEWPORT = 1700;

export interface PanelState {
  open: boolean;
  width: number;
}

export const DEFAULT_PANEL: PanelState = { open: false, width: PANEL_DEFAULT_WIDTH };

export function clampWidth(width: number): number {
  if (!Number.isFinite(width)) return PANEL_DEFAULT_WIDTH;
  return Math.round(Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, width)));
}

/** Reads `open:width` (e.g. `1:420`) from a Cookie header (server) or document.cookie. */
export function parsePanel(cookieHeader: string | null | undefined): PanelState {
  for (const part of (cookieHeader ?? '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name !== ASSISTANT_COOKIE) continue;
    const [open, width] = decodeURIComponent(rest.join('=')).split(':');
    return { open: open === '1', width: clampWidth(Number(width)) };
  }
  return DEFAULT_PANEL;
}

/** Client only. One year, whole site. */
export function writePanelCookie(state: PanelState) {
  const value = `${state.open ? 1 : 0}:${clampWidth(state.width)}`;
  document.cookie = `${ASSISTANT_COOKIE}=${value}; Path=/; Max-Age=31536000; SameSite=Lax`;
}
