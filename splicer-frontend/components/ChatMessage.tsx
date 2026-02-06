import React, { useState, memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { motion, AnimatePresence } from "framer-motion";
import {
  ChevronDown,
  ChevronRight,
  Check,
  Loader2,
  AlertCircle,
  Copy,
  CheckCheck,
  Sparkles,
} from "lucide-react";
import { cn } from "../lib/utils";
import { StreamingMessage, ToolCall } from "../types";
import {
  MigrationStreamMessage,
  MigrationData,
} from "./MigrationStreamMessage";

interface ChatMessageProps {
  message: StreamingMessage;
  toolCalls?: ToolCall[];
  thinking?: string | null;
  isLastMessage?: boolean;
  migrationData?: MigrationData;
  /** Callback fired when migration content updates (for scroll management) */
  onContentUpdate?: () => void;
}

// Memoized code block component for performance
const CodeBlock = memo(
  ({ language, code }: { language: string; code: string }) => {
    const [copied, setCopied] = useState(false);

    const handleCopy = async () => {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    };

    return (
      <div className="relative group my-3 rounded-lg overflow-hidden">
        <div className="flex items-center justify-between px-4 py-2 bg-[#1e1e1e] border-b border-white/10">
          <span className="text-xs text-white/50 font-mono">
            {language || "code"}
          </span>
          <button
            onClick={handleCopy}
            className="text-white/40 hover:text-white/80 transition-colors p-1"
          >
            {copied ? (
              <CheckCheck className="w-4 h-4" />
            ) : (
              <Copy className="w-4 h-4" />
            )}
          </button>
        </div>
        <SyntaxHighlighter
          language={language || "text"}
          style={oneDark}
          customStyle={{
            margin: 0,
            borderRadius: 0,
            padding: "1rem",
            fontSize: "0.875rem",
            background: "#1a1a1a",
          }}
          wrapLongLines
        >
          {code}
        </SyntaxHighlighter>
      </div>
    );
  },
);

CodeBlock.displayName = "CodeBlock";

// Tool call pill component
const ToolCallPill = memo(({ tool }: { tool: ToolCall }) => {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="inline-flex flex-col">
      <button
        onClick={() => setExpanded(!expanded)}
        className={cn(
          "inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-mono",
          "bg-white/5 hover:bg-white/10 border border-white/10 transition-all",
          tool.state === "completed" && "border-emerald-500/30",
          tool.state === "error" && "border-red-500/30",
        )}
      >
        {tool.state === "pending" && (
          <Loader2 className="w-3 h-3 animate-spin text-amber-400" />
        )}
        {tool.state === "completed" && (
          <Check className="w-3 h-3 text-emerald-400" />
        )}
        {tool.state === "error" && (
          <AlertCircle className="w-3 h-3 text-red-400" />
        )}
        <span className="text-white/70">{tool.name}</span>
        <ChevronDown
          className={cn(
            "w-3 h-3 text-white/40 transition-transform",
            expanded && "rotate-180",
          )}
        />
      </button>

      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="mt-2 p-3 rounded-lg bg-black/40 border border-white/10 text-xs font-mono overflow-hidden"
          >
            {tool.args && (
              <div className="mb-2">
                <div className="text-white/40 mb-1">Arguments:</div>
                <pre className="text-white/70 whitespace-pre-wrap">
                  {JSON.stringify(tool.args, null, 2)}
                </pre>
              </div>
            )}
            {tool.result && (
              <div>
                <div className="text-white/40 mb-1">Result:</div>
                <pre className="text-white/70 whitespace-pre-wrap">
                  {tool.result}
                </pre>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});

ToolCallPill.displayName = "ToolCallPill";

// Thinking block component
const ThinkingBlock = memo(
  ({ content, isActive }: { content: string; isActive: boolean }) => {
    const [expanded, setExpanded] = useState(false);

    return (
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        className="mb-3"
      >
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-2 text-gray-400 hover:text-gray-300 transition-colors"
        >
          {expanded ? (
            <ChevronDown className="w-4 h-4" />
          ) : (
            <ChevronRight className="w-4 h-4" />
          )}
          <Sparkles className="w-3 h-3" />
          <span className="text-sm italic">
            {isActive ? (
              <span className="flex items-center gap-1">
                Thinking
                <span className="flex">
                  {[0, 1, 2].map((i) => (
                    <motion.span
                      key={i}
                      className="w-1 h-1 bg-gray-400 rounded-full mx-0.5"
                      animate={{ opacity: [0.3, 1, 0.3] }}
                      transition={{
                        duration: 1.2,
                        repeat: Infinity,
                        delay: i * 0.15,
                      }}
                    />
                  ))}
                </span>
              </span>
            ) : (
              "Thought process"
            )}
          </span>
        </button>

        <AnimatePresence>
          {expanded && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="overflow-hidden"
            >
              <div className="mt-2 pl-6 border-l-2 border-gray-600/50 text-sm text-gray-400 italic">
                {content}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    );
  },
);

ThinkingBlock.displayName = "ThinkingBlock";

// Node label badge
const NodeBadge = ({ node }: { node: string }) => (
  <div className="mb-2">
    <span className="text-[10px] font-medium uppercase tracking-wider text-white/30 bg-white/5 px-2 py-0.5 rounded">
      {node}
    </span>
  </div>
);

export const ChatMessage = memo(
  ({
    message,
    toolCalls,
    thinking,
    isLastMessage,
    migrationData,
    onContentUpdate,
  }: ChatMessageProps) => {
    const isHuman = message.role === "human";
    const isAssistant = message.role === "assistant";

    // For streaming/last message, use passed migrationData
    // For old messages, check if metadata contains saved migrationData
    const savedMigrationData = message.metadata?.migrationData as
      | MigrationData
      | undefined;

    // Prioritize savedMigrationData for historical messages (more complete)
    // Use live migrationData only during active streaming
    const effectiveMigrationData = savedMigrationData || migrationData;

    // Check if we should show formatted migration output
    // Show migration view when: message is marked as migration (immediate) OR has migration data with non-idle stage
    const isMigrationMessage = message.metadata?.isMigration === true;
    const hasMigrationData =
      effectiveMigrationData && effectiveMigrationData.stage !== "idle";
    const showMigrationView =
      isAssistant && (isMigrationMessage || hasMigrationData);

    // Default migration data for early streaming state (shows "Planning Migration..." loader)
    const displayMigrationData: MigrationData = effectiveMigrationData || {
      stage: "planning",
    };

    return (
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className={cn(
          "flex gap-3 px-4",
          isHuman ? "pt-4 pb-2 justify-end" : "py-4",
        )}
      >
        {/* Message content */}
        <div className={cn("flex flex-col w-full", isHuman && "items-end")}>
          {/* Thinking block - hidden during migration view */}
          {isAssistant && thinking && isLastMessage && !showMigrationView && (
            <ThinkingBlock
              content={thinking}
              isActive={message.isStreaming || false}
            />
          )}

          {/* Tool calls - hidden during migration view */}
          {isAssistant &&
            toolCalls &&
            toolCalls.length > 0 &&
            !showMigrationView && (
              <div className="flex flex-wrap gap-2 mb-3">
                {toolCalls.map((tool) => (
                  <ToolCallPill key={tool.id} tool={tool} />
                ))}
              </div>
            )}

          {/* Message bubble */}
          <div
            className={cn(
              "rounded-2xl px-4 py-3 will-change-transform",
              isHuman
                ? "bg-violet-600/20 border border-violet-500/30 text-white"
                : "bg-transparent text-white/90",
              message.isStreaming &&
                !showMigrationView &&
                "animate-pulse-subtle",
            )}
            style={{ willChange: "transform" }}
          >
            {showMigrationView ? (
              <MigrationStreamMessage
                data={displayMigrationData}
                instant={!message.isStreaming || !!savedMigrationData}
                onContentUpdate={onContentUpdate}
              />
            ) : isAssistant ? (
              <div className="prose prose-invert prose-sm max-w-none">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    code({ node, className, children, ...props }) {
                      const match = /language-(\w+)/.exec(className || "");
                      const isInline = !match && !className;

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

                      return (
                        <CodeBlock
                          language={match?.[1] || ""}
                          code={String(children).replace(/\n$/, "")}
                        />
                      );
                    },
                    p: ({ children }) => (
                      <p className="mb-3 last:mb-0 leading-relaxed">
                        {children}
                      </p>
                    ),
                    ul: ({ children }) => (
                      <ul className="list-disc pl-4 mb-3 space-y-1">
                        {children}
                      </ul>
                    ),
                    ol: ({ children }) => (
                      <ol className="list-decimal pl-4 mb-3 space-y-1">
                        {children}
                      </ol>
                    ),
                    li: ({ children }) => (
                      <li className="text-white/80">{children}</li>
                    ),
                    a: ({ href, children }) => (
                      <a
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-violet-400 hover:text-violet-300 underline underline-offset-2"
                      >
                        {children}
                      </a>
                    ),
                    blockquote: ({ children }) => (
                      <blockquote className="border-l-2 border-violet-500/50 pl-4 italic text-white/60 my-3">
                        {children}
                      </blockquote>
                    ),
                    h1: ({ children }) => (
                      <h1 className="text-xl font-bold mb-3 text-white">
                        {children}
                      </h1>
                    ),
                    h2: ({ children }) => (
                      <h2 className="text-lg font-semibold mb-2 text-white">
                        {children}
                      </h2>
                    ),
                    h3: ({ children }) => (
                      <h3 className="text-base font-medium mb-2 text-white">
                        {children}
                      </h3>
                    ),
                  }}
                >
                  {message.content}
                </ReactMarkdown>
              </div>
            ) : (
              <p className="whitespace-pre-wrap text-sm leading-relaxed">
                {message.content}
              </p>
            )}
          </div>
        </div>
      </motion.div>
    );
  },
);

ChatMessage.displayName = "ChatMessage";

// Typing indicator component
export const TypingIndicator = () => (
  <motion.div
    initial={{ opacity: 0, y: 10 }}
    animate={{ opacity: 1, y: 0 }}
    exit={{ opacity: 0, y: -10 }}
    className="flex gap-3 px-4 py-4"
  >
    <div className="flex items-center gap-1 px-4 py-3 w-full">
      {[0, 1, 2].map((i) => (
        <motion.div
          key={i}
          className="w-2 h-2 bg-violet-400/70 rounded-full"
          animate={{
            y: [0, -6, 0],
            opacity: [0.5, 1, 0.5],
          }}
          transition={{
            duration: 0.8,
            repeat: Infinity,
            delay: i * 0.15,
            ease: "easeInOut",
          }}
        />
      ))}
    </div>
  </motion.div>
);

// Message skeleton for loading history
export const MessageSkeleton = () => (
  <div className="flex gap-3 px-4 py-4">
    <div className="flex-1 space-y-2">
      <div className="h-4 bg-white/5 rounded animate-pulse w-3/4" />
      <div className="h-4 bg-white/5 rounded animate-pulse w-1/2" />
    </div>
  </div>
);
