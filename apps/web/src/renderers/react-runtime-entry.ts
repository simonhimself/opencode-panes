import * as React from "react";
import { createRoot } from "react-dom/client";

interface PanesRuntimeGlobal {
  __PANES_MOUNT__: (component: React.ElementType) => void;
  __PANES_REACT__: typeof React;
}

const runtime = globalThis as typeof globalThis & PanesRuntimeGlobal;

Object.defineProperty(runtime, "__PANES_REACT__", {
  configurable: false,
  value: Object.freeze({ ...React }),
  writable: false,
});

runtime.__PANES_MOUNT__ = (Component) => {
  const rootElement = document.getElementById("root");
  if (!rootElement) throw new Error("React artifact root was not found");

  const reportReactError = (error: unknown) => {
    queueMicrotask(() => {
      throw error;
    });
  };
  createRoot(rootElement, {
    onRecoverableError: reportReactError,
    onUncaughtError: reportReactError,
  }).render(React.createElement(Component));
};
