import { useState, useEffect, useRef } from 'react';

interface UseTypingAnimationOptions {
  /** Characters per second (default: 60 - fast but readable) */
  speed?: number;
  /** Whether to start typing immediately (default: true) */
  autoStart?: boolean;
  /** Callback when typing completes */
  onComplete?: () => void;
}

/**
 * Hook that provides a typing animation effect for text.
 * Returns the portion of text that should be displayed.
 */
export function useTypingAnimation(
  text: string,
  options: UseTypingAnimationOptions = {}
): { displayedText: string; isTyping: boolean; isComplete: boolean } {
  const { speed = 60, autoStart = true, onComplete } = options;
  const [displayedLength, setDisplayedLength] = useState(autoStart ? 0 : text.length);
  const [isTyping, setIsTyping] = useState(autoStart && text.length > 0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const onCompleteRef = useRef(onComplete);

  // Keep onComplete ref updated
  onCompleteRef.current = onComplete;

  useEffect(() => {
    if (!autoStart) {
      setDisplayedLength(text.length);
      return;
    }

    // If text grows, continue typing from current position
    if (displayedLength < text.length) {
      setIsTyping(true);
      const msPerChar = 1000 / speed;

      intervalRef.current = setInterval(() => {
        setDisplayedLength(prev => {
          const next = prev + 1;
          if (next >= text.length) {
            if (intervalRef.current) {
              clearInterval(intervalRef.current);
              intervalRef.current = null;
            }
            setIsTyping(false);
            onCompleteRef.current?.();
            return text.length;
          }
          return next;
        });
      }, msPerChar);

      return () => {
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
      };
    } else {
      setIsTyping(false);
    }
  }, [text, speed, autoStart, displayedLength]);

  // Reset when text changes completely (new content)
  const prevTextRef = useRef(text);
  useEffect(() => {
    // If the new text doesn't start with the old text, it's new content
    if (!text.startsWith(prevTextRef.current.slice(0, displayedLength))) {
      setDisplayedLength(0);
      setIsTyping(true);
    }
    prevTextRef.current = text;
  }, [text, displayedLength]);

  return {
    displayedText: text.slice(0, displayedLength),
    isTyping,
    isComplete: displayedLength >= text.length,
  };
}
