"use client";

import { createContext, memo, useContext, useEffect, useMemo, useRef, useState, type ComponentProps, type MouseEvent } from "react";
import ReactMarkdown, { type Components, type ExtraProps } from "react-markdown";
import { parsePdfPageFragment, resolveLocalFileHref, shouldOpenLocalFileInApp } from "@/lib/file-links";
import { encodeFilePathForApi } from "@/lib/file-paths";
import { markdownRehypePlugins, markdownRemarkPlugins, markdownUrlTransform, markdownUserRemarkPlugins, normalizeDisplayMath } from "@/lib/markdown";
import { ImagePreview } from "./ImagePreview";
import { MermaidBlock, CodeBlock } from "./MermaidBlock";
import { HtmlPreviewBlock } from "./HtmlPreviewBlock";
import { htmlPreviewKind } from "@/lib/html-preview";
import { ArtifactCard } from "./ArtifactCard";
import { ARTIFACT_FENCE_LANG, decodeArtifactFence, encodeArtifactsForMarkdown } from "@/lib/artifacts";
import { useFileContextMenu } from "@/hooks/useFileContextMenu";
import { inlineCodeFilePath } from "@/lib/file-context-menu";
import { handleExternalLinkClick } from "@/lib/desktop-native";

const MarkdownLinkContext = createContext(false);

interface MarkdownBodyProps {
  children: string;
  className?: string;
  isStreaming?: boolean;
  cwd?: string;
  onOpenFile?: (filePath: string, page?: number) => void;
  /** Render every line ending as a line break, for text the user typed. */
  keepLineBreaks?: boolean;
  /** Render `:::artifact{...}` blocks as artifact cards (assistant text only). */
  artifacts?: boolean;
}

function MarkdownImage({
  src,
  alt,
  cwd,
  ...props
}: ComponentProps<"img"> & ExtraProps & { cwd?: string }) {
  const insideLink = useContext(MarkdownLinkContext);
  delete props.node;
  const href = typeof src === "string" ? src : undefined;
  const filePath = href ? resolveLocalFileHref(href, cwd) : null;
  const imageSrc = filePath
    ? `/api/files/${encodeFilePathForApi(filePath)}?type=read`
    : href;
  // Dynamic local paths are served directly by the file API.
  // eslint-disable-next-line @next/next/no-img-element
  const image = <img src={imageSrc} alt={alt ?? ""} loading="lazy" {...props} />;
  if (!imageSrc || insideLink) return image;
  return (
    <ImagePreview src={imageSrc} alt={alt ?? ""} className="markdown-image">
      {image}
    </ImagePreview>
  );
}

function buildComponents(
  isStreaming: boolean | undefined,
  cwd: string | undefined,
  onOpenFile: ((filePath: string, page?: number) => void) | undefined,
): Components {
  return {
    code({ className, children, ...props }) {
      const lang = className?.replace("language-", "").toLowerCase() ?? "";
      const raw = String(children);
      const isBlock = className?.includes("language-") || raw.includes("\n");
      if (isBlock) {
        if (lang === ARTIFACT_FENCE_LANG) {
          const artifact = decodeArtifactFence(raw);
          if (artifact) return <ArtifactCard block={artifact} isStreaming={isStreaming} />;
        }
        if (lang === "mermaid") {
          return (
            <MermaidBlock
              code={raw.replace(/\n$/, "")}
              isStreaming={isStreaming}
              defaultPreview
            />
          );
        }
        // A complete HTML document, an SVG image or a self-contained React
        // component renders instead of showing as code; a fragment stays code.
        const previewKind = htmlPreviewKind(lang, raw);
        if (previewKind) {
          return (
            <HtmlPreviewBlock
              code={raw.replace(/\n$/, "")}
              lang={lang}
              kind={previewKind}
              isStreaming={isStreaming}
              defaultPreview={previewKind !== "react"}
            />
          );
        }
        return <CodeBlock code={raw.replace(/\n$/, "")} lang={lang} isStreaming={isStreaming} />;
      }
      return (
        <code
          className="markdown-inline-code"
          {...props}
        >
          {children}
        </code>
      );
    },
    pre({ children }) {
      return <>{children}</>;
    },
    a({ href, children, ...props }) {
      // `node` is react-markdown metadata, not a DOM attribute.
      delete props.node;
      const filePath = onOpenFile ? resolveLocalFileHref(href, cwd) : null;
      const openFile = onOpenFile;
      if (!filePath || !openFile) {
        return (
          <MarkdownLinkContext.Provider value={true}>
            <a
              href={href}
              {...props}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(event) => handleExternalLinkClick(event, href)}
            >
              {children}
            </a>
          </MarkdownLinkContext.Provider>
        );
      }

      const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
        if (!shouldOpenLocalFileInApp(event)) return;
        const target = event.currentTarget.getAttribute("target");
        if (target && target !== "_self") return;
        event.preventDefault();
        openFile(filePath, parsePdfPageFragment(href) ?? undefined);
      };

      return (
        <MarkdownLinkContext.Provider value={true}>
          <a href={href} {...props} onClick={handleClick}>
            {children}
          </a>
        </MarkdownLinkContext.Provider>
      );
    },
    img(props) {
      return <MarkdownImage cwd={cwd} {...props} />;
    },
    ol({ node, start, style, ...props }) {
      // An outside marker wider than the list's left padding is clipped by
      // .markdown-body's overflow-x, so the padding follows the largest number.
      const items = node?.children.filter((child) => child.type === "element" && child.tagName === "li").length ?? 0;
      const digits = String(Math.abs((start ?? 1) + Math.max(items, 1) - 1)).length;
      return <ol start={start} style={{ ...style, ["--ol-marker-digits" as string]: Math.max(digits, 2) }} {...props} />;
    },
    table({ children }) {
      return (
        <div className="markdown-table-wrap">
          <table>{children}</table>
        </div>
      );
    },
  };
}

// A streaming bubble receives a new string on every text delta, and each one
// re-runs remark/rehype/KaTeX over the whole accumulated answer — quadratic in
// the answer's length. Parse at most once per interval while streaming; the
// final text renders as soon as streaming ends.
export const STREAMING_MARKDOWN_INTERVAL_MS = 120;

function useStreamingThrottle(value: string, active: boolean): string {
  const [shown, setShown] = useState(value);
  const lastShownAtRef = useRef(0);
  useEffect(() => {
    if (!active) return;
    const publish = () => {
      lastShownAtRef.current = Date.now();
      setShown(value);
    };
    const wait = lastShownAtRef.current + STREAMING_MARKDOWN_INTERVAL_MS - Date.now();
    if (wait <= 0) {
      publish();
      return;
    }
    // Trailing edge: the latest text still lands once the interval elapses.
    const timer = setTimeout(publish, wait);
    return () => clearTimeout(timer);
  }, [value, active]);
  return active ? shown : value;
}

// Memoized: markdown parsing + highlighting is the most expensive render work
// in the app, so parent re-renders with identical props must be free.
export const MarkdownBody = memo(function MarkdownBody({ children, className, isStreaming, cwd, onOpenFile, keepLineBreaks, artifacts }: MarkdownBodyProps) {
  const fileContextMenu = useFileContextMenu(onOpenFile);
  const markdown = useStreamingThrottle(children, Boolean(isStreaming));
  const normalizedMarkdown = useMemo(
    () => normalizeDisplayMath(artifacts ? encodeArtifactsForMarkdown(markdown) : markdown),
    [markdown, artifacts],
  );
  const components = useMemo(
    () => buildComponents(isStreaming, cwd, onOpenFile),
    [isStreaming, cwd, onOpenFile],
  );
  // ReactMarkdown is not memoized itself; reusing the element lets the
  // throttled re-renders (text unchanged) skip parsing entirely.
  const body = useMemo(() => (
    <ReactMarkdown
      remarkPlugins={keepLineBreaks ? markdownUserRemarkPlugins : markdownRemarkPlugins}
      rehypePlugins={markdownRehypePlugins}
      urlTransform={onOpenFile ? markdownUrlTransform : undefined}
      components={components}
    >
      {normalizedMarkdown}
    </ReactMarkdown>
  ), [normalizedMarkdown, components, onOpenFile, keepLineBreaks]);

  return (
    <div className={['markdown-body', className].filter(Boolean).join(' ')} onContextMenu={(event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const link = target.closest('a');
      const code = target.closest('code');
      const href = link?.getAttribute('href') ?? undefined;
      const filePath = link ? resolveLocalFileHref(href, cwd)
        : code && !code.closest('pre') ? inlineCodeFilePath(code.textContent ?? '', cwd) : null;
      if (filePath) fileContextMenu(event, { filePath, page: parsePdfPageFragment(href) ?? undefined, verify: true });
    }}>
      {body}
    </div>
  );
});
