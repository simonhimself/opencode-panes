import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import "./app.css";
import { captureWorkspaceAccess, parseViewerRoute } from "./viewer";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Root element not found");
}

const route = parseViewerRoute(window.location.pathname);
const workspaceAccess =
  route.kind === "artifact"
    ? captureWorkspaceAccess(
        route.artifactId,
        window.location,
        window.history,
        window.sessionStorage,
      )
    : undefined;

createRoot(rootElement).render(
  <StrictMode>
    {workspaceAccess ? (
      <App route={route} workspaceAccess={workspaceAccess} />
    ) : (
      <App route={route} />
    )}
  </StrictMode>,
);
