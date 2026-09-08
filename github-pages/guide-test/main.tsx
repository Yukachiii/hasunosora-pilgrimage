import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { GuideTestPage } from "./GuideTestPage";
import "./guide-test.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <GuideTestPage />
  </StrictMode>,
);
