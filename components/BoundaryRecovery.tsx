"use client";

import { useEffect, useState } from "react";

import { APP_PREF_KEYS, getPref } from "@/lib/app-prefs";

/**
 * The recovery screen shared by `app/error.tsx` (errors inside the layout) and
 * `app/global-error.tsx` (errors in the layout itself, which must render its
 * own `<html>`). Both sit outside `I18nProvider`, so the copy is a small
 * inline table keyed by the persisted interface language rather than the
 * translation registry. Styles are inline with a scoped `<style>` block for
 * the same reason: global-error renders without the root layout's stylesheets.
 */

type BoundaryLocale = "en" | "zh-CN" | "zh-TW";

interface BoundaryStrings {
  title: string;
  body: string;
  retry: string;
  reload: string;
  details: string;
}

const STRINGS: Record<BoundaryLocale, BoundaryStrings> = {
  en: {
    title: "Something went wrong",
    body: "The interface hit an unexpected error. It has been logged. Try again, or reload the page.",
    retry: "Try again",
    reload: "Reload",
    details: "Error details",
  },
  "zh-CN": {
    title: "界面出错了",
    body: "界面遇到一个未处理的错误，已记录。可以重试，或重新加载页面。",
    retry: "重试",
    reload: "重新加载",
    details: "错误详情",
  },
  "zh-TW": {
    title: "介面發生錯誤",
    body: "介面遇到未處理的錯誤，已記錄。可以重試，或重新載入頁面。",
    retry: "重試",
    reload: "重新載入",
    details: "錯誤詳情",
  },
};

function currentStrings(): BoundaryStrings {
  const stored = getPref(APP_PREF_KEYS.locale);
  if (stored === "zh-CN" || stored === "zh-TW" || stored === "en") return STRINGS[stored];
  return STRINGS.en;
}

const CSS = `
.pi-recovery{min-height:100vh;box-sizing:border-box;display:flex;align-items:center;justify-content:center;padding:24px;background:#fff;color:#171717;font-family:system-ui,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.pi-recovery__card{width:100%;max-width:560px}
.pi-recovery__title{font-size:24px;font-weight:500;letter-spacing:-0.02em;margin:0 0 12px}
.pi-recovery__body{font-size:14px;line-height:1.5;margin:0 0 20px;color:#444}
.pi-recovery__actions{display:flex;gap:8px;flex-wrap:wrap}
.pi-recovery__button{height:32px;padding:0 12px;font-size:14px;font-weight:500;border-radius:6px;cursor:pointer;color:#fff;background:#171717;border:none}
.pi-recovery__button--secondary{color:#171717;background:transparent;border:1px solid rgba(0,0,0,0.14)}
.pi-recovery__details{margin-top:20px;font-size:12px;color:#666}
.pi-recovery__details pre{margin:8px 0 0;max-height:220px;overflow:auto;white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
@media (prefers-color-scheme:dark){.pi-recovery{background:#0a0a0a;color:#ededed}.pi-recovery__body{color:#b8b8b8}.pi-recovery__button{color:#0a0a0a;background:#ededed}.pi-recovery__button--secondary{color:#ededed;background:transparent;border-color:rgba(255,255,255,0.18)}.pi-recovery__details{color:#a0a0a0}}
html.dark .pi-recovery{background:#0a0a0a;color:#ededed}
html.dark .pi-recovery__body{color:#b8b8b8}
html.dark .pi-recovery__button{color:#0a0a0a;background:#ededed}
html.dark .pi-recovery__button--secondary{color:#ededed;background:transparent;border-color:rgba(255,255,255,0.18)}
html.dark .pi-recovery__details{color:#a0a0a0}
`;

export interface BoundaryRecoveryProps {
  error: Error & { digest?: string };
  reset?: () => void;
}

export function BoundaryRecovery({ error, reset }: BoundaryRecoveryProps) {
  // The stored language is read after mount, so the server-rendered markup and
  // the first client render agree (localStorage is unavailable while SSR-ing).
  const [strings, setStrings] = useState<BoundaryStrings>(STRINGS.en);
  useEffect(() => {
    setStrings(currentStrings());
  }, []);

  const detail = error?.message || String(error);
  const digest = error?.digest;

  return (
    <div className="pi-recovery">
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <div className="pi-recovery__card">
        <h1 className="pi-recovery__title">{strings.title}</h1>
        <p className="pi-recovery__body">{strings.body}</p>
        <div className="pi-recovery__actions">
          {reset ? (
            <button type="button" className="pi-recovery__button" onClick={() => reset()}>
              {strings.retry}
            </button>
          ) : null}
          <button
            type="button"
            className="pi-recovery__button pi-recovery__button--secondary"
            onClick={() => window.location.reload()}
          >
            {strings.reload}
          </button>
        </div>
        <details className="pi-recovery__details">
          <summary>{strings.details}</summary>
          <pre>{digest ? `${detail}\n\ndigest: ${digest}` : detail}</pre>
        </details>
      </div>
    </div>
  );
}
