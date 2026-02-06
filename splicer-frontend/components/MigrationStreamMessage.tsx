import React, { useMemo, useState, useEffect, useCallback } from "react";
import { motion } from "framer-motion";
import ReactMarkdown from "react-markdown";
import ShinyText from "./ShinyText";
import { useTypingAnimation } from "../hooks/useTypingAnimation";

/** Structured data from the migration stream */
export interface MigrationData {
  stage: MigrationStage;
  planner?: PlannerData;
  source?: SourceData;
  target?: TargetData;
  paster?: PasterData;
  integrator?: IntegratorData;
  checker?: CheckerData;
}

export type MigrationStage =
  | "idle"
  | "planning"
  | "analyzing"
  | "pasting"
  | "integrating"
  | "checking"
  | "cleanup"
  | "complete";

export interface PlannerData {
  source_exploration: string[];
  target_exploration: string[];
  integration_instructions?: string;
  end_goal: string;
}

export interface SourceData {
  summary: string[];
  /** Metadata can be an object or a string representation from the backend */
  metadata: Record<string, unknown> | string;
  paths: string[];
}

export interface TargetData {
  summary: string[];
  /** Metadata can be an object or a string representation from the backend */
  metadata?: Record<string, unknown> | string;
  integration_instructions: string[];
}

export interface PasterData {
  pasted_files: Array<{
    path: string;
    type: string;
    original_source_path: string;
  }>;
}

export interface IntegratorData {
  integration_summary: string;
}

export interface CheckerData {
  errors: string[];
  passed: boolean;
}

interface MigrationStreamMessageProps {
  data: MigrationData;
  /** If true, show all content instantly without typing animation (for old messages) */
  instant?: boolean;
  /** Callback fired when content updates (e.g., during typing animation) for scroll management */
  onContentUpdate?: () => void;
}

/** Individual stage section with typing animation and markdown rendering */
const TypedSection: React.FC<{
  content: string;
  speed?: number;
  onComplete?: () => void;
  instant?: boolean;
  onUpdate?: () => void;
}> = ({ content, speed = 250, onComplete, instant = false, onUpdate }) => {
  const { displayedText, isTyping } = useTypingAnimation(content, {
    speed,
    autoStart: !instant,
    onComplete: instant ? undefined : onComplete,
  });
  
  // For instant mode, call onComplete immediately
  useEffect(() => {
    if (instant && onComplete) {
      onComplete();
    }
  }, [instant, onComplete]);
  
  // Call onUpdate whenever displayed text changes during typing
  useEffect(() => {
    if (!instant && isTyping && onUpdate) {
      onUpdate();
    }
  }, [displayedText, instant, isTyping, onUpdate]);
  
  const textToShow = instant ? content : displayedText;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="text-white/90 text-sm leading-relaxed prose prose-invert prose-sm max-w-none"
    >
      <ReactMarkdown
        components={{
          p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
          ul: ({ children }) => (
            <ul className="list-disc pl-4 mb-2 space-y-0.5">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="list-decimal pl-4 mb-2 space-y-0.5">{children}</ol>
          ),
          li: ({ children }) => <li className="text-white/80">{children}</li>,
          strong: ({ children }) => (
            <strong className="text-white font-semibold">{children}</strong>
          ),
          code: ({ children }) => (
            <code className="px-1 py-0.5 rounded bg-white/10 text-violet-300 text-xs font-mono">
              {children}
            </code>
          ),
        }}
      >
        {textToShow}
      </ReactMarkdown>
    </motion.div>
  );
};

/** Loading indicator with ShinyText */
const StageLoader: React.FC<{ text: string }> = ({ text }) => (
  <motion.div
    initial={{ opacity: 0, y: 5 }}
    animate={{ opacity: 1, y: 0 }}
    exit={{ opacity: 0, y: -5 }}
    className="py-2"
  >
    <ShinyText
      text={text}
      speed={1}
      delay={0.2}
      color="#696969"
      shineColor="#ffffff"
      spread={100}
      direction="left"
      className="text-sm font-medium"
    />
  </motion.div>
);

/** Format planner output */
function formatPlannerContent(planner: PlannerData): string {
  const lines: string[] = [];

  // Defensively handle arrays that might not be arrays
  const sourceExploration = Array.isArray(planner.source_exploration) ? planner.source_exploration : [];
  const targetExploration = Array.isArray(planner.target_exploration) ? planner.target_exploration : [];

  if (sourceExploration.length > 0) {
    if (sourceExploration.length === 1) {
      lines.push(`**Source:** ${sourceExploration[0]}`);
    } else {
      lines.push("**Source:**");
      sourceExploration.forEach((item) => {
        lines.push(`- ${item}`);
      });
    }
  }

  if (targetExploration.length > 0) {
    lines.push("");
    if (targetExploration.length === 1) {
      lines.push(`**Target:** ${targetExploration[0]}`);
    } else {
      lines.push("**Target:**");
      targetExploration.forEach((item) => {
        lines.push(`- ${item}`);
      });
    }
  }

  if (planner.integration_instructions) {
    lines.push("");
    lines.push(
      `**Integration Instructions:** ${planner.integration_instructions}`,
    );
  }

  if (planner.end_goal) {
    lines.push("");
    lines.push(`**Goal:** ${planner.end_goal}`);
  }

  return lines.join("\n");
}

/** Format source and target analysis output */
function formatAnalysisContent(
  source?: SourceData,
  target?: TargetData,
): string {
  const lines: string[] = [];

  if (source) {
    // Source summary
    const summary = Array.isArray(source.summary) ? source.summary : [];
    summary.forEach((item) => {
      lines.push(item);
    });

    // Source metadata - handle both object and string formats
    if (source.metadata) {
      const metaParts: string[] = [];
      
      if (typeof source.metadata === 'string') {
        // Parse string metadata format: "framework='React + Vite' styling='Tailwind CSS'"
        const metaStr = source.metadata;
        const frameworkMatch = metaStr.match(/framework='([^']+)'/);
        const stylingMatch = metaStr.match(/styling='([^']+)'/);
        const typescriptMatch = metaStr.match(/typescript=(True|False)/i);
        
        if (frameworkMatch) metaParts.push(`Framework: ${frameworkMatch[1]}`);
        if (stylingMatch) metaParts.push(`Styling: ${stylingMatch[1]}`);
        if (typescriptMatch) metaParts.push(`TypeScript: ${typescriptMatch[1].toLowerCase() === 'true' ? 'Yes' : 'No'}`);
      } else if (typeof source.metadata === 'object' && Object.keys(source.metadata).length > 0) {
        // Object format
        const meta = source.metadata as Record<string, unknown>;
        if (meta.framework)
          metaParts.push(`Framework: ${meta.framework}`);
        if (meta.styling)
          metaParts.push(`Styling: ${meta.styling}`);
        if (meta.typescript !== undefined)
          metaParts.push(
            `TypeScript: ${meta.typescript ? "Yes" : "No"}`,
          );
      }
      
      if (metaParts.length > 0) {
        lines.push(`- **Metadata:** ${metaParts.join(", ")}`);
      }
    }

    // Copied files (just paths)
    const paths = Array.isArray(source.paths) ? source.paths : [];
    if (paths.length > 0) {
      lines.push("- **Copied Files:**");
      lines.push(""); // Empty line before list
      paths.forEach((path) => {
        lines.push(`  - ${path}`);
      });
    }
  }

  if (target) {
    if (lines.length > 0) lines.push("");

    // Target summary
    const summary = Array.isArray(target.summary) ? target.summary : [];
    summary.forEach((item) => {
      lines.push(item);
    });

    // Target integration instructions as numbered list
    const instructions = Array.isArray(target.integration_instructions) ? target.integration_instructions : [];
    if (instructions.length > 0) {
      lines.push("");
      instructions.forEach((instruction, i) => {
        lines.push(`${i + 1}. ${instruction}`);
      });
    }
  }

  return lines.join("\n");
}

/** Format pasted files output */
function formatPasterContent(paster: PasterData): string {
  const lines: string[] = ["**Pasted Files:**"];
  const pastedFiles = Array.isArray(paster.pasted_files) ? paster.pasted_files : [];
  if (pastedFiles.length > 0) {
    lines.push(""); // Empty line before list
    pastedFiles.forEach((file) => {
      const path = typeof file === 'string' ? file : file?.path || 'unknown';
      lines.push(`- ${path}`);
    });
  }
  return lines.join("\n");
}

/** Format checker output */
function formatCheckerContent(checker: CheckerData): string {
  const errors = Array.isArray(checker.errors) ? checker.errors : [];
  if (checker.passed || errors.length === 0) {
    return "No Errors.";
  }
  return errors.map((err) => `• ${err}`).join("\n");
}

export const MigrationStreamMessage: React.FC<MigrationStreamMessageProps> = ({
  data,
  instant = false,
  onContentUpdate,
}) => {
  const { stage, planner, source, target, paster, integrator, checker } = data;

  // Track which sections have completed typing (always true if instant mode)
  const [plannerTypingDone, setPlannerTypingDone] = useState(instant);
  const [analysisTypingDone, setAnalysisTypingDone] = useState(instant);
  const [pasterTypingDone, setPasterTypingDone] = useState(instant);
  const [integratorTypingDone, setIntegratorTypingDone] = useState(instant);
  const [checkerTypingDone, setCheckerTypingDone] = useState(instant);

  // Reset typing state when content changes (only during streaming, not for instant/historical messages)
  useEffect(() => {
    if (!instant && planner) setPlannerTypingDone(false);
  }, [planner, instant]);
  useEffect(() => {
    if (!instant && source && target) setAnalysisTypingDone(false);
  }, [source, target, instant]);
  useEffect(() => {
    if (!instant && paster) setPasterTypingDone(false);
  }, [paster, instant]);
  useEffect(() => {
    if (!instant && integrator) setIntegratorTypingDone(false);
  }, [integrator, instant]);
  useEffect(() => {
    if (!instant && checker) setCheckerTypingDone(false);
  }, [checker, instant]);

  // Callbacks for typing completion
  const onPlannerComplete = useCallback(() => setPlannerTypingDone(true), []);
  const onAnalysisComplete = useCallback(() => setAnalysisTypingDone(true), []);
  const onPasterComplete = useCallback(() => setPasterTypingDone(true), []);
  const onIntegratorComplete = useCallback(() => setIntegratorTypingDone(true), []);
  const onCheckerComplete = useCallback(() => setCheckerTypingDone(true), []);

  // Determine what to show based on current stage and typing completion
  // For instant/historical messages, skip loaders and show all available content
  const showPlannerLoader = !instant && stage === "planning" && !planner;
  const showPlannerContent = !!planner;

  // Show analyzing loader only after planner typing is done (skip for instant)
  const showAnalyzingLoader =
    !instant &&
    showPlannerContent &&
    plannerTypingDone &&
    (stage === "planning" || stage === "analyzing") &&
    (!source || !target);
  const showAnalyzingContent = !!source && !!target;

  // Show paster loader only after analysis typing is done (skip for instant)
  const showPasterLoader =
    !instant &&
    showAnalyzingContent &&
    analysisTypingDone &&
    !paster &&
    (stage === "analyzing" || stage === "pasting");
  const showPasterContent = !!paster;

  // Show integrator loader only after paster typing is done (skip for instant)
  const showIntegratorLoader =
    !instant &&
    showPasterContent &&
    pasterTypingDone &&
    !integrator &&
    (stage === "pasting" || stage === "integrating");
  const showIntegratorContent = !!integrator;

  // Show checker loader only after integrator typing is done (skip for instant)
  const showCheckerLoader =
    !instant &&
    showIntegratorContent &&
    integratorTypingDone &&
    !checker &&
    (stage === "integrating" || stage === "checking");
  const showCheckerContent = !!checker;

  // Show cleanup loader only after checker typing is done (skip for instant)
  const showCleanupLoader = !instant && showCheckerContent && checkerTypingDone && stage === "cleanup";
  const showCleanupContent = stage === "complete" && planner;

  // Memoize formatted content
  const plannerContent = useMemo(
    () => (planner ? formatPlannerContent(planner) : ""),
    [planner],
  );

  const analysisContent = useMemo(
    () => formatAnalysisContent(source, target),
    [source, target],
  );

  const pasterContent = useMemo(
    () => (paster ? formatPasterContent(paster) : ""),
    [paster],
  );

  const checkerContent = useMemo(
    () => (checker ? formatCheckerContent(checker) : ""),
    [checker],
  );

  return (
    <div className="space-y-4">
      {/* Planning Stage */}
      {showPlannerLoader && <StageLoader text="Planning Migration..." />}
      {showPlannerContent && (
        <TypedSection content={plannerContent} onComplete={onPlannerComplete} instant={instant} onUpdate={onContentUpdate} />
      )}

      {/* Analyzing Stage */}
      {showAnalyzingLoader && (
        <StageLoader text="Analyzing Source and Target Repositories..." />
      )}
      {showAnalyzingContent && (
        <TypedSection content={analysisContent} onComplete={onAnalysisComplete} instant={instant} onUpdate={onContentUpdate} />
      )}

      {/* Pasting Stage */}
      {showPasterLoader && <StageLoader text="Pasting Files..." />}
      {showPasterContent && (
        <TypedSection content={pasterContent} onComplete={onPasterComplete} instant={instant} onUpdate={onContentUpdate} />
      )}

      {/* Integrating Stage */}
      {showIntegratorLoader && <StageLoader text="Integrating Code..." />}
      {showIntegratorContent && integrator && (
        <TypedSection content={integrator.integration_summary || ''} onComplete={onIntegratorComplete} instant={instant} onUpdate={onContentUpdate} />
      )}

      {/* Checking Stage */}
      {showCheckerLoader && <StageLoader text="Checking for Errors..." />}
      {showCheckerContent && (
        <TypedSection content={checkerContent} onComplete={onCheckerComplete} instant={instant} onUpdate={onContentUpdate} />
      )}

      {/* Cleanup Stage */}
      {showCleanupLoader && <StageLoader text="Cleaning Up..." />}
      {showCleanupContent && planner && (
        <TypedSection content={planner.end_goal} instant={instant} onUpdate={onContentUpdate} />
      )}
    </div>
  );
};

export default MigrationStreamMessage;
