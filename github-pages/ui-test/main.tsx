import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { UiTrialApp } from "./UiTrialApp";
import "./ui-test.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <UiTrialApp />
  </StrictMode>,
);
