export const THEME_OPTIONS = [
  { id: "light", label: "settings.themeLight" },
  { id: "dark", label: "settings.themeDark" },
  { id: "auto", label: "settings.themeSystem" },
] as const;

export type ThemePreference = (typeof THEME_OPTIONS)[number]["id"];
export type ResolvedTheme = Exclude<ThemePreference, "auto">;

export function isThemePreference(value: unknown): value is ThemePreference {
  return THEME_OPTIONS.some((option) => option.id === value);
}

export function isDarkTheme(theme: ResolvedTheme): boolean {
  return theme === "dark";
}

// Apply the saved palette and window background before first paint, including
// when storage is blocked.
export const THEME_INIT_SCRIPT = `(function(){var t="auto";try{var s=localStorage.getItem("pi-theme");if(${JSON.stringify(THEME_OPTIONS.map((option) => option.id))}.includes(s))t=s}catch(e){}if(t==="auto")t=window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";var r=document.documentElement;r.dataset.theme=t;r.classList.toggle("dark",t==="dark");try{var bi=localStorage.getItem("pi-background-image");var bo=localStorage.getItem("pi-background-image-options");var o={enabled:true,dim:0.32,blur:0,fit:"cover"};if(bo){try{var p=JSON.parse(bo);if(typeof p.enabled==="boolean")o.enabled=p.enabled;if(typeof p.dim==="number"&&isFinite(p.dim))o.dim=Math.min(0.85,Math.max(0,p.dim));if(typeof p.blur==="number"&&isFinite(p.blur))o.blur=Math.min(24,Math.max(0,p.blur));if(p.fit==="contain")o.fit="contain"}catch(e){}}var has=!!bi&&bi.indexOf("data:image/")===0;r.classList.toggle("has-app-background",has&&o.enabled);if(has)r.style.setProperty("--app-bg-image",'url("'+bi+'")');r.style.setProperty("--app-bg-dim",String(Math.round(o.dim*1000)/10)+"%");r.style.setProperty("--app-bg-blur",o.blur+"px");r.style.setProperty("--app-bg-size",o.fit)}catch(e){}})();`;
