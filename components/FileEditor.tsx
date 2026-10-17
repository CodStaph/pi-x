"use client";

import { useEffect, useRef } from "react";
import { Compartment, EditorState, Prec, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import {
  HighlightStyle,
  StreamLanguage,
  defaultHighlightStyle,
  syntaxHighlighting,
} from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { javascript } from "@codemirror/lang-javascript";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { cpp } from "@codemirror/lang-cpp";
import { java } from "@codemirror/lang-java";
import { php } from "@codemirror/lang-php";
import { sql } from "@codemirror/lang-sql";
import { xml } from "@codemirror/lang-xml";
import { yaml } from "@codemirror/lang-yaml";
import { go } from "@codemirror/lang-go";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { powerShell } from "@codemirror/legacy-modes/mode/powershell";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { csharp, kotlin } from "@codemirror/legacy-modes/mode/clike";
import { swift } from "@codemirror/legacy-modes/mode/swift";

interface Props {
  value: string;
  /** Language name from the files API's `getLanguage` (falls back to plain text). */
  language: string;
  isDark: boolean;
  wrapLines: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
}

// Mirrors the read-only viewer's Prism palette so editing and previewing look
// like the same document. Registered languages that have no CodeMirror package
// fall back to plain text rather than failing to open.
function languageExtension(language: string): Extension {
  switch (language) {
    case "typescript": return javascript({ typescript: true, jsx: true });
    case "javascript": return javascript({ jsx: true });
    case "html": return html();
    case "css": return css();
    case "json": return json();
    case "markdown": return markdown();
    case "python": return python();
    case "rust": return rust();
    case "c":
    case "cpp": return cpp();
    case "java": return java();
    case "php": return php();
    case "sql": return sql();
    case "xml": return xml();
    case "yaml": return yaml();
    case "go": return go();
    case "bash": return StreamLanguage.define(shell);
    case "ruby": return StreamLanguage.define(ruby);
    case "toml": return StreamLanguage.define(toml);
    case "dockerfile": return StreamLanguage.define(dockerFile);
    case "csharp": return StreamLanguage.define(csharp);
    case "kotlin": return StreamLanguage.define(kotlin);
    case "swift": return StreamLanguage.define(swift);
    case "powershell": return StreamLanguage.define(powerShell);
    case "ini": return StreamLanguage.define(properties);
    default: return [];
  }
}

const darkHighlightStyle = HighlightStyle.define([
  { tag: [t.comment, t.lineComment, t.blockComment], color: "#6b7280", fontStyle: "italic" },
  { tag: [t.keyword, t.operatorKeyword, t.moduleKeyword, t.modifier], color: "#c084fc" },
  { tag: [t.name, t.deleted, t.character, t.macroName], color: "#d7dce5" },
  { tag: [t.propertyName, t.attributeName], color: "#93c5fd" },
  { tag: [t.function(t.variableName), t.labelName], color: "#60a5fa" },
  { tag: [t.color, t.constant(t.name), t.standard(t.name)], color: "#facc15" },
  { tag: [t.definition(t.name), t.separator], color: "#e5e7eb" },
  { tag: [t.typeName, t.className, t.number, t.changed, t.annotation, t.self, t.namespace], color: "#22d3ee" },
  { tag: [t.operator, t.url, t.escape, t.regexp, t.link, t.special(t.string)], color: "#f87171" },
  { tag: t.meta, color: "#6b7280" },
  { tag: t.strong, fontWeight: "bold" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.heading, fontWeight: "bold", color: "#60a5fa" },
  { tag: [t.atom, t.bool, t.special(t.variableName)], color: "#facc15" },
  { tag: [t.processingInstruction, t.string, t.inserted], color: "#4ade80" },
  { tag: t.invalid, color: "#f87171" },
]);

function themeExtension(isDark: boolean): Extension {
  const theme = EditorView.theme({
    "&": {
      height: "100%",
      backgroundColor: "var(--bg)",
      color: "var(--text)",
      fontSize: "13px",
    },
    ".cm-scroller": {
      fontFamily: "var(--font-mono)",
      lineHeight: "1.6",
      overflow: "auto",
    },
    ".cm-content": { caretColor: "var(--text)" },
    ".cm-gutters": {
      backgroundColor: "var(--bg-panel)",
      color: "var(--text-dim)",
      border: "none",
    },
    ".cm-activeLine": { backgroundColor: "transparent" },
    ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--text-muted)" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--text)" },
    "&.cm-focused": { outline: "none" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
      backgroundColor: "color-mix(in srgb, var(--accent) 28%, transparent)",
    },
    ".cm-panels": { backgroundColor: "var(--bg-panel)", color: "var(--text)" },
    ".cm-searchMatch": { backgroundColor: "color-mix(in srgb, var(--accent) 30%, transparent)" },
    ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "color-mix(in srgb, var(--accent) 50%, transparent)" },
    ".cm-tooltip": { backgroundColor: "var(--bg-panel)", border: "var(--hairline) solid var(--border)", color: "var(--text)" },
    ".cm-tooltip-autocomplete ul li[aria-selected]": { backgroundColor: "var(--bg-selected)", color: "var(--text)" },
  });
  return [theme, syntaxHighlighting(isDark ? darkHighlightStyle : defaultHighlightStyle)];
}

export function FileEditor({ value, language, isDark, wrapLines, onChange, onSave }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  // True while a prop-driven doc replacement runs, so the update listener does
  // not report it as a user edit (which would mark the draft dirty).
  const programmaticRef = useRef(false);
  const compartmentsRef = useRef({
    language: new Compartment(),
    theme: new Compartment(),
    wrap: new Compartment(),
  });

  onChangeRef.current = onChange;
  onSaveRef.current = onSave;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          compartmentsRef.current.language.of(languageExtension(language)),
          compartmentsRef.current.theme.of(themeExtension(isDark)),
          compartmentsRef.current.wrap.of(wrapLines ? EditorView.lineWrapping : []),
          Prec.high(keymap.of([{
            key: "Mod-s",
            preventDefault: true,
            run: () => {
              onSaveRef.current();
              return true;
            },
          }])),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !programmaticRef.current) {
              onChangeRef.current(update.state.doc.toString());
            }
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Created once; language/theme/wrap/scroll changes are dispatched below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: compartmentsRef.current.language.reconfigure(languageExtension(language)),
    });
  }, [language]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: compartmentsRef.current.theme.reconfigure(themeExtension(isDark)),
    });
  }, [isDark]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: compartmentsRef.current.wrap.reconfigure(wrapLines ? EditorView.lineWrapping : []),
    });
  }, [wrapLines]);

  // Reconcile an external value change (discard, reload after a disk conflict).
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    programmaticRef.current = true;
    view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
    programmaticRef.current = false;
  }, [value]);

  return <div className="file-editor-host" ref={hostRef} />;
}
