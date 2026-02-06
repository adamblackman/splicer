import React, { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { X, Copy, Check } from "lucide-react";
import mermaid from "mermaid";
import { SPLICER_INFO_MARKDOWN } from "../content/splicerInfo";

/* ─── Mermaid: one-time init (startOnLoad: false prevents auto-DOM scanning) ── */
mermaid.initialize({
  startOnLoad: false,
  theme: "dark",
  themeVariables: {
    primaryColor: "#7c3aed",
    primaryTextColor: "#f5f3ff",
    primaryBorderColor: "#6d28d9",
    lineColor: "#6d28d9",
    secondaryColor: "#1e1b4b",
    tertiaryColor: "#0d0d0f",
    background: "#0d0d0f",
    mainBkg: "#1a1a2e",
    nodeBorder: "#6d28d9",
    clusterBkg: "#1a1a2e",
    titleColor: "#e9d5ff",
    edgeLabelBackground: "#0d0d0f",
    fontFamily: "ui-sans-serif, system-ui, sans-serif",
  },
});

/* ─── Unique id counter (module-level, survives re-renders) ─── */
let mermaidIdCounter = 0;

/**
 * Renders a mermaid diagram to SVG exactly once for a given `code` string.
 * Wrapped in React.memo so parent state changes (e.g. scroll position) never
 * cause re-renders or layout shifts ("shaking").
 */
const MermaidDiagram = React.memo(function MermaidDiagram({
  code,
}: {
  code: string;
}) {
  const [svg, setSvg] = useState<string>("");
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    const id = `mermaid-svg-${++mermaidIdCounter}`;

    (async () => {
      try {
        const { svg: svgCode } = await mermaid.render(id, code);
        if (!cancelled) setSvg(svgCode);
      } catch (err) {
        console.error("Mermaid render error:", err);
        // mermaid may leave an orphaned element in the DOM on failure
        document.getElementById(id)?.remove();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [code]);

  if (!svg) {
    return (
      <div className="my-4 rounded-xl border border-white/10 bg-[#0d0d0f] p-8 flex items-center justify-center">
        <span className="text-white/40 text-sm">Rendering diagram…</span>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="my-4 rounded-xl border border-white/10 bg-[#0d0d0f] p-4 overflow-x-auto
        [&_svg]:mx-auto [&_svg]:block [&_svg]:max-w-full [&_svg]:h-auto"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
});

export interface SplicerInfoModalProps {
  isOpen: boolean;
  onClose: () => void;
}

function InfoCodeBlock({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard API failed, ignore
    }
  };

  return (
    <div className="my-4 rounded-xl overflow-hidden border border-white/10 bg-[#0d0d0f]">
      <div className="px-4 py-2 border-b border-white/10 flex items-center justify-between gap-2">
        <span className="text-xs font-mono text-violet-400/80">
          {language || "text"}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          className="flex items-center gap-1.5 px-2 py-1 rounded text-xs text-white/60 hover:text-white hover:bg-white/10 transition-colors"
          aria-label={copied ? "Copied!" : "Copy code"}
        >
          {copied ? (
            <>
              <Check className="w-3.5 h-3.5" />
              <span>Copied</span>
            </>
          ) : (
            <>
              <Copy className="w-3.5 h-3.5" />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>
      <SyntaxHighlighter
        language={language}
        style={oneDark}
        customStyle={{
          margin: 0,
          borderRadius: 0,
          background: "transparent",
          fontSize: "0.8125rem",
          padding: "1rem 1.25rem",
        }}
        codeTagProps={{ style: { fontFamily: "ui-monospace, monospace" } }}
        showLineNumbers={false}
        PreTag="div"
      >
        {code.replace(/\n$/, "")}
      </SyntaxHighlighter>
    </div>
  );
}

export const SplicerInfoModal: React.FC<SplicerInfoModalProps> = ({
  isOpen,
  onClose,
}) => {
  /* Use a ref instead of state for scroll-shadow so scrolling never triggers
     a React re-render (which would rebuild the entire markdown tree). */
  const headerRef = useRef<HTMLDivElement>(null);

  /* Lock body scroll when modal is open and compensate scrollbar width so the
     header (fixed) doesn’t shift when overflow changes. */
  useEffect(() => {
    if (!isOpen) return;
    const scrollbarWidth =
      window.innerWidth - document.documentElement.clientWidth;
    const prevOverflow = document.body.style.overflow;
    const prevPaddingRight = document.body.style.paddingRight;
    document.body.style.overflow = "hidden";
    document.body.style.paddingRight = `${scrollbarWidth}px`;
    return () => {
      document.body.style.overflow = prevOverflow;
      document.body.style.paddingRight = prevPaddingRight;
    };
  }, [isOpen]);

  const handleBodyScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const isScrolled = (e.target as HTMLDivElement).scrollTop > 8;
    const el = headerRef.current;
    if (!el) return;
    el.classList.toggle("shadow-lg", isScrolled);
    el.classList.toggle("shadow-black/20", isScrolled);
  };

  const modalContent = (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/80 z-[10000]"
          />
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-[10000] pointer-events-none flex flex-col sm:items-center sm:justify-center"
            style={{
              paddingTop: "max(1rem, env(safe-area-inset-top, 0px))",
              paddingBottom: "max(1rem, env(safe-area-inset-bottom, 0px))",
              paddingLeft: "max(1rem, env(safe-area-inset-left, 0px))",
              paddingRight: "max(1rem, env(safe-area-inset-right, 0px))",
            }}
          >
            <div
              className="w-full max-w-4xl flex flex-col bg-[#0F0F11] border border-white/10 rounded-2xl shadow-2xl pointer-events-auto overflow-hidden flex-1 min-h-0 sm:flex-initial sm:min-h-0 sm:max-h-[88vh]"
              style={{
                maxHeight: "calc(min(100dvh, 100vh) - 2rem)",
              }}
              onClick={(e) => e.stopPropagation()}
            >
              {/* Header - always visible, never scrolls */}
              <div
                ref={headerRef}
                className="flex items-center justify-between flex-none px-4 sm:px-6 py-3 sm:py-4 border-b border-white/10 transition-shadow"
              >
                <h2 className="text-lg font-semibold text-white truncate pr-2">
                  Splicer – Code Migration Agent
                </h2>
                <button
                  type="button"
                  onClick={onClose}
                  className="flex items-center justify-center min-w-[44px] min-h-[44px] -mr-2 rounded-lg text-white/50 hover:text-white hover:bg-white/10 active:bg-white/15 transition-colors touch-manipulation"
                  aria-label="Close"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Scrollable body - flex-1 min-h-0 so it shrinks and scrolls */}
              <div
                className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent"
                onScroll={handleBodyScroll}
              >
                <div className="px-6 pt-3 pb-8">
                  <article className="prose prose-invert prose-sm max-w-none">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={{
                        code({ node, className, children, ...props }) {
                          const match = /language-(\w+)/.exec(className || "");
                          const isInline = !match && !className;
                          const code = String(children).replace(/\n$/, "");

                          if (isInline) {
                            return (
                              <code
                                className="px-1.5 py-0.5 rounded bg-white/10 text-violet-300 text-sm font-mono"
                                {...props}
                              >
                                {children}
                              </code>
                            );
                          }

                          const lang = match?.[1] || "text";

                          if (lang === "mermaid") {
                            return <MermaidDiagram code={code} />;
                          }

                          return (
                            <InfoCodeBlock language={lang} code={code} />
                          );
                        },
                        h1: ({ children }) => (
                          <h1 className="text-xl font-bold text-white mb-4 mt-0">
                            {children}
                          </h1>
                        ),
                        h2: ({ children }) => (
                          <h2 className="text-base font-semibold text-white mt-4 mb-3 pb-1 border-b border-white/10 first:mt-0">
                            {children}
                          </h2>
                        ),
                        h3: ({ children }) => (
                          <h3 className="text-sm font-medium text-white/90 mt-4 mb-2">
                            {children}
                          </h3>
                        ),
                        p: ({ children }) => (
                          <p className="text-white/70 text-sm leading-relaxed mb-3 last:mb-0">
                            {children}
                          </p>
                        ),
                        ul: ({ children }) => (
                          <ul className="list-disc pl-5 mb-3 space-y-1.5 text-white/70 text-sm">
                            {children}
                          </ul>
                        ),
                        ol: ({ children }) => (
                          <ol className="list-decimal pl-5 mb-3 space-y-1.5 text-white/70 text-sm">
                            {children}
                          </ol>
                        ),
                        li: ({ children }) => (
                          <li className="leading-relaxed">{children}</li>
                        ),
                        strong: ({ children }) => (
                          <strong className="font-semibold text-white/90">
                            {children}
                          </strong>
                        ),
                        hr: () => <hr className="border-white/10 my-6" />,
                        table: ({ children }) => (
                          <div className="my-4 rounded-xl border border-white/10 overflow-hidden">
                            <table className="w-full text-sm border-collapse">
                              {children}
                            </table>
                          </div>
                        ),
                        thead: ({ children }) => (
                          <thead className="bg-white/5">{children}</thead>
                        ),
                        th: ({ children }) => (
                          <th className="text-left px-4 py-3 font-medium text-violet-300 border-b border-white/10">
                            {children}
                          </th>
                        ),
                        tbody: ({ children }) => (
                          <tbody className="divide-y divide-white/10">
                            {children}
                          </tbody>
                        ),
                        tr: ({ children }) => (
                          <tr className="hover:bg-white/[0.02] transition-colors">
                            {children}
                          </tr>
                        ),
                        td: ({ children }) => (
                          <td className="px-4 py-3 text-white/70">
                            {children}
                          </td>
                        ),
                      }}
                    >
                      {SPLICER_INFO_MARKDOWN}
                    </ReactMarkdown>
                  </article>
                </div>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );

  if (typeof document === "undefined") return null;
  return createPortal(modalContent, document.body);
};
