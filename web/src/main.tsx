import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

// 抑制 Three.js 舊版語法與 R3F 產生的大量 console 警告
const originalWarn = console.warn;
console.warn = (...args) => {
  const msg = args.join(" ");
  if (msg.includes("THREE.WebGLShadowMap: PCFSoftShadowMap has been deprecated")) return;
  if (msg.includes("THREE.Clock: This module has been deprecated")) return;
  originalWarn(...args);
};

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
