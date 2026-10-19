import { useState, useEffect, useCallback, useRef } from "react";

export type MessageType = "loading" | "success" | "error";

export interface FlashMessage {
  text: string;
  type: MessageType;
}

const AUTO_DISMISS_MS = 3000;

export function useFlashMessage() {
  const [message, setMessageState] = useState<FlashMessage | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearMessage = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setMessageState(null);
  }, []);

  const setMessage = useCallback((text: string, type: MessageType) => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    setMessageState({ text, type });

    if (type === "success") {
      timerRef.current = setTimeout(() => {
        setMessageState(null);
        timerRef.current = null;
      }, AUTO_DISMISS_MS);
    }
  }, []);

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  return { message, setMessage, clearMessage };
}
